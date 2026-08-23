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


-- ============================================================
-- v0 ADDITIONS
-- Everything below is additive. Nothing above was changed.
-- The blocks marked [designed-for] are schema-only: the tables
-- exist so later work needs no migration, but v0 ships no UI
-- and no logic that reads them.
-- ============================================================


-- ------------------------------------------------------------
-- 9. WORKOUTS  [designed-for — schema only in v0]
-- Every source that estimates session energy gets its OWN ROW.
-- Precedence is resolved at READ time, in v_session_energy.
-- There is no write-time constraint that picks a winner, which
-- is what makes double-counting structurally impossible: you
-- cannot sum two sources by accident because the view only ever
-- emits one row per session.
-- ------------------------------------------------------------
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

-- Prefer garmin, fall back to met_estimate, fall back to manual.
-- Exactly one row per session, always.
CREATE VIEW v_session_energy AS
SELECT
    ws.id                       AS session_id,
    ws.started_at,
    ws.kind,
    se.source,
    se.kcal
FROM workout_session ws
JOIN session_energy se ON se.session_id = ws.id
WHERE se.source = (
    SELECT source FROM session_energy s2
    WHERE s2.session_id = ws.id
    ORDER BY CASE s2.source
                 WHEN 'garmin'        THEN 0
                 WHEN 'met_estimate'  THEN 1
                 WHEN 'manual'        THEN 2
             END
    LIMIT 1
);


-- Idempotency for imports. A re-exported month must not double every
-- workout in it, and NULL kind must not defeat the constraint the way a
-- plain UNIQUE would (see user_measure, section 3).
CREATE UNIQUE INDEX ux_workout_session
    ON workout_session (started_at, COALESCE(kind, ''));


-- ------------------------------------------------------------
-- 9b. DAILY BODY METRICS  [designed-for — no UI in v0]
-- Sleep, REM, resting heart rate, HRV, stress. These are the
-- reason to ingest Garmin at all; its calorie figure is the
-- least interesting thing it produces.
--
-- Same shape as session_energy for the same reason: one row per
-- (day, metric, SOURCE), and precedence resolved at read time in
-- v_daily_metric. Two devices disagreeing about last night's
-- sleep is a fact to store, not a conflict to resolve at write
-- time — and a value that came from somewhere is worth more than
-- one that came from an average of somewheres.
-- ------------------------------------------------------------
CREATE TABLE daily_metric (
    log_date    TEXT NOT NULL,          -- local calendar day
    metric      TEXT NOT NULL,          -- 'sleep_min','rem_min','deep_min',
                                        -- 'rhr_bpm','hrv_ms','stress_avg',
                                        -- 'body_battery_max','steps',
                                        -- 'water_glasses' (manual)
    source      TEXT NOT NULL CHECK (source IN ('garmin','manual')),
    value       REAL NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (log_date, metric, source)
);

CREATE VIEW v_daily_metric AS
SELECT dm.log_date, dm.metric, dm.source, dm.value
FROM daily_metric dm
WHERE dm.source = (
    SELECT d2.source FROM daily_metric d2
    WHERE d2.log_date = dm.log_date AND d2.metric = dm.metric
    ORDER BY CASE d2.source WHEN 'garmin' THEN 0 WHEN 'manual' THEN 1 END
    LIMIT 1
);

-- When each source started and stopped supplying data.
--
-- Beginning to ingest a new source partway through a series is a step
-- change in measurement regime, which is the one thing an adaptive TDEE
-- regression cannot cancel out. The model is not built yet; this view
-- exists so that when it is, the boundary is a row you can see rather
-- than a discontinuity someone has to rediscover from the residuals.
CREATE VIEW v_source_coverage AS
SELECT 'daily_metric' AS relation, metric AS series, source,
       MIN(log_date) AS first_seen, MAX(log_date) AS last_seen, COUNT(*) AS n
FROM daily_metric GROUP BY metric, source
UNION ALL
SELECT 'session_energy', 'session_kcal', se.source,
       MIN(date(ws.started_at)), MAX(date(ws.started_at)), COUNT(*)
