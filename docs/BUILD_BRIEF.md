# Build brief — personal nutrition & training log

## Who this is for

Single user, self-hosted, local-first. I am the only user and I am technical.
Do not add onboarding flows, auth, multi-tenancy, analytics, or subscription
scaffolding. If a decision trades simplicity for scale, choose simplicity.

I have ~6 months of prior food logs in Healthify (HealthifyMe) and a Garmin
device. I have logged food consistently before, so adherence is plausible —
but only if logging is fast.

---

## The thesis

Existing trackers (MyFitnessPal, Cronometer, Healthify, MacroFactor) all report
calorie numbers that are wrong, because the error lives in the user's
measurement process, not in their food database. This app does not try to be
more accurate. It tries to be **more consistent**, and to be honest about the
difference.

The product is three things:

1. **Voice logging that beats typing.** Speak a meal, it's logged in under
   three seconds, no confirmation screen.
2. **A personal index.** The app learns *my* food vocabulary. It gets faster
   the longer I use it. A generic food database cannot do this.
3. **A calibrated personal intake index, not a calorie count.** The number is
   denominated in my own logging units, calibrated against my own scale.

Everything else is downstream of these.

---

## Non-negotiable design principles

These were reasoned through carefully. Do not "improve" them without asking.

### 1. Consistency beats accuracy

An adaptive TDEE model regresses *logged* intake against *measured* weight
change. A stable systematic bias cancels out — the model learns "when he logs
2200, his weight holds." A **wandering** bias does not cancel and destroys the
model.

Consequences:
- The same food must always resolve to the same entry. Stable resolution
  matters more than a comprehensive database.
- Anything that changes measurement regime mid-series is a threat: logging
  fatigue, switching data sources, a run of restaurant meals, or the user
  *getting better* at logging.
- Therefore log **behaviour**, not just content (see `daily_logging_stats`).

### 2. Capture never blocks

The raw utterance is written to the DB the instant speech-to-text returns.
Before parsing, before matching, before any network call. Nothing downstream
can lose a log. Resolution failure, dead network, app crash — the utterance
survives.

### 3. Ambiguous ≠ incomplete

- **Ambiguous** = we don't know what food was meant. This must NEVER reach
  `log_entry`. Surface it, let me resolve it, then learn it.
- **Incomplete** = we know the food, we don't have the amount. This IS
  written, with `status = 'pending_quantity'`. It is a known gap, not a guess.

### 4. Pending entries are excluded, never zeroed

A NULL quantity summed as 0 is silent under-logging — precisely the failure
this design exists to prevent. Days with pending entries are excluded from any
model fit, not averaged in.

### 5. Every number carries provenance

No nutrient value is ever hard-coded in application logic. Every value has a
`source` (`indb`, `ifct2017`, `usda_fdc`, `label`, `user_defined`) and a
`rel_error`. FSSAI permits ±20–25% tolerance on declared label values, so
stored precision must not exceed real precision.

### 6. Edits are append-only

Editing a three-week-old entry in place silently rewrites the model's training
data with no record. Every change writes a `log_revision` row. This is what
later distinguishes a genuine metabolic shift from my own retroactive
correction.

### 7. Household measures resolve against MY calibration

"One katori" is meaningless until pinned to my katori. Weighed once, stored as
a personal constant, reused forever. Accuracy is not the goal — **stability
is**. A personal constant that never moves beats a population average that is
closer to true.

### 8. Default permissive, surface consequences, never block

I am building this because commercial trackers make decisions for me. If a
setting could cause a problem (e.g. double-counting workout calories), explain
the consequence once, then do exactly what I asked. Never refuse, never nag,
never lock a value.

### 9. Store every estimate, sum none of them

Where multiple sources estimate the same quantity (Garmin vs MET-derived
workout calories), store all of them in separate rows. Precedence is a
**read-time** decision in a view, never a write-time constraint. This makes
double-counting structurally impossible.

---

## Scope of THIS build (v0)

The single hypothesis under test: **can I log a meal by voice faster than I can
type it, and will I keep doing it for 30 days?**

Everything in v0 exists to test that. Nothing else.

### In scope

- [ ] Voice capture → on-device STT → raw utterance persisted
- [ ] Deterministic local parser (quantity + unit + food phrase). **No LLM
      call on the fast path.** Regex over number words and unit words.
      "two rotis", "60g atta", "one katori rajma" must parse locally.
- [ ] Fuzzy match against `phrase_index` (the personal index)
- [ ] Fast path: match → resolve grams → write → haptic/toast. No spoken
      reply, no confirmation screen.
