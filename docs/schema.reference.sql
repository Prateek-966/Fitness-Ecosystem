-- ============================================================
-- Personal nutrition log — schema v0
-- SQLite. Design constraints:
--   1. Raw utterance is captured unconditionally, never blocks.
--   2. Nothing AMBIGUOUS reaches the resolved tables.
--      Known-missing (quantity pending) is allowed and tracked.
--   3. Every nutrient value carries provenance.
--   4. Edits are append-only. History is never overwritten.
--   5. Household measures resolve against the USER's own grams.
-- ============================================================

PRAGMA foreign_keys = ON;


-- ------------------------------------------------------------
-- 1. RAW CAPTURE
-- Written the instant speech-to-text returns. Always succeeds.
-- Survives network failure, resolution failure, app crash.
-- ------------------------------------------------------------
CREATE TABLE utterance (
    id              INTEGER PRIMARY KEY,
    spoken_at       TEXT    NOT NULL,          -- ISO8601, device local
    tz_offset_min   INTEGER NOT NULL,
    raw_text        TEXT    NOT NULL,          -- exactly what STT returned
    stt_confidence  REAL,                      -- 0..1, null if unavailable
    audio_path      TEXT,                      -- optional, keep briefly for debugging
    processed_at    TEXT,                      -- null = not yet resolved
    CHECK (raw_text <> '')
);

CREATE INDEX idx_utterance_unprocessed
    ON utterance (spoken_at) WHERE processed_at IS NULL;


-- ------------------------------------------------------------
-- 2. FOOD REFERENCE
-- Composition is per 100 g EDIBLE PORTION, always.
-- Never inline nutrient numbers in application code.
-- ------------------------------------------------------------
CREATE TABLE food (
    id              INTEGER PRIMARY KEY,
    name            TEXT    NOT NULL,
    brand           TEXT,                      -- null for generic/home foods
    is_composite    INTEGER NOT NULL DEFAULT 0,-- 1 = dish built from a recipe
    source          TEXT    NOT NULL,          -- 'indb' | 'ifct2017' | 'usda_fdc'
                                               -- | 'label' | 'user_defined'
    source_ref      TEXT,                      -- upstream row id / FDC id / GTIN
    source_fetched  TEXT,                      -- when the value was captured
    default_unit_id INTEGER REFERENCES unit(id),
    created_at      TEXT    NOT NULL,
    UNIQUE (name, brand, source, source_ref)
);

CREATE TABLE food_nutrient (
    food_id         INTEGER NOT NULL REFERENCES food(id) ON DELETE CASCADE,
    nutrient        TEXT    NOT NULL,          -- 'kcal','protein_g','fat_g',
                                               -- 'carb_g','fibre_g', ...
    per_100g        REAL    NOT NULL,
    -- Label tolerance under FSSAI is +/-20-25%. Store the band, don't pretend
    -- to a precision the label itself does not have.
    rel_error       REAL    NOT NULL DEFAULT 0.20,
    PRIMARY KEY (food_id, nutrient)
);


-- ------------------------------------------------------------
-- 3. UNITS AND PERSONAL CONVERSIONS
-- "One katori" is meaningless until pinned to YOUR katori.
-- A stable personal constant beats an accurate population average.
-- ------------------------------------------------------------
CREATE TABLE unit (
    id              INTEGER PRIMARY KEY,
    code            TEXT    NOT NULL UNIQUE,   -- 'g','ml','piece','katori',
                                               -- 'cup','tbsp','tsp','glass'
    is_absolute     INTEGER NOT NULL           -- 1 = g/ml, needs no conversion
);

-- Which units are offered for a given food. Prevents "2 ml roti".
CREATE TABLE food_unit (
    food_id         INTEGER NOT NULL REFERENCES food(id) ON DELETE CASCADE,
    unit_id         INTEGER NOT NULL REFERENCES unit(id),
    PRIMARY KEY (food_id, unit_id)
);

-- The calibration table. Weigh it once, reuse forever.
CREATE TABLE user_measure (
    id              INTEGER PRIMARY KEY,
    food_id         INTEGER REFERENCES food(id), -- null = applies to all foods
    unit_id         INTEGER NOT NULL REFERENCES unit(id),
    grams           REAL    NOT NULL,
    -- 'weighed'  -> you put it on a scale. Trust it.
    -- 'estimated'-> you guessed. Still stable, still usable, wider band.
    basis           TEXT    NOT NULL CHECK (basis IN ('weighed','estimated')),
    calibrated_at   TEXT    NOT NULL,
    UNIQUE (food_id, unit_id)
);


