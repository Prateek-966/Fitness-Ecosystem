# Nutrition log — v0

Speak a meal, it's logged. The app learns your food vocabulary, resolves
household measures against your own calibration, and reports an intake
index with an honest error bar instead of a confident calorie count.

Built to the spec in [`docs/BUILD_BRIEF.md`](docs/BUILD_BRIEF.md). The
single hypothesis under test: **can a meal be logged by voice faster than
it can be typed, and will that keep happening for 30 days?**

📚 **[Full documentation](docs/)** —
[functional spec](docs/FUNCTIONAL_SPEC.md) ·
[architecture](docs/ARCHITECTURE.md) ·
[schema](docs/SCHEMA.md) ·
[technical spec](docs/TECHNICAL_SPEC.md)

| Today | Queue | Diagnostics |
|---|---|---|
| ![Today](docs/screens/today.png) | ![Queue](docs/screens/queue.png) | ![Diagnostics](docs/screens/diagnostics.png) |

---

## Features

Everything below is built and covered by tests. Nothing here is a plan.

### Capture — the part that has to be faster than typing

| | |
|---|---|
| **Speak or type a meal** | "two rotis and a katori of rajma" lands as two entries with grams resolved. |
| **The write never blocks** | The raw utterance is committed *before* parsing, matching or anything else that can fail. A crash downstream cannot lose what you said. |
| **No model call, no network** | The parser is deterministic and local. Sub-second, offline, on a plane. |
| **It learns your vocabulary** | Every resolved phrase joins your own `phrase_index`. The second "rajma" is an exact hit. |
| **Fast path / slow path** | A known phrase writes straight through with a toast. An unknown one goes to a queue you clear in one pass — and is fast forever after. |
| **Undo, 5 seconds, non-blocking** | The toast is the confirmation screen. There isn't another one. |

### Honesty about numbers

| | |
|---|---|
| **Error bars, not false precision** | Daily totals combine per-food relative errors *in quadrature* and report `1,925 ± 30`, not `1,925`. |
| **Every number has provenance** | No nutrient value is hard-coded anywhere in the source. Each carries a `source` and a `rel_error` — 22% for a packaged label, because that is what FSSAI tolerance permits. |
| **Pending entries are excluded, never zeroed** | A quantity you haven't given yet is not zero calories. The day is marked incomplete instead of showing a finished-looking number. |
| **Edits are append-only** | Every change writes a `log_revision`. Recalibrating a measure writes one *per affected entry*. |
| **Estimates are stored, never summed** | One row per source, precedence decided at read time in a view. Double-counting is structurally impossible rather than merely avoided. |

### Household measures

| | |
|---|---|
| **Weigh once, applies forever** | Weigh your katori, your piece, your glass. One time. |
| **Retroactive recalibration** | Correcting a measure re-derives every past entry that used it, each with its own revision row. |
| **Refuses to invent grams** | A measure you have never weighed resolves to `null`, not to a guess. |
| **Per-food overrides** | A katori of rice and a katori of dal can differ, and the food-specific calibration wins. |

### Goals and targets

| | |
|---|---|
| **Three BMR formulas side by side** | Mifflin-St Jeor, Harris-Benedict and Katch-McArdle, with the disagreement shown rather than hidden behind one number. |
| **Pinned to a published calculator** | Every activity factor and the energy density are asserted against calculator.net's own output, to the figure. Two of them were wrong before that test existed. |
| **Macro budget, water, steps, goal weight** | Protein/carb/fat split, fibre per 1000 kcal, glasses, step target, target weight and rate. |
| **Per-meal targets from your own history** | Calories are divided across the day using *your* meal-slot windows, not someone's idea of when lunch is. |
| **Weekly calorie cycling** | Harder training days get more, rest days get less, and the **weekly total is conserved** — a transparent weighted sum over training load, sleep, HRV and stress, with every weight visible and adjustable. |
| **A safe floor that is never silently applied** | Below 1500 kcal (male) / 1200 (female) you are told, not clamped. |