- [ ] Slow path: unmatched food → interactive resolution (LLM-assisted is
      fine here) → write back to `phrase_index` so it is fast forever after
- [ ] Pending-quantity queue, cleared in one end-of-day pass
- [ ] Undo toast (5s, non-blocking) instead of a confirm step
- [ ] Manual edit of any entry, via `log_revision`
- [ ] Unit calibration screen: weigh a measure once, store grams
- [ ] Healthify import — **food names, portions-as-written, timestamps ONLY.
      Do not import their calorie figures.** Different database = step change
      in bias = broken regression. The history is for pattern seeding, not
      for numbers.
- [ ] Daily totals view with error bars (errors combine in quadrature)
- [ ] `daily_logging_stats` populated nightly
- [ ] `match_score` logged on every entry from day one

### Explicitly OUT of scope for v0

Do not build these. They are designed for, not built yet:

- Garmin ingestion (stress, HRV, sleep, REM, RHR)
- Adaptive TDEE model / goal setting / calorie targets
- Exercise logger
- Micronutrients (store the fields, no UI, no recommendations)
- Any recommendation engine
- Meal/workout templates beyond what `phrase_index` gives free

The schema should accommodate all of these without migration. The **app**
should not implement any of them.

---

## Data model

Use `schema.sql` as provided. It is deliberate — read the comments before
changing anything.

Add for v0 (already designed, safe to include):

```sql
CREATE TABLE workout_session (
    id            INTEGER PRIMARY KEY,
    started_at    TEXT NOT NULL,
    duration_min  REAL,
    kind          TEXT,
    notes         TEXT
);

CREATE TABLE session_energy (
    session_id  INTEGER NOT NULL REFERENCES workout_session(id),
    source      TEXT NOT NULL CHECK (source IN ('garmin','met_estimate','manual')),
    kcal        REAL NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (session_id, source)
);
```

Precedence view: prefer `garmin`, fall back to `met_estimate`, fall back to
`manual`. One row per session in any sum, never a total.

Food reference data: seed from **INDB** (open access, ~1,095 items + ~1,014
recipes with ingredient decomposition) as primary. IFCT 2017 as reference
only — it is personal-use licensed, so **do not commit any IFCT-derived data
to a repository**. Ship a loader script, gitignore the data directory.

---

## Stack

Optimise for time-to-first-real-log, not for eventual polish.

Recommended: **mobile PWA**, Web Speech API for STT, SQLite via
`sql.js`/`wa-sqlite` with OPFS persistence, plain TypeScript. This tests the
core hypothesis in days rather than weeks and runs on my phone without a
store listing.

If Web Speech API latency proves unacceptable on Android, fall back to
React Native + Expo with on-device speech recognition. Do not start there.

Propose alternatives if you have a strong reason, but justify it against
time-to-first-log.

---

## Tuning notes

- `FUZZY_THRESHOLD = 0.82` is a placeholder, not a tuned value. Log every
  `match_score` and leave the threshold configurable.
- The two match failure modes are **not symmetric**. A false negative sends me
  to the slow path — annoying, self-correcting. A false positive silently logs
  the wrong food and I will never catch it. Start conservative.
- `fuzzy_lookup` in `resolve.py` does a full scan with `difflib`. Fine at a few
  hundred phrases. Swap in `rapidfuzz` or a local embedding index when it
  matters — the interface should not change.
- Do not hard-code meal-slot times. Derive them by clustering my actual
  logging timestamps from the Healthify import.

---

## Acceptance criteria

v0 is done when, measured not estimated:

1. Logging a **known repeat meal** takes under 3 seconds from tapping the mic
   to the entry being persisted. Instrument this and store the timing.
2. `fastpath_fraction` exceeds 0.8 after two weeks of use.
3. Zero logs lost to resolution or network failure (every utterance row has a
   corresponding resolution outcome or sits visibly in a queue).
4. The end-of-day pending queue is short enough to clear in under a minute.
5. I have used it 30 consecutive days without opening Healthify.

Criterion 5 is the real one. The rest are diagnostics for why it failed.

---

## How to work

- Start with the schema and the capture path. Get an utterance persisting
  before anything else exists.
- Build the parser next, with tests over real phrases I will supply.
- The UI is last and should be close to nothing: a mic button, a day list,
  an edit sheet, a pending queue.
- Ask me before adding any feature not listed in scope. The single largest
  risk to this project is scope creep, and it has already happened once.