FROM session_energy se JOIN workout_session ws ON ws.id = se.session_id
GROUP BY se.source;


-- ------------------------------------------------------------
-- 9c. GOAL SETTING
--
-- Owner-authorised addition: the brief listed goal setting as out of
-- scope for v0, and the owner has since put it in scope.
--
-- body_profile is APPEND-ONLY, like log_revision and for the same
-- reason: weight moves, and a target recomputed from today's weight
-- must not silently rewrite what last month's target was. The newest
-- row is current; the older ones are how you got here.
-- ------------------------------------------------------------
CREATE TABLE body_profile (
    id              INTEGER PRIMARY KEY,
    recorded_at     TEXT    NOT NULL,
    -- Selects a formula coefficient set. These equations were fitted on
    -- male/female cohorts and offer no other option; that is a property
    -- of the published research, not a statement about people.
    sex             TEXT    NOT NULL CHECK (sex IN ('male','female')),
    age_years       REAL    NOT NULL,
    height_cm       REAL    NOT NULL,
    weight_kg       REAL    NOT NULL,
    -- Null unless actually known. Katch-McArdle needs it and is skipped
    -- without it, rather than run on a guessed body-fat figure.
    body_fat_pct    REAL,
    activity_factor REAL    NOT NULL,
    -- Negative loses weight, positive gains, zero maintains.
    goal_rate_kg_per_week REAL NOT NULL DEFAULT 0,
    -- Where you are heading. Null means "no destination, just a rate".
    goal_weight_kg  REAL
);

CREATE INDEX idx_body_profile_recorded ON body_profile (recorded_at DESC);


-- Every formula that estimates a target gets its OWN ROW, exactly like
-- session_energy. Three published equations disagree by a few hundred
-- kcal on the same body; that disagreement is information, and averaging
-- it away would be pretending to a precision none of them has.
--
-- Precedence is inverted relative to session_energy, deliberately.
-- session_energy holds MEASUREMENTS of what happened, so the best
-- instrument wins. energy_target holds DECISIONS about what should
-- happen, so the user's own decision wins - the brief's eighth principle
-- is that this app does what it is told and explains the consequence,
-- rather than the other way round.
CREATE TABLE energy_target (
    log_date        TEXT NOT NULL,
    source          TEXT NOT NULL
                    CHECK (source IN ('manual','cycled','adaptive','mifflin','harris','katch')),
    kcal            REAL NOT NULL,
    -- How this number was arrived at, in words, so a target found in the
    -- database six months from now still carries its own provenance.
    basis           TEXT,
    computed_at     TEXT NOT NULL,
    PRIMARY KEY (log_date, source)
);

CREATE VIEW v_energy_target AS
SELECT et.log_date, et.source, et.kcal, et.basis
FROM energy_target et
WHERE et.source = (
    SELECT e2.source FROM energy_target e2
    WHERE e2.log_date = et.log_date
    ORDER BY CASE e2.source
                 WHEN 'manual'   THEN 0   -- you said so
                 WHEN 'cycled'   THEN 1   -- the week's total, redistributed
                 WHEN 'adaptive' THEN 2   -- fitted to your own data (not built yet)
                 WHEN 'mifflin'  THEN 3   -- population formulas, best first
                 WHEN 'harris'   THEN 4
                 WHEN 'katch'    THEN 5
             END
    LIMIT 1
);


-- ------------------------------------------------------------
-- 10. CAPTURE TIMING
-- Acceptance criterion 1 is "under 3 seconds, measured not
-- estimated". A number you did not store is an estimate, so
-- store it. Separate table rather than columns on utterance:
-- utterance is the one write on the critical path and it stays
-- exactly as narrow as it was designed to be.
-- ------------------------------------------------------------
CREATE TABLE capture_timing (
    utterance_id    INTEGER PRIMARY KEY REFERENCES utterance(id) ON DELETE CASCADE,
    -- All milliseconds, all relative to the mic tap.
    mic_tap_to_stt  REAL,      -- tap -> speech-to-text returned a transcript
    stt_to_capture  REAL,      -- transcript -> utterance row committed
    capture_to_entry REAL,     -- utterance committed -> log_entry committed
    total_ms        REAL NOT NULL,
    fast_path       INTEGER NOT NULL,   -- 1 = never left the device index
    entry_count     INTEGER NOT NULL
);