### Garmin

| | |
|---|---|
| **Auto-sync** | The server signs in on a schedule and the app collects what it found. OAuth1 → OAuth2, tokens persisted, so a restart costs no password login. |
| **File import** | A CSV from Garmin Connect, dropped into Diagnostics. No server, no credentials. |
| **Same import path either way** | Both routes run through identical code, so every guarantee holds identically. |
| **Re-syncing corrects, never duplicates** | Idempotent on `(started_at, kind)`. Overlapping windows are the normal case. |
| **A missing metric stays missing** | A watch on the charger did not record zero steps. |
| **Sleep, stress, HRV, body battery, steps** | Plus distance, average heart rate, training load and aerobic/anaerobic effect per session. |
| **Garmin's calories stay Garmin's estimate** | Never merged with, or added to, any other estimate of the same session. |

### Meal slots, learned not assumed

| | |
|---|---|
| **Your meal times are clustered from your logs** | Exact 1-D dynamic programming, not k-means — the same data always gives the same windows. |
| **Today groups by meal** | With a `+` per meal, and a target per meal. |
| **Nothing is hard-coded** | There is no table of when dinner is. |

### Diagnostics — the app watching itself

| | |
|---|---|
| **Bias-drift detection** | `daily_logging_stats` records *how* each day was logged, not just what. A change of regime is visible before it corrupts a regression. |
| **Match review** | Every fuzzy decision is logged with its score and runner-up, ordered by closeness to the threshold, so you tune from data rather than by feel. |
| **Capture timing** | Measured, against the three-second claim. |
| **Model eligibility** | Which days are clean enough to feed an adaptive TDEE fit, marked from the day you start. |

### Where your data lives

| | |
|---|---|
| **In your browser** | SQLite compiled to WASM, persisted to OPFS, in a dedicated worker. |
| **Offline** | It is a PWA. Add it to the home screen; capture works with no network at all. |
| **Backup is a real database file** | Export a `.sqlite3` you can open with any SQLite tool. No proprietary format, no lock-in. |
| **The server is a fetcher, not a store** | Delete it and you lose the automation, not the history. |

### Deliberately absent

No ML model or LLM on the capture path. No onboarding, accounts, or
multi-tenancy. No analytics. No nudges to eat and no recommendation
engine — principle 8 says never nag. No hard-coded meal times. The
largest risk to this project is scope creep, and the brief says it has
already happened once.

---

## Running it

```sh
npm install
npm run dev            # http://localhost:5173
npm run build          # typecheck + production build
npm test               # unit tests, run under both UTC and IST
npm run test:browser   # end-to-end checks in Chromium, incl. OPFS persistence and CSP
```

Then, in the app under **Diagnostics**:

1. Load a food CSV (see *Food data* below). Nothing ships with the app.
2. Optionally import a Healthify export.
3. Under **Measures**, weigh one katori, one piece, one glass. Once.

Add it to your phone's home screen and it runs standalone.

### CLI

```sh
npm run load-indb -- data/indb.csv                  # food reference data
npm run load-indb -- data/labels.csv --source label # anything with its own provenance
npm run import-healthify -- exports/healthify.csv   # names, portions, timestamps only
npm run nightly                                     # recompute daily_logging_stats
npm run diagnostics                                 # acceptance criteria, measured
```

The CLI writes to `data/nutrition.sqlite3` (gitignored). Override with
`LOG_DB=path`.

---

## Garmin

Two ways in, and the second is why this app has a server at all.

**File import** — export a CSV from Garmin Connect, drop it into
Diagnostics. No server, no credentials, nothing to run.

**Auto-sync** — the server signs in to Garmin on a schedule and the app
collects what it found. Set `GARMIN_EMAIL` / `GARMIN_PASSWORD` on the
service, paste the `SYNC_TOKEN` into Diagnostics, done.

