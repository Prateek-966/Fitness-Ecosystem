# Sync server

Serves the built PWA **and** a small Garmin sync API from one origin.

One origin is the point: a separate API host would need CORS and a widened
`connect-src`, and every widening of a CSP on a page holding months of
health data is a door you have to keep shut by hand. Same origin, no
change to the policy.

## What it is and is not

It is a **fetcher**, not a store of record. Your data still lives in your
browser's OPFS; this holds a rolling window of what Garmin last returned
so the app can pick it up, plus the session tokens needed to ask again.
Delete the server and you lose nothing but the automation.

## Why credentials live here

Garmin's Connect developer programme needs an OAuth client secret and a
webhook endpoint. A browser can hold neither: anything shipped to a page
is public, and a static site has nowhere for a push to land. Auto-pull
therefore requires a server that holds a credential and sees your health
data in transit. That is the trade, stated plainly - it is the reason the
app shipped with file import first.

Run it somewhere you control.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `SYNC_TOKEN` | for auto-sync | Bearer token the app must present. **Without it the sync API is switched off** and the app is served normally. |
| `GARMIN_EMAIL` | for auto-pull | Garmin Connect account |
| `GARMIN_PASSWORD` | for auto-pull | Garmin Connect password |
| `GARMIN_ADAPTER` | no | `connect` (default) or `fake` for local development |
| `SYNC_INTERVAL_MIN` | no | Poll interval, default 180. Garmin data updates a few times a day; polling faster earns nothing and risks rate limits. |
| `SYNC_DB` | no | Where to keep tokens and the window. Default `./data/sync.sqlite3` |
| `PORT` | no | Default 10000 (Render sets this) |

`SYNC_TOKEN` has no default and nothing is generated for you: a public
URL serving someone's sleep and heart-rate history to any unauthenticated
caller must not be reachable by omission.

Leaving it unset **disables** the sync API rather than opening it — the
routes return 503 and the app is served as usual, so food logging and CSV
import are unaffected. A token that is *present but shorter than 24
characters* still stops the process: that is a mistake being made, not a
feature being left off.

Generate one with `openssl rand -hex 32`, or use Render's **Generate**
button when adding the environment variable.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/health` | liveness. No auth, no personal data; reports `syncEnabled`. |
| `GET /api/garmin/status` | last sync, next sync, whether credentials are configured |
| `POST /api/garmin/sync` | pull now |
| `GET /api/garmin/data?since=YYYY-MM-DD` | normalised activities and days |
| everything else | the built PWA |

All `/api/garmin/*` routes require `Authorization: Bearer $SYNC_TOKEN`.