-- ------------------------------------------------------------
-- 4. THE LOG
-- status drives everything downstream:
--   'resolved'         -> complete, counts toward totals
--   'pending_quantity' -> food known, amount not yet supplied
--   'pending_food'     -> should not exist; ambiguity is blocked upstream
-- ------------------------------------------------------------
CREATE TABLE log_entry (
    id              INTEGER PRIMARY KEY,
    utterance_id    INTEGER REFERENCES utterance(id),  -- null = typed entry
    eaten_at        TEXT    NOT NULL,
    meal_slot       TEXT,                      -- 'breakfast','lunch','snack','dinner'
    food_id         INTEGER NOT NULL REFERENCES food(id),
    quantity        REAL,                      -- NULL while pending
    unit_id         INTEGER REFERENCES unit(id),
    grams_resolved  REAL,                      -- computed at resolution time
    status          TEXT    NOT NULL
                    CHECK (status IN ('resolved','pending_quantity','pending_food')),
    -- How the food was matched. Drives the false-positive audit.
    match_method    TEXT,                      -- 'exact_index','fuzzy_index',
                                               -- 'llm_resolved','manual'
    match_score     REAL,
    created_at      TEXT    NOT NULL,

    -- A resolved row must be complete. Enforced, not assumed.
    CHECK (
        status <> 'resolved'
        OR (quantity IS NOT NULL AND unit_id IS NOT NULL AND grams_resolved IS NOT NULL)
    )
);

CREATE INDEX idx_log_eaten     ON log_entry (eaten_at);
CREATE INDEX idx_log_pending   ON log_entry (status) WHERE status <> 'resolved';


-- ------------------------------------------------------------
-- 5. REVISIONS — append only
-- Editing a 3-week-old entry in place silently rewrites the
-- training data of the TDEE model. Version instead, so a genuine
-- metabolic shift stays distinguishable from your own correction.
-- ------------------------------------------------------------
CREATE TABLE log_revision (
    id              INTEGER PRIMARY KEY,
    log_entry_id    INTEGER NOT NULL REFERENCES log_entry(id) ON DELETE CASCADE,
    revised_at      TEXT    NOT NULL,
    field           TEXT    NOT NULL,          -- 'quantity','unit_id','food_id',...
    old_value       TEXT,
    new_value       TEXT,
    reason          TEXT                       -- 'user_edit','quantity_supplied',
                                               -- 'recalibration'
);

CREATE INDEX idx_revision_entry ON log_revision (log_entry_id, revised_at);


-- ------------------------------------------------------------
-- 6. THE PERSONAL INDEX
-- Every slow-path resolution writes back here. This table is why
-- the app gets faster the longer you use it, and it is the thing
-- MyFitnessPal structurally cannot give you.
-- ------------------------------------------------------------
CREATE TABLE phrase_index (
    id              INTEGER PRIMARY KEY,
    phrase          TEXT    NOT NULL,          -- normalised: lowercase, no plurals
    food_id         INTEGER NOT NULL REFERENCES food(id),
    default_qty     REAL,
    default_unit_id INTEGER REFERENCES unit(id),
    hit_count       INTEGER NOT NULL DEFAULT 0,
    last_used_at    TEXT,
    UNIQUE (phrase)
);


-- ------------------------------------------------------------
-- 7. LOGGING BEHAVIOUR — the bias-drift detector
-- Systematic error is fine if it is STABLE. This table exists to
-- catch the moment it stops being stable: logging fatigue, a
-- database switch, a run of restaurant meals, or getting better
-- at logging (which the model misreads as a metabolic change).
-- ------------------------------------------------------------
CREATE TABLE daily_logging_stats (
    log_date            TEXT PRIMARY KEY,
    entry_count         INTEGER NOT NULL,
    pending_count       INTEGER NOT NULL,
    weighed_fraction    REAL,                  -- share resolved via 'weighed' basis
    fastpath_fraction   REAL,                  -- share matched from phrase_index
    outside_food_count  INTEGER,
    first_log_at        TEXT,
    last_log_at         TEXT,
    -- 0 = do not feed this day to the TDEE regression
    model_eligible      INTEGER NOT NULL DEFAULT 1
);


-- ------------------------------------------------------------
-- 8. VIEWS
-- ------------------------------------------------------------

-- Daily totals. Pending entries are EXCLUDED, never summed as zero —
-- a NULL quantity counted as 0 is silent under-logging, which is the
-- exact failure this whole design exists to prevent.
CREATE VIEW v_daily_totals AS
SELECT
    date(le.eaten_at)                                   AS log_date,
    fn.nutrient,
    SUM(le.grams_resolved / 100.0 * fn.per_100g)        AS total,
    -- errors combine in quadrature, not linearly
    SQRT(SUM(POWER(le.grams_resolved / 100.0 * fn.per_100g * fn.rel_error, 2)))
                                                        AS abs_error,
    COUNT(*)                                            AS n_entries
FROM log_entry le
JOIN food_nutrient fn ON fn.food_id = le.food_id
WHERE le.status = 'resolved'
GROUP BY 1, 2;

-- The end-of-day queue. Short by design; if it isn't, the
-- fuzzy-match threshold or the unit defaults need work.
CREATE VIEW v_pending_review AS
SELECT
    le.id,
    le.eaten_at,
    f.name          AS food_name,
    u.raw_text      AS said,
    le.status,
    le.match_method,
    le.match_score
FROM log_entry le
JOIN food f          ON f.id = le.food_id
LEFT JOIN utterance u ON u.id = le.utterance_id
WHERE le.status <> 'resolved'
ORDER BY le.eaten_at;

-- Days that must not enter the TDEE fit.
CREATE VIEW v_model_excluded_days AS
SELECT log_date, entry_count, pending_count, fastpath_fraction
FROM daily_logging_stats
WHERE model_eligible = 0
   OR pending_count > 0
   OR entry_count = 0;