Auto-pull cannot be done from a browser: Garmin needs an OAuth client
secret and somewhere to push to, and a page can hold neither. So it needs
a server that holds a credential and sees your health data in transit —
which is exactly why the app shipped with file import first, and why the
server is designed to be run **on infrastructure you control**.

What the server is: a *fetcher*, holding session tokens and a rolling
90-day window. Your history still lives in your browser. Delete the
server and you lose the automation, not the data. See
[`server/README.md`](server/README.md).

Everything it pulls goes through the **same import path as a CSV**, so
every guarantee already tested holds identically — re-pulling corrects
rather than duplicates, Garmin's calorie figure stays its own estimate,
and a missing metric stays missing rather than becoming zero.

> **The Connect adapter has not run against live Garmin.** The flow was
> corrected against working open-source implementations and its shape is
> pinned by tests — the OAuth1 signing reproduces the published test
> vector byte for byte — but no real Garmin response has ever reached it.
> Every step fails loudly and separately, so the first real run names the
> broken one. Garmin's official Health API is a partner programme
> requiring approval; if you are granted it, it drops in as a second
> adapter behind the same interface. MFA accounts are refused with a
> message that says what to do.

## Deploying

**A Docker web service, not a static site.** It was a static site until
auto-pull from Garmin became a requirement: that needs somewhere to hold
a credential and run a schedule, and a browser page can hold neither. The
service serves the built app *and* the sync API from **one origin**, so
`connect-src` stays `'self'`, there is no CORS, and there is no second
host to keep locked down.

`render.yaml` is a Render Blueprint: **New → Blueprint → connect this
repo → Apply**. It sets the runtime, the health check, the disk and the
environment variables. Creating the service by hand works too, but then
the Blueprint's disk and generated token do not apply and both must be
added in the dashboard.

### Environment

| Variable | Required | What it does |
|---|---|---|
| `SYNC_TOKEN` | for sync | Bearer token the app presents. Generate with `openssl rand -hex 32`. **Without it the sync API is switched off and the app is served normally** — food logging does not depend on Garmin. A token shorter than 24 characters stops the process, because that is a mistake being made rather than a feature left off. |
| `GARMIN_EMAIL` | for sync | Your Garmin Connect login. |
| `GARMIN_PASSWORD` | for sync | Its password. |
| `SYNC_INTERVAL_MIN` | no | Default 180. Garmin publishes daily summaries a few times a day; polling faster earns nothing and spends goodwill with their rate limiter. Values under 15 are rejected. |
| `GARMIN_ADAPTER` | no | `connect` (default) or `fake`, which serves deterministic data for testing without credentials. |
| `SYNC_DB` | no | Where the server keeps tokens and the rolling window. The Dockerfile sets `/app/data/sync.sqlite3`, which is the disk mount below. |
| `STATIC_DIR` | no | Where the built app is served from. The Dockerfile sets `/app/dist`. |

Paste the same `SYNC_TOKEN` into the app under **Diagnostics → Garmin
auto-sync**. It is stored in its own `app_secret` table rather than
`app_setting`, because the snapshot the UI renders from carries every
setting and a credential must not cross that boundary.

**Add the disk**: mount `/app/data`, 1 GB. It holds the Garmin session
tokens and the rolling window. Without it a redeploy costs a fresh login
and a re-pull — not data loss, since your history is in the browser, but
avoidable.

### What reaches the logs

The host's log stream gets one line at boot and nothing else:

```
[sync] listening on 10000, adapter=connect, interval=180min, syncApi=enabled, garminCredentials=set
```

No password, no token, no measurement. Credentials are reported as
present or absent, never by value, and a test enforces it. Sync failures
are stored in the database and served over the authenticated API instead,
because a failure message can quote a Garmin response and those contain
your data.

### Running the container yourself

```sh
docker build -t nutrition-log .
docker run -p 8080:10000 -e SYNC_TOKEN=$(openssl rand -hex 32) nutrition-log
```

