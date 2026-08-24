# State of play

Where this project actually stands. Read [`../CLAUDE.md`](../CLAUDE.md)
first for the rules; this file is the ledger.

**Last updated:** after the Garmin login rewrite and the schema-upgrade fix.
**Branch:** `claude/build-fl0w1l`, fast-forwarded to `main` so Render
redeploys.

---

## 1. What it is now

A personal nutrition and training log, deployed as a **Docker web service
on Render** that serves the built PWA *and* a Garmin sync API from one
origin.

It began as a pure static site. It stopped being one when the owner made
auto-pull from Garmin a core requirement: that needs somewhere to hold an
OAuth credential and run a schedule, and a browser page can hold neither.
**Do not "restore" the static site** — the server is load-bearing now.
One origin is also deliberate: a separate API host would need CORS and a
widened `connect-src`.

```
Browser (the store of record)          Server (a fetcher)
  UI ─ postMessage ─ worker ─ SQLite     serves dist/ + /api/garmin/*
                        │                pulls Garmin on a schedule
                      OPFS               holds tokens + 90-day window
                        ▲                          │
                        └────── /api/garmin/data ──┘
```

Your history lives in the browser. Delete the server and you lose the
automation, not the data.

---

## 2. Built and verified

| Area | State |
|---|---|
| Voice + typed capture, sub-second, no model call | done |
| Deterministic parser (quantity/unit/food) | done |
| Personal phrase index, fast path + slow path | done |
| Household-measure calibration, retroactive revisions | done |
| Append-only revisions | done |
| Daily totals with errors in quadrature | done |
| `daily_logging_stats` (bias-drift detector) | done |
| Healthify import (names/portions/timestamps only) | done |
| Food reference loading from file, with provenance | done |
| Meal-slot windows clustered from own behaviour | done |
| Meal-grouped Today view, per-meal `+` | done |
| **Goal setting** (Mifflin / Harris / Katch) | done, owner-authorised |
| Macro budget, water, steps, goal weight | done |
| **Weekly calorie cycling** from watch metrics | done |
| **Cross-day insights** (weight trend, week profile, training-day intake, nutrient habits, revealed preference) | done |
| **Decision layer** — "what should I do right now" | done, owner-authorised |
| Projection with honest intervals (stage 3) | done |
| **The learning loop** (`decision_log`, stage 5) | done |
| Food-to-sleep/stress association, on request | done |
| Meals as entities (`meal`, `meal_component`) | schema done, logic pending |
| Satiety capture | schema done, logic pending |
| **Garmin file import** (activities + wellness) | done |
| **Garmin auto-sync server** | done — *see §4* |
| Garmin login rewritten against working references | done |
| Session tokens persisted across restarts | done |
| Backup export (`.sqlite3`) | done |
| PWA, offline shell, OPFS persistence | done |

**Test posture:** ~291 unit tests run under **two timezones**, 21 hosted
browser checks, 8 sync integration checks over a real socket, `npm audit`
at 0. `npm run test:all` runs everything.

---

## 3. Decisions worth not re-litigating

| Decision | Why |
|---|---|
| SQLite in a **worker**, not the main thread | OPFS sync access handles are worker-only. A main-thread DB works and then loses everything on reload. |
| **Web service**, not static site | Auto-pull needs a credential and a schedule. |
| **One origin** for app + API | No CORS; `connect-src 'self'` stays narrow. |
| Timestamps **local** in the app, **UTC** in the server | The app answers "what day was this" (wall-clock); the server coordinates across hosts. Mixing them was a real bug. |
| Exact 1-D DP for meal slots, not k-means | Quantile seeding merged a real snack into lunch and split dinner. Same data must give same windows. |
| difflib-compatible similarity, not a new metric | The brief's thresholds were reasoned against that function. |
| `auto_learn_threshold` separate from `fuzzy_threshold` | A marginal fuzzy hit may be logged once, but must not become an *exact* match forever. |
| Calorie cycling is a **transparent weighted sum**, not a model | An app whose thesis is provenance cannot produce its most consequential number from a black box. Also: no training data exists yet. |
| Garmin kcal never merged with a MET estimate | Different estimators. `v_session_energy` emits one row per session. |
| Target precedence **inverted** vs `session_energy` | Measurements: best instrument wins. Decisions: the user wins. |
| Imported Healthify rows never become `log_entry` | A different food database is a step change in bias. |
| Sync token in `app_secret`, not `app_setting` | The UI snapshot carries every setting; a credential must not cross that boundary. |
| The OAuth1 consumer credential is **pinned**, not fetched | Every client in this space pulls it from a third-party S3 bucket at login, which puts someone outside both the owner and Garmin in a position to supply the key that signs requests against the account. The fetch survives as a fallback for the day Garmin rotates it. |
| `schema.sql` is idempotent and always runs | It used to run only when a sentinel table was absent, so a table added later never reached an existing database. That shipped as `no such table: body_profile` in a live browser. Views are dropped and recreated; a stale precedence view returns a confidently wrong number, which is worse than an error. |
| The app's own data stays in the browser, not Supabase | Non-negotiable #2 is *capture never blocks*. A network round-trip on the capture path means speaking a meal offline either blocks or is lost. |

---

## 4. Known limitations — read before trusting

