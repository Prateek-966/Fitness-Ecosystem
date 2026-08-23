# Orientation

A personal nutrition and training log. One user, self-hosted. Speak a
meal, it is logged.

**Read this first, then [`docs/PROGRESS.md`](docs/PROGRESS.md) for where
things stand.** The full specs are in [`docs/`](docs/).

---

## The thesis, in one paragraph

Commercial trackers report calorie numbers that are wrong, because the
error lives in the user's *measurement process*, not in the food
database. This app does not try to be more accurate. It tries to be more
**consistent**, and to be honest about the difference. A stable
systematic bias cancels out of an adaptive TDEE regression; a wandering
one does not. Almost every design decision here follows from that
sentence.

## Non-negotiables

These come from `docs/BUILD_BRIEF.md`, which is the owner's spec. Each
has tests that fail if broken. **Do not "improve" them without asking.**

1. **Consistency beats accuracy.** The same food must always resolve to
   the same entry.
2. **Capture never blocks.** The raw utterance is committed before
   parsing, matching, or anything that can fail.
3. **Ambiguous ≠ incomplete.** An unrecognised *food* never reaches
   `log_entry`. A known food with no *amount* does, as
   `pending_quantity`.
4. **Pending entries are excluded, never zeroed.** A null quantity summed
   as 0 is silent under-logging.
5. **Every number carries provenance.** No nutrient value is ever
   hard-coded; each has a `source` and a `rel_error`.
6. **Edits are append-only.** Every change writes a `log_revision`.
7. **Household measures resolve against the user's own calibration.**
   Stability beats accuracy; `toGrams()` returns null rather than
   inventing grams.
8. **Default permissive, surface consequences, never block.** Never
   refuse, never nag, never clamp a value the user set.
9. **Store every estimate, sum none.** One row per source; precedence is
   a *read-time* decision in a view.

## Recurring lessons this codebase has already paid for

- **SQLite treats NULLs as distinct in UNIQUE.** This bit three separate
  tables. Dedupe through a `COALESCE(...)` expression index or a partial
  index, never a plain UNIQUE with a nullable column.
- **Timestamps are device-local wall time, no zone suffix** (`localIso()`
  in `src/core/clock.ts`). The schema says so and every consumer assumes
  it. Storing UTC put an IST 00:30 dinner on the previous day. **The unit
  suite runs twice, `TZ=UTC` and `TZ=Asia/Kolkata`** — keep it that way.
- **The server is UTC throughout** (`server/src/poller.ts`), deliberately
  the opposite convention. Do not mix the two in one file; that was a
  real bug.
- **vitest's transpiler is not the production runtime.** Constructor
  parameter properties pass every unit test and crash the container,
  which runs Node's strip-only TypeScript mode. `npm run test:sync` boots
  the server the way the Dockerfile does — that is the only tier that
  catches this class of bug.
- **A missing measurement is missing, never zero.** A watch on the
  charger did not record zero steps.
- **CSP blocks inline `style` attributes.** `h()` routes styles through
  CSSOM; a test fails if a `style=` attribute reappears.

## Layout

```
src/core/       pure logic. No DOM, no browser API, no I/O except a Db handle.
src/platform/   two Db implementations: node:sqlite (tests/CLI), sqlite-wasm (app).
src/worker/     the database worker. Owns the connection, runs the core.
src/app/        UI. Talks to the worker; never touches SQL.
server/         sync server: serves the built app AND the Garmin API, one origin.
db/             schema.sql + seed.sql — the source of truth for the data model.
scripts/        CLI entry points against the same core.
docs/           specs. PROGRESS.md is the state of play.
```

**Dependencies point downward only.** `core` may not import from `app`,
`worker`, or `platform`. That rule is what makes ~290 fast tests possible
instead of a handful of slow ones.

## Verifying

```sh
npm test              # unit suite, run under BOTH TZ=UTC and TZ=Asia/Kolkata
npm run test:browser  # real Chromium against the built app
npm run test:hosted   # dist/ on a dumb static server + service worker
npm run test:sync     # boots the real server, drives the app over a socket
npm run test:all      # all of the above
npm audit             # must stay at 0
```

`tests/docs.test.ts` is a **documentation drift guard**: it fails if a
table, view, uniqueness index or setting exists without being documented,
if a documented relation no longer exists, or if the non-goals list
disclaims a feature that is actually built. When you add a relation,
document it in `docs/SCHEMA.md` in the same change.

## House style

- Comments explain **why**, not what. Most of the interesting comments in
  this repo record a decision or a bug already paid for — keep that.
- Tests are written to state invariants, not to cover lines. Their names
  are sentences.
- Every fix carries a regression test.
- Prefer an exact algorithm over a heuristic when the data is small
  (meal-slot clustering is exact 1-D DP, not k-means, for this reason).

## Things that are deliberately NOT here

Do not add them without the owner asking:

- Any ML model, LLM call, or network request on the capture path.
- Onboarding, auth, multi-tenancy, analytics, subscription scaffolding.
- Nudges or prompts to eat. Principle 8 says never nag.
- A recommendation engine.
- Hard-coded meal times. They are clustered from the user's own logs.

The single largest risk to this project is scope creep, and the brief
says it has already happened once.