Node 22, no dependencies at all — the server uses only `node:http` and
`node:sqlite`, and Node strips the TypeScript annotations itself. Nothing
to install means nothing to audit. It runs as a non-root user with a
healthcheck on `/api/health`, which reports whether sync is enabled.

HTTPS is not cosmetic here: Web Speech and OPFS both require a secure
context, so the mic and persistence do not work from a plain `http://`
LAN address.

Verify a build before trusting a deploy:

```sh
npm run test:hosted   # dist/ on a dumb static server + service worker
npm run test:sync     # boots the real server, drives the app over a socket
```

`test:sync` is the tier that matters most: it runs the server exactly as
the Dockerfile does. Node's strip-only TypeScript mode rejects things
vitest's transpiler accepts, and that difference once shipped a container
that crash-looped on boot while every unit test passed.

> **A free-tier web service sleeps after ~15 minutes idle** and
> cold-starts in roughly 50 seconds — and a sleeping service does not run
> its sync schedule. Upgrade the instance if the automation matters more
> than the cost.

---

## Stack, and why

A **mobile PWA**: Web Speech API for STT, SQLite compiled to WASM with
OPFS persistence, plain TypeScript, no framework. This is what the brief
recommended and nothing came up to justify deviating — it tests the
hypothesis in days and installs to a phone with no store listing.

**SQLite runs in a dedicated worker.** This is the one structural thing
that isn't obvious from the brief, and it isn't a preference. OPFS
*synchronous access handles* — the only way to get durable local SQLite
without asking the host to send COOP/COEP headers — do not exist on the
main thread in any current browser. A main-thread database opens fine,
logs fine, and then loses the day on reload. Everything in `src/core/`
stays synchronous inside that worker, so the capture write still never
yields; only the UI's view of it is a promise.

If Web Speech latency proves unacceptable on Android, the fallback named
in the brief is React Native + Expo with on-device recognition. Nothing
outside `src/app/speech.ts` would change: the core takes a string.

```
src/core/       pure logic, no DOM, no browser — this is what the tests cover
src/platform/   two Db implementations: node:sqlite (tests, CLI), sqlite-wasm (app)
src/worker/     the database worker — owns the connection, runs the core
src/app/        UI: async proxy to the worker, views, mic, toast
db/             schema.sql (given, plus additive v0 tables) and seed.sql
```

---

## What v0 does

- [x] Voice capture → on-device STT → raw utterance persisted before anything else
- [x] Deterministic local parser — **no model call on the fast path**
- [x] Fuzzy match against `phrase_index`, your own index
- [x] Fast path: match → grams → write → toast. No confirmation screen
- [x] Slow path: unmatched food → resolve by hand → written back, fast forever after
- [x] Pending-quantity queue, clearable in one pass
- [x] Undo toast, 5 s, non-blocking
- [x] Manual edit of any entry, via `log_revision`
- [x] Unit calibration screen — weigh once, store grams, re-derive past entries
- [x] Healthify import — names, portions, timestamps; **no calorie figures**
- [x] Daily totals with error bars combined in quadrature
- [x] `daily_logging_stats` populated nightly
- [x] `match_score` logged on every entry from day one, plus a full `match_audit`

**Built later, owner-authorised:** Garmin file import (activities and
wellness), goal setting with side-by-side formula estimates pinned to
calculator.net's output, macro budgets, per-meal targets weighted by your
own history, and weekly calorie cycling that conserves the weekly total.

**Still not built, by design:** the adaptive TDEE model (it needs ~6
weeks of clean logging before there is anything to fit), the exercise
logger, micronutrient UI, any recommendation engine.

---

## The design principles, and where they live in the code

Each of these has tests that fail if it is broken.

**1. Consistency beats accuracy.** Normalisation is stable above all else
(`normalise` in `parse.ts`); `daily_logging_stats` records *how* each day
was logged, not just what, so a change of regime is visible before it
corrupts a regression.

