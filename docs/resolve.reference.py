"""
Resolution pipeline: utterance -> log_entry.

The contract:
  - The utterance is written FIRST, unconditionally. Nothing below can lose it.
  - Food identity must be unambiguous before anything reaches log_entry.
  - Quantity may be absent. That is 'pending_quantity', not ambiguity.
  - Every resolution writes back to phrase_index, so the next one is free.

Threshold note: the two failure modes are NOT symmetric.
  false negative -> slow path. Annoying, self-correcting.
  false positive -> silently logs the wrong food. You will never catch it.
Start conservative. Loosen only after auditing real match_score data.
"""

import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime

# Deliberately high. Tune down with evidence, not vibes.
EXACT_THRESHOLD = 0.95
FUZZY_THRESHOLD = 0.82

UNIT_WORDS = {
    "g": "g", "gram": "g", "grams": "g", "gm": "g",
    "ml": "ml", "millilitre": "ml", "milliliter": "ml",
    "katori": "katori", "bowl": "katori",
    "cup": "cup", "glass": "glass",
    "tbsp": "tbsp", "tablespoon": "tbsp",
    "tsp": "tsp", "teaspoon": "tsp",
    "piece": "piece", "pieces": "piece", "no": "piece",
}

NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "half": 0.5, "quarter": 0.25, "a": 1, "an": 1,
}


@dataclass
class ParsedItem:
    phrase: str
    quantity: float | None
    unit_code: str | None


@dataclass
class Resolution:
    food_id: int | None
    quantity: float | None
    unit_id: int | None
    match_method: str
    match_score: float
    needs_user: bool
    reason: str | None = None


# ------------------------------------------------------------------
# Step 0 — capture. Never fails, never blocks, never waits on network.
# ------------------------------------------------------------------
def capture(conn: sqlite3.Connection, raw_text: str, confidence: float | None,
            spoken_at: datetime, tz_offset_min: int) -> int:
    cur = conn.execute(
        """INSERT INTO utterance (spoken_at, tz_offset_min, raw_text, stt_confidence)
           VALUES (?, ?, ?, ?)""",
        (spoken_at.isoformat(), tz_offset_min, raw_text, confidence),
    )
    conn.commit()
    return cur.lastrowid


# ------------------------------------------------------------------
# Step 1 — parse. Local, deterministic, no model call.
# Most utterances already carry the unit: "two rotis", "60g atta".
# Parse it. Do not ask for what was already said.
# ------------------------------------------------------------------
def parse(raw_text: str) -> list[ParsedItem]:
    items: list[ParsedItem] = []
    for chunk in re.split(r",| and | with ", raw_text.lower()):
        chunk = chunk.strip()
        if not chunk:
            continue

        qty: float | None = None
        unit: str | None = None

        m = re.match(r"^(\d+(?:\.\d+)?)\s*", chunk)
        if m:
            qty = float(m.group(1))
            chunk = chunk[m.end():].strip()
        else:
            first = chunk.split(" ")[0]
            if first in NUMBER_WORDS:
                qty = NUMBER_WORDS[first]
                chunk = chunk[len(first):].strip()

        for word, code in UNIT_WORDS.items():
            m = re.match(rf"^{word}s?\b\s*(of\s+)?", chunk)
            if m:
                unit = code
                chunk = chunk[m.end():].strip()
                break

        if chunk:
            items.append(ParsedItem(phrase=normalise(chunk), quantity=qty,
                                    unit_code=unit))
    return items


def normalise(phrase: str) -> str:
    phrase = re.sub(r"[^\w\s]", "", phrase.lower()).strip()
    return re.sub(r"\s+", " ", phrase)


# ------------------------------------------------------------------
# Step 2 — FAST PATH. Match against YOUR index, not a global database.
# This is the whole differentiator: it knows what you meant by week two.
# ------------------------------------------------------------------
def fast_path(conn: sqlite3.Connection, item: ParsedItem) -> Resolution | None:
    row = conn.execute(
        """SELECT food_id, default_qty, default_unit_id
           FROM phrase_index WHERE phrase = ?""",
        (item.phrase,),
    ).fetchone()

    method, score = "exact_index", 1.0

    if row is None:
        row, score = fuzzy_lookup(conn, item.phrase)
        method = "fuzzy_index"
        if row is None or score < FUZZY_THRESHOLD:
            return None

    food_id, default_qty, default_unit_id = row

    unit_id = (resolve_unit_id(conn, item.unit_code) if item.unit_code
               else default_unit_id)
    quantity = item.quantity if item.quantity is not None else None

    # Food is known. Quantity may not be. That is a pending field,
    # NOT an ambiguity — the entry still lands.
    if quantity is None:
        return Resolution(food_id, None, unit_id, method, score,
                          needs_user=True, reason="quantity_missing")

    if unit_id is None:
        return Resolution(food_id, quantity, None, method, score,
                          needs_user=True, reason="unit_missing")

    return Resolution(food_id, quantity, unit_id, method, score, needs_user=False)


def fuzzy_lookup(conn, phrase):
    """Trigram / edit-distance over phrase_index. Swap in rapidfuzz or
    a local embedding index; the interface is what matters here."""
    from difflib import SequenceMatcher
    best, best_score = None, 0.0
    for pid, cand, fid, dq, du in conn.execute(
        "SELECT id, phrase, food_id, default_qty, default_unit_id FROM phrase_index"
    ):
        s = SequenceMatcher(None, phrase, cand).ratio()
        if s > best_score:
            best, best_score = (fid, dq, du), s
    return best, best_score


