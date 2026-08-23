-- ============================================================
-- Seed: units and defaults only.
--
-- No nutrient values live here. Food composition arrives via
-- scripts/load-indb.ts from a gitignored data directory, and
-- every row it writes carries its own source and rel_error.
-- ============================================================

INSERT OR IGNORE INTO unit (code, is_absolute) VALUES
    ('g',      1),
    ('ml',     1),
    ('piece',  0),
    ('katori', 0),
    ('cup',    0),
    ('glass',  0),
    ('tbsp',   0),
    ('tsp',    0),
    ('plate',  0),
    ('slice',  0);

-- Thresholds live in the database, not in a source file: they
-- are placeholders until there is real match_score data, and a
-- placeholder you have to redeploy to change never gets tuned.
INSERT OR IGNORE INTO app_setting (key, value) VALUES
    -- Deliberately high. Loosen with evidence from v_match_review.
    ('fuzzy_threshold',       '0.82'),
    -- Above this, a fuzzy hit is written back to phrase_index and
    -- becomes an exact match forever. See README "Auto-learn".
    ('auto_learn_threshold',  '0.93'),
    -- A fuzzy win this close to its runner-up is not a win.
    ('min_match_margin',      '0.05'),
    ('undo_window_ms',        '5000'),
    ('target_capture_ms',     '3000');

-- ------------------------------------------------------------
-- Additive migrations. seed.sql runs on every open, so a database
-- created before these indexes existed picks them up here. The
-- imported_entry dedupe must run first or the index cannot build
-- over data the old UNIQUE let through.
-- ------------------------------------------------------------
DELETE FROM imported_entry WHERE id NOT IN (
    SELECT MIN(id) FROM imported_entry
    GROUP BY source, eaten_at, food_text, COALESCE(portion_text, '')
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_imported_entry
    ON imported_entry (source, eaten_at, food_text, COALESCE(portion_text, ''));
CREATE UNIQUE INDEX IF NOT EXISTS ux_food_identity
    ON food (name, COALESCE(brand, ''), source, COALESCE(source_ref, ''));
CREATE UNIQUE INDEX IF NOT EXISTS ux_workout_session
    ON workout_session (started_at, COALESCE(kind, ''));
INSERT OR IGNORE INTO app_setting (key, value) VALUES
    ('macro_protein_pct',    '20'),
    ('macro_carb_pct',       '50'),
    ('macro_fat_pct',        '30'),
    ('fibre_g_per_1000kcal', '14'),
    ('water_goal_glasses',   '8'),
    ('steps_goal',           '10000'),
    ('max_cycle_swing',      '0.2');

INSERT OR IGNORE INTO app_setting (key, value) VALUES
    -- Satiety prompting. See schema.sql section 18: this is an
    -- owner-authorised exception to principle 8, and 'off' restores the
    -- principle exactly.
    ('satiety_prompt',        'on'),
    -- How long after a meal to ask. Long enough that the answer is
    -- about the meal rather than about having just eaten.
    ('satiety_prompt_min',    '150'),
    -- Stop asking if it goes unanswered this long; a question nobody
    -- answers is just a notification badge.
    ('satiety_prompt_ttl_min', '120'),
    -- How many times a food combination must recur before the app
    -- names it as a meal of yours.
    ('meal_recognise_min',    '3');

-- ------------------------------------------------------------
-- Starter household measures.
--
-- Principle 7 says toGrams() returns NULL rather than inventing grams
-- for a measure you have never weighed, and that stands - it is what
-- stops the app quietly making numbers up. These rows are the escape
-- hatch the same principle already provides: user_measure.basis
-- distinguishes 'weighed' (you put it on a scale, trust it) from
-- 'estimated' (a guess, still stable, wider band), and these are
-- explicitly estimated.
--
-- Without them a new database can resolve a food and still not know
-- what "two rotis" weighs, so every entry lands pending and the app
-- looks broken on first use. With them it works immediately and says,
-- on the Measures screen, that it is guessing until you weigh yours.
--
-- INSERT OR IGNORE against the uniqueness indexes, so weighing your own
-- katori replaces this permanently and re-running seed never undoes it.
-- ------------------------------------------------------------
INSERT OR IGNORE INTO user_measure (food_id, unit_id, grams, basis, calibrated_at)
SELECT NULL, u.id, m.grams, 'estimated', datetime('now')
  -- ONLY the three the starter bank actually needs. Pre-calibrating
  -- every unit would make principle 7's guarantee - that toGrams()
  -- returns NULL rather than inventing grams - unreachable in practice
  -- and untestable, which is too high a price for saving someone one
  -- weighing. cup, tbsp and tsp stay uncalibrated on purpose.
  FROM (SELECT 'piece' AS code, 45 AS grams
        UNION ALL SELECT 'katori', 150
        UNION ALL SELECT 'glass',  200) m
  JOIN unit u ON u.code = m.code;