**2. Capture never blocks.** `capture()` writes the utterance outside the
resolution transaction. A parse failure, a match failure, a thrown error
downstream — none of them can roll it back.

**3. Ambiguous ≠ incomplete.** An unrecognised food never reaches
`log_entry`. A recognised food with no quantity does, as
`pending_quantity`. `parse()` returns *nothing* for "two katoris" — a unit
with no food is ambiguity, not a gap.

**4. Pending entries are excluded, never zeroed.** `v_daily_totals`
filters on `status = 'resolved'`, and the UI says the day is incomplete
rather than showing a number that looks finished.

**5. Every number carries provenance.** No nutrient value appears in any
source file. Everything comes through `foodimport.ts` from a file you
supplied, with its `source` and a `rel_error` — 22% for a label, because
that is what FSSAI tolerance actually permits.

**6. Edits are append-only.** `revise()` writes a `log_revision` row for
every change. Recalibrating a measure writes one *per affected entry*.

**7. Household measures resolve against your calibration.** `toGrams()`
prefers a food-specific measure, then a general one, and returns `null`
rather than inventing grams for a measure you have never weighed.

**8. Default permissive, surface consequences, never block.** Every
threshold is editable in the app. Nothing is locked, nothing nags.

**9. Store every estimate, sum none of them.** `session_energy` holds one
row per source; `v_session_energy` emits exactly one row per session.
Double-counting is structurally impossible, not merely discouraged.

---

## Three decisions worth your sign-off

The brief says not to "improve" the design without asking. These are the
three places I made a call. All three are reversible; two are settings.

**1. Auto-learn is gated above the match threshold.**
The reference `resolve.py` writes back to `phrase_index` on every accepted
match, including a fuzzy one that just cleared 0.82. That makes a marginal
match permanent: next time it is an *exact* hit at score 1.0, and the
false positive compounds silently — the exact failure mode the brief says
you will never catch. So there are now two thresholds:
`fuzzy_threshold` (0.82) decides whether to log it, `auto_learn_threshold`
(0.93) decides whether to *remember* it. Below the second, the entry lands
and shows a `~0.86` pill in the day list, and the decision is in
`v_match_review` for you to accept or not. Set `auto_learn_threshold` to
`fuzzy_threshold` to get the original behaviour.

**2. A fuzzy win must beat its runner-up by a margin** (`min_match_margin`,
0.05). "paneer bhurjee" scoring 0.88 against *both* "paneer bhurji" and
"paneer burji" is a coin flip wearing a confident number. Set to 0 to
disable.

**3. Imported Healthify rows never become `log_entry` rows.**
They land in `imported_entry`, which has no nutrient column at all. The
brief says the history is "for pattern seeding, not for numbers", and this
is the most literal reading: the history seeds `phrase_index` candidates
and derives your meal-slot windows, and nothing else. If you would rather
have the six months in the log itself, that is a different call and it
changes what days are model-eligible.

Also worth flagging: `phraseCandidates()` **suggests** but never binds.
Attaching a name from someone else's database to a food is a food-identity
decision, and those are never made automatically.

---

## Fixes to the reference implementation

Found while porting `resolve.py` and covered by tests:

- **`UNIQUE (food_id, unit_id)` cannot dedupe the general calibration.**
  SQLite treats NULLs as distinct inside a UNIQUE constraint, so
  recalibrating "a katori" appended a second row and every lookup kept
  returning the stale grams — a household measure that silently refuses to
  move. Fixed with a partial unique index on `unit_id WHERE food_id IS NULL`.
- **`revise()` tripped its own CHECK constraint.** Clearing a quantity on a
  row still marked `resolved` violates the resolved-rows-are-complete
  invariant mid-statement, even though the end state is legal. It now drops
  to pending first.
- **An utterance that parsed to nothing was marked processed.** `"mmm"`
  set `processed_at` with no entries and no queue position — a silently
  lost log, against acceptance criterion 3. `processed_at` is now set only
  when every parsed item landed.
