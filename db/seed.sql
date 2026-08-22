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