1. **The Garmin Connect login flow has never run against live Garmin.**
   Still true, but much less alarming than it was. The flow was
   **rewritten against garth and cyberjunky's python-garminconnect**
   after the owner supplied them, which found four defects that would
   each have failed on the first real sync:
   - it scraped an HTML form for a `_csrf` token; Garmin moved to a JSON
     mobile API (`POST /sso/mobile/api/login`);
   - it skipped the **entire OAuth1 leg**. The real sequence is ticket →
     `oauth-service/oauth/preauthorized` → `exchange/user/2.0`, and both
     of the latter must carry an HMAC-SHA1 signature;
   - it omitted `displayName` from the daily URLs, which **403s** rather
     than 404s and reads like an auth failure;
   - it guessed a three-hour token lifetime instead of reading
     `expires_in`.

   The signing is the one part provable without Garmin, and it is
   proved: the published Twitter OAuth1 vector reproduces exactly
   (`server/tests/oauth1.test.ts`). The flow's *shape* is pinned by
   `server/tests/connect.test.ts`. **Verifying it against a real account
   is still the highest-priority thing to do on a real deploy.**
2. **MFA Garmin accounts are not supported** — the adapter detects and
   refuses with a clear message. The owner confirmed this account does
   not use MFA. Garmin *does* support it (`MFA_REQUIRED`, then a code to
   `/mobile/api/mfa/verifyCode`); adding it needs an interactive prompt
   in the UI, not a change to the adapter.
3. **Garmin's official Health API is a partner programme** requiring
   approval. If granted, it drops in as a second adapter against the same
   interface without touching anything else.
4. **A free-tier Render service sleeps after ~15 min idle**, which also
   stops the sync schedule, and cold-starts in ~50 s.
   *(Confirmed on the live service.)*
5. **The service is manually created, not Blueprint-managed**, so
   `render.yaml`'s `generateValue: true` for `SYNC_TOKEN` does not apply
   — the variable must be added by hand in the dashboard. Without it the
   app still runs; only auto-sync is off.
6. **The adaptive TDEE model is not built.** `energy_target` already
   accepts `source = 'adaptive'` at the top of the formula precedence,
   and `daily_logging_stats.model_eligible` already marks which days are
   clean enough to feed it. It needs ~4–6 weeks of consistent logging
   before there is anything to fit.
7. **No food data ships.** The app is empty until a CSV is loaded.
8. The deployed URL could not be reached from the development
   environment (egress proxy), so **live deploys have never been
   verified from here** — only the build, and the server run locally the
   way the container runs it. Note that `raw.githubusercontent.com`
   *is* reachable, which is how the Garmin references were read.
9. **The server store is still SQLite on a Render disk** that does not
   exist — the service has no disk attached, so `/app/data` is wiped on
   every deploy. The app's own data now replicates to Supabase; the
   *server's* Garmin token and rolling window do not yet.
10. **Replication is push-only.** Changes go up; nothing comes back
   down. That gives durability and a queryable copy, not multi-device
   editing — logging on a second device would not see the first one's
   history. Pull and merge is the next piece.

---

## 5. Pending / next

Roughly in priority order. None of these are started.

1. **Verify the Garmin login against a real account.** Deploy, set
   `GARMIN_EMAIL`/`GARMIN_PASSWORD`, press *Sync now*, read the error.
   Fix `server/src/garmin/connect.ts` — it is designed so only that file
   should be wrong, and each step names itself when it fails.
2. **Move the server store to Supabase** (owner asked; see §4.9). The
   window and the tokens only — not the app's data.
3. **An always-visible sync-staleness indicator** (owner chose this over
   a quiet badge). Watch data going stale silently skews calorie
   cycling, which is the actual risk.
2. **Answer the actual v0 question:** 30 consecutive days of logging.
   Everything else is diagnostics for why that failed. Resist adding
   features until this is answered.
3. **Tune `fuzzy_threshold` from real data**, using `v_match_review`
   (ordered by closeness to the threshold) rather than by feel.
4. **Adaptive TDEE model** once there are ~6 weeks of `model_eligible`
   days. Slots in as `energy_target.source = 'adaptive'`.
5. Garmin token refresh / session persistence across restarts (currently
   re-logs in after 3 h).
6. MET-based estimate as a second `session_energy` source, to exercise
   the precedence view with real disagreement.
7. Micronutrient UI (fields exist, no UI, by design).

---

## 6. Where things live

**Core logic** (`src/core/`, pure, no DOM):
`parse` · `similarity` · `resolve` · `mealslot` · `stats` · `totals` ·
`energy` (BMR/targets/macros) · `cycling` (weekly redistribution) ·
`insights` (cross-day aggregation, trends, projection) ·
`advice` (the decision layer) · `learn` (the feedback loop) ·
`reactions` (food-to-metric association) · `replicate` (change queue) ·
`garmin` (file import) · `sync` (server client) · `healthify` ·
`foodimport` · `settings` · `clock` · `timing` · `csv` · `db`

**App** (`src/app/`): `views` · `store` (worker proxy) · `protocol` ·
`speech` · `dom` · `sheet` · `toast`. Entry: `src/main.ts`.
Worker: `src/worker/db-worker.ts`.

**Server** (`server/src/`): `index` (HTTP) · `config` · `store` ·
`poller` · `garmin/{client,connect,fake}` · `supabase` · `replica`.

**Data model:** `db/schema.sql` is authoritative and heavily commented.
`db/seed.sql` runs on every open and carries additive migrations.

**Tests:** `tests/*.test.ts` (unit), `server/tests/` (server),
`tests/browser/*.mjs` (Chromium). `tests/docs.test.ts` guards these docs
against drift.

---

## 7. If you are a fresh session

1. Read `CLAUDE.md`, then this file.
2. `npm install && npm run test:all` — confirm the ground is solid before
   changing anything.
3. Check `git log --oneline -15`; commit messages here record *why*, and
   are worth reading.
4. The owner is technical, self-hosting, and the only user. They have
   overridden the brief twice (goal setting in scope; Garmin auto-pull as
   a core requirement) — both are recorded above. Where this file and the
   brief disagree, **this file is newer**.