- **`revise()` interpolated the field name into SQL.** Now whitelisted.
- **`-is$` ate the plurals that matter most.** A guard meant for "basis"
  was turning "rotis" into "rotis" instead of "roti" — the very first
  phrase the brief names. Now an explicit list.
- **Meal-slot k-means merged a real snack into lunch and split dinner.**
  Quantile seeding puts two centres inside whichever occasion you log most.
  Replaced with exact 1-D dynamic programming, which is cheap at this size
  and gives the same windows for the same data every time.

Found in a second review pass, also tested:

- **Timestamps were stored as UTC.** The schema says "ISO8601, device
  local" and every downstream consumer — `date(eaten_at)` day grouping,
  the streak count, meal-slot windows — assumes it. Stored as UTC, an IST
  dinner logged at 00:30 landed on yesterday. Everything now goes through
  `localIso()`, and the test suite runs twice (`TZ=UTC` and
  `TZ=Asia/Kolkata`) with an explicit midnight-boundary regression test.
- **Completing an entry erased how it was matched.** Supplying a missing
  amount rewrote `match_method` to `'manual'`, so a fast-path entry
  stopped counting toward `fastpath_fraction` — quietly corrupting
  acceptance criterion 2. Only a food-identity change is a re-match now.
- **`weighed_fraction` double-counted entries.** A LEFT JOIN onto
  `user_measure` fans out when a unit has both a general and a
  food-specific calibration; the fraction now reads the basis of the one
  measure that actually resolved the entry.
- **Re-importing a Healthify export duplicated portion-less rows.** The
  same NULLs-are-distinct trap as the calibration table, one table over.
  Deduped through a `COALESCE` expression index (applied as a migration in
  `seed.sql`, which runs on every open).
- **A two-item slow-path utterance could only ever resolve its first
  item.** The queue is now one row per unmatched *phrase*, and the
  utterance closes only when the last phrase is settled.
- **Re-teaching a phrase kept the old food.** `learn()`'s upsert ignored
  the caller's food on conflict, so a manual correction was silently
  discarded and the index repeated the mistake forever.

### Security hardening

- `npm audit` clean (vitest 2→4 removed a critical advisory chain).
- A build-time CSP (`default-src 'self'`, no inline script or style) on a
  page that holds months of personal health data — defence in depth; the
  code has no HTML-injection sinks and makes no cross-origin requests.
- The service worker is network-first for navigations: the old cache-first
  shell could never deliver an update after a redeploy.
- `%`/`_` are escaped in food search, so LIKE input is literal.
- Malformed dates in a Healthify export are skipped, never guessed onto a
  day — day boundaries are model input.
- **Export backup** (Diagnostics) downloads the whole database as one
  `.sqlite3` file; OPFS lives in a single browser profile, and months of
  logs with no copy anywhere else would be its own data-loss bug.

---

## Food data

**None ships with this repository, and `data/` is gitignored.**

- **INDB** (Indian Nutrient Databank) is the intended primary source: open
  access, ~1,095 items plus ~1,014 recipes with ingredient decomposition.
- **IFCT 2017** is reference only. It is personal-use licensed — load it
  locally if you want it, but nothing derived from it may be committed.

The loader takes any CSV with a food-name column and at least one
recognised nutrient column, and records which source you told it the file
came from. A blank cell is treated as missing, never as zero.

---

## Tuning

`FUZZY_THRESHOLD` was a placeholder in the brief and it still is. It lives
in `app_setting`, editable in the app, because a placeholder you have to
redeploy to change never gets tuned.

When there is real data, `v_match_review` orders every fuzzy decision by
how close it came to the threshold — accepted and rejected both, with the
runner-up it beat and by how much. Tune from that, not from vibes.

`fuzzy_lookup` is a full scan with a difflib-compatible ratio. Fine at a
few hundred phrases. `bestMatch()` in `similarity.ts` is the interface to
keep when it stops being fine.