def resolve_unit_id(conn, unit_code: str | None) -> int | None:
    if unit_code is None:
        return None
    row = conn.execute("SELECT id FROM unit WHERE code = ?", (unit_code,)).fetchone()
    return row[0] if row else None


# ------------------------------------------------------------------
# Step 3 — grams. Household measures resolve against YOUR calibration.
# Accuracy is not the goal here. STABILITY is. A personal constant that
# never moves is worth more than a population average that is closer to
# true, because the TDEE regression cancels stable bias and cannot
# cancel a wandering one.
# ------------------------------------------------------------------
def to_grams(conn, food_id: int, quantity: float, unit_id: int) -> float | None:
    is_abs, = conn.execute(
        "SELECT is_absolute FROM unit WHERE id = ?", (unit_id,)
    ).fetchone()
    if is_abs:
        return quantity

    row = conn.execute(
        """SELECT grams FROM user_measure
           WHERE unit_id = ? AND (food_id = ? OR food_id IS NULL)
           ORDER BY food_id IS NULL LIMIT 1""",
        (unit_id, food_id),
    ).fetchone()

    # Uncalibrated household measure -> ask once, then never again.
    return quantity * row[0] if row else None


# ------------------------------------------------------------------
# Step 4 — write. Enforces the invariant: resolved rows are complete.
# ------------------------------------------------------------------
def write_entry(conn, utterance_id, eaten_at, meal_slot, res: Resolution) -> int:
    grams = None
    status = "pending_quantity"

    if res.quantity is not None and res.unit_id is not None:
        grams = to_grams(conn, res.food_id, res.quantity, res.unit_id)
        status = "resolved" if grams is not None else "pending_quantity"

    cur = conn.execute(
        """INSERT INTO log_entry
           (utterance_id, eaten_at, meal_slot, food_id, quantity, unit_id,
            grams_resolved, status, match_method, match_score, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (utterance_id, eaten_at.isoformat(), meal_slot, res.food_id,
         res.quantity, res.unit_id, grams, status,
         res.match_method, res.match_score, datetime.now().isoformat()),
    )
    conn.commit()
    return cur.lastrowid


# ------------------------------------------------------------------
# Step 5 — the write-back. Skip this and the app never gets faster.
# ------------------------------------------------------------------
def learn(conn, phrase: str, food_id: int, qty: float | None, unit_id: int | None):
    conn.execute(
        """INSERT INTO phrase_index
             (phrase, food_id, default_qty, default_unit_id, hit_count, last_used_at)
           VALUES (?,?,?,?,1,?)
           ON CONFLICT(phrase) DO UPDATE SET
             hit_count      = hit_count + 1,
             last_used_at   = excluded.last_used_at,
             default_qty    = COALESCE(phrase_index.default_qty, excluded.default_qty),
             default_unit_id= COALESCE(phrase_index.default_unit_id,
                                       excluded.default_unit_id)""",
        (phrase, food_id, qty, unit_id, datetime.now().isoformat()),
    )
    conn.commit()


# ------------------------------------------------------------------
# Step 6 — corrections are append-only. An in-place edit silently
# rewrites the model's training data with no record it happened.
# ------------------------------------------------------------------
def revise(conn, log_entry_id: int, field: str, new_value, reason: str):
    old = conn.execute(
        f"SELECT {field} FROM log_entry WHERE id = ?", (log_entry_id,)
    ).fetchone()[0]

    conn.execute(
        """INSERT INTO log_revision
             (log_entry_id, revised_at, field, old_value, new_value, reason)
           VALUES (?,?,?,?,?,?)""",
        (log_entry_id, datetime.now().isoformat(), field, str(old),
         str(new_value), reason),
    )
    conn.execute(f"UPDATE log_entry SET {field} = ? WHERE id = ?",
                 (new_value, log_entry_id))

    row = conn.execute(
        "SELECT food_id, quantity, unit_id FROM log_entry WHERE id = ?",
        (log_entry_id,),
    ).fetchone()
    if all(v is not None for v in row):
        grams = to_grams(conn, *row)
        if grams is not None:
            conn.execute(
                "UPDATE log_entry SET grams_resolved = ?, status = 'resolved' "
                "WHERE id = ?", (grams, log_entry_id))
    conn.commit()


# ------------------------------------------------------------------
# Orchestration
# ------------------------------------------------------------------
def handle_utterance(conn, raw_text, confidence, spoken_at, tz_offset_min,
                     meal_slot=None):
    uid = capture(conn, raw_text, confidence, spoken_at, tz_offset_min)

    results = []
    for item in parse(raw_text):
        res = fast_path(conn, item)

        if res is None:
            # SLOW PATH. Genuine ambiguity in food identity -> never
            # written to log_entry. Surface it, let the user resolve,
            # then learn() so it is fast forever after.
            results.append({"phrase": item.phrase, "action": "slow_path",
                            "utterance_id": uid})
            continue

        entry_id = write_entry(conn, uid, spoken_at, meal_slot, res)
        learn(conn, item.phrase, res.food_id, res.quantity, res.unit_id)
        results.append({"entry_id": entry_id, "needs_user": res.needs_user,
                        "reason": res.reason})

    conn.execute("UPDATE utterance SET processed_at = ? WHERE id = ?",
                 (datetime.now().isoformat(), uid))
    conn.commit()
    return results