-- UNIQUE (food_id, unit_id) above cannot enforce one general calibration
-- per unit, because SQLite treats NULLs as distinct inside a UNIQUE
-- constraint. This partial index does, and gives the upsert something to
-- name as a conflict target.
CREATE UNIQUE INDEX ux_user_measure_general
    ON user_measure (unit_id) WHERE food_id IS NULL;

-- food's own UNIQUE has the same NULL blind spot for brand and source_ref.
-- The loader dedupes with IS-comparisons before inserting, so this index
-- is a backstop, not the mechanism — but a duplicated food is a wandering
-- resolution target, which is the one thing the whole design cannot absorb.
CREATE UNIQUE INDEX ux_food_identity
    ON food (name, COALESCE(brand, ''), source, COALESCE(source_ref, ''));


-- ------------------------------------------------------------
-- 11. SETTINGS
-- FUZZY_THRESHOLD is explicitly a placeholder, not a tuned
-- value, so it does not belong in a source file. Same for every
-- other number that will move once there is real match_score
-- data to look at.
-- ------------------------------------------------------------
CREATE TABLE app_setting (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
);


-- ------------------------------------------------------------
-- 12. IMPORTED HISTORY  (Healthify)
-- Names, portions-as-written and timestamps ONLY. There is
-- deliberately no kcal column here: a different food database
-- is a step change in bias, and a step change in bias is the
-- one thing the TDEE regression cannot cancel.
--
-- This table is NOT the log. Imported rows never become
-- log_entry rows. They exist to seed phrase_index candidates
-- and to derive meal-slot windows from real behaviour.
-- ------------------------------------------------------------
CREATE TABLE imported_entry (
    id              INTEGER PRIMARY KEY,
    source          TEXT    NOT NULL,      -- 'healthify'
    eaten_at        TEXT    NOT NULL,
    food_text       TEXT    NOT NULL,      -- exactly as their export wrote it
    portion_text    TEXT,                  -- exactly as their export wrote it
    meal_label      TEXT,                  -- their slot name, if present
    imported_at     TEXT    NOT NULL
);

CREATE INDEX idx_imported_eaten ON imported_entry (eaten_at);

-- Import idempotency. A plain UNIQUE over these columns does not survive
-- a NULL portion_text — SQLite treats NULLs as distinct inside UNIQUE —
-- so re-importing the same export would duplicate every row that has no
-- portion. Same lesson user_measure taught: dedupe through an expression.
CREATE UNIQUE INDEX ux_imported_entry
    ON imported_entry (source, eaten_at, food_text, COALESCE(portion_text, ''));


-- ------------------------------------------------------------
-- 13. MEAL SLOT WINDOWS
-- Derived by clustering actual logging timestamps. Never
-- hard-coded: the whole point is that these come from what the
-- user does, not from what a nutrition app thinks a day looks
-- like.
-- ------------------------------------------------------------
CREATE TABLE meal_slot_window (
    slot            TEXT PRIMARY KEY,      -- 'breakfast','lunch','snack','dinner'
    centre_min      REAL NOT NULL,         -- minutes past local midnight
    start_min       REAL NOT NULL,
    end_min         REAL NOT NULL,
    n_observations  INTEGER NOT NULL,
    derived_at      TEXT NOT NULL,
    derived_from    TEXT NOT NULL          -- 'imported_entry' | 'log_entry'
);


-- ------------------------------------------------------------
-- 14. MATCH AUDIT
-- A false negative sends you to the slow path and corrects
-- itself. A false positive logs the wrong food silently and you
-- never find out. This table is the only way you ever find out:
-- every fuzzy decision, accepted or rejected, with the runner-up
-- it beat and by how much.
-- ------------------------------------------------------------
CREATE TABLE match_audit (
    id              INTEGER PRIMARY KEY,
    utterance_id    INTEGER REFERENCES utterance(id) ON DELETE CASCADE,
    log_entry_id    INTEGER REFERENCES log_entry(id) ON DELETE SET NULL,
    phrase          TEXT    NOT NULL,      -- what was said, normalised
    chosen_phrase   TEXT,                  -- index phrase that won
    chosen_food_id  INTEGER REFERENCES food(id),
    score           REAL,
    runner_up       TEXT,
    runner_up_score REAL,
    threshold       REAL    NOT NULL,      -- threshold in force at the time
    accepted        INTEGER NOT NULL,      -- 0 = fell through to slow path
    learned         INTEGER NOT NULL DEFAULT 0,  -- 1 = written back to the index
    decided_at      TEXT    NOT NULL
);

CREATE INDEX idx_match_audit_score ON match_audit (score);


-- ------------------------------------------------------------
-- 15. UNDO
-- The undo toast replaces a confirmation step: capture commits
-- immediately and stays committed unless actively revoked inside
-- the window. The utterance itself is NEVER deleted — only the
-- entries derived from it — so every utterance still has exactly
-- one visible outcome: entries, a queue position, or an undo.
-- ------------------------------------------------------------
CREATE TABLE undone_utterance (
    utterance_id    INTEGER PRIMARY KEY REFERENCES utterance(id) ON DELETE CASCADE,
    undone_at       TEXT    NOT NULL,
    entries_removed INTEGER NOT NULL
);


-- ------------------------------------------------------------
-- 16. ADDITIONAL VIEWS
-- ------------------------------------------------------------

-- Per-entry detail behind v_daily_totals. Useful for the day
-- list, and for seeing which single entry owns the error bar.
CREATE VIEW v_entry_nutrient AS
SELECT
    le.id           AS log_entry_id,
    date(le.eaten_at) AS log_date,
    le.eaten_at,
    le.meal_slot,
    f.name          AS food_name,
    le.quantity,
    u.code          AS unit_code,
    le.grams_resolved,
    le.match_method,
    le.match_score,
    fn.nutrient,
    le.grams_resolved / 100.0 * fn.per_100g                     AS amount,
    le.grams_resolved / 100.0 * fn.per_100g * fn.rel_error      AS abs_error
FROM log_entry le
JOIN food f           ON f.id = le.food_id
JOIN food_nutrient fn ON fn.food_id = le.food_id
LEFT JOIN unit u      ON u.id = le.unit_id
WHERE le.status = 'resolved';

-- Utterances with nothing to show for them. This is the
-- "zero logs lost" check: it must always be empty or visibly
-- queued, never silently discarded.
CREATE VIEW v_orphan_utterance AS
SELECT
    u.id,
    u.spoken_at,
    u.raw_text,
    u.stt_confidence,
    (SELECT COUNT(*) FROM log_entry le WHERE le.utterance_id = u.id) AS entries
FROM utterance u
WHERE u.processed_at IS NULL
  AND u.id NOT IN (SELECT utterance_id FROM undone_utterance)
ORDER BY u.spoken_at DESC;

-- Fuzzy decisions close enough to the threshold to be worth a
-- human glance. Drives threshold tuning with evidence.
CREATE VIEW v_match_review AS
SELECT
    ma.decided_at,
    ma.phrase,
    ma.chosen_phrase,
    f.name AS chosen_food,
    ma.score,
    ma.runner_up,
    ma.runner_up_score,
    ma.score - COALESCE(ma.runner_up_score, 0) AS margin,
    ma.threshold,
    ma.accepted,
    ma.learned
FROM match_audit ma
LEFT JOIN food f ON f.id = ma.chosen_food_id
WHERE ma.score IS NOT NULL
ORDER BY ABS(ma.score - ma.threshold) ASC;

