# Functional specification

What the app does, from the outside. For how it is built see
[ARCHITECTURE.md](ARCHITECTURE.md); for algorithms see
[TECHNICAL_SPEC.md](TECHNICAL_SPEC.md).

---

## 1. Who this is for

One person. Self-hosted, local-first, technical. There is deliberately no
onboarding, no auth, no multi-tenancy, no analytics and no subscription
scaffolding. Where a decision trades simplicity for scale, simplicity wins.

## 2. The claim

Existing trackers report calorie numbers that are wrong, because the error
lives in the user's *measurement process*, not in the food database. This
app does not try to be more accurate. It tries to be **more consistent**,
and to be honest about the difference.

Three things follow:

1. **Voice logging that beats typing.** Speak a meal, logged in under three
   seconds, no confirmation screen.
2. **A personal index.** The app learns *your* food vocabulary and gets
   faster the longer you use it.
3. **A calibrated intake index, not a calorie count.** Denominated in your
   own logging units, against your own scale, reported with an error bar.

## 3. Screens

Four tabs. The UI is intentionally close to nothing.

| Tab | Contains |
|---|---|
| **Today** | mic button, typed fallback, day totals with error bars, and the day's entries **grouped by meal** |
| **Queue** | entries needing an amount; phrases not recognised. Badge = combined count |
| **Goal** | body profile, formula estimates side by side, macro budget, weekly calorie cycling, water and steps |
| **Measures** | your household measures and what each weighs |
| **Diagnostics** | acceptance criteria measured, thresholds, data import, backup |

![Today](screens/today.png)

### The day, by meal

Entries are grouped into Breakfast / Lunch / Snack / Dinner, and each
section carries a **+** that files the next entry there regardless of the
clock — logging breakfast at three in the afternoon because you forgot is
a normal thing to do.

Those sections are **your** windows, clustered from when you actually log:
first from imported history, and failing that from your own entries once
there are at least eight. Below that threshold the app shows one
undifferentiated list, because a handful of entries describes a habit no
better than a coin describes a distribution. Each header shows the derived
centre ("usually 08:15") so it is obvious the times came from you.

Two things a commercial tracker puts here that this one deliberately does
not:

- **No per-meal calorie target.** No "0 of 612 Cal". A target is a
  decision made for you, and it is out of scope until there is a
  calibrated model to derive one from. Each section shows what you *ate*,
  not what you are *allowed*.
- **No prompts to eat.** No "Don't miss lunch". An empty section says
  "nothing yet" and stops there. The brief's eighth principle is
  *never nag*.

---

## 4. Logging a meal — the main flow

1. Tap the mic. Speak: *"two rotis and one katori rajma"*.
2. Speech-to-text returns; the raw sentence is **persisted immediately**.
3. The sentence is split into items, each parsed for quantity, unit and
   food.
4. Each item is matched against your personal index.
5. Entries are written. A toast reports what happened, with **Undo** for
   5 seconds.

**There is no confirmation screen.** The entry is committed before the
toast appears. A confirm step turns a two-second gesture into a
five-second one and is the most common reason food logging stops.

### Typed fallback

A text field below the mic runs the identical parser and resolution path.
Useful when speech is unavailable (Firefox has no Web Speech API), or in
company.

### What the toast says

| Situation | Toast |
|---|---|
| All items matched and complete | `Logged roti, rajma` + elapsed ms |
| Some item lacks an amount | `Logged rajma (1 needs an amount)` |
| Some phrase unrecognised | `… · 1 queued` |
| Nothing recognised | `Not recognised — saved to the queue.` |
| Nothing parseable | `Nothing to log there.` |

Every case offers Undo, and every case is honest about what did *not*
happen.

---

## 5. The two paths

### Fast path
The phrase is in your index. Grams resolve from your calibration. The
entry lands complete. This is the target state and should be >80% of
entries after two weeks.

### Slow path
The phrase is **not** confidently recognised. Then:

- **Nothing is written to the log.** An unrecognised food is ambiguity,
  and ambiguity never becomes a guess.
- The utterance stays visibly in the Queue.
- You resolve it once — pick the food, amount and unit.
- The phrase joins your index and **is instant forever after**.

A multi-item sentence where two phrases are unrecognised produces **two
queue rows**, and the utterance closes only when the last one is settled.

---

## 6. Ambiguous is not incomplete

This distinction drives the whole product.

| | Meaning | Behaviour |
|---|---|---|
| **Ambiguous** | We do not know *what food* was meant | **Never** written to the log. Queued. |
| **Incomplete** | We know the food, not the amount | **Is** written, `status = pending_quantity` |

An incomplete entry is a known gap. A guess is an unknown error. The
first is recoverable; the second is not, because you will never notice it.

Correspondingly: **pending entries are excluded from totals, never counted
as zero.** A null quantity summed as 0 is silent under-logging — precisely
the failure the design exists to prevent. The day's card says so plainly:

> *2 entries are missing an amount, so this total is low and today is
> excluded from the model. Clear the queue to close it.*

---

## 7. The Queue

Two lists, cleared in one end-of-day pass in under a minute (criterion 4).

- **Needs an amount** — food known. Supply quantity + unit; the entry
  completes.
- **Not recognised** — one row per unmatched phrase. Search a food, set
  amount and unit, "Log and learn".

If both lists are empty, every utterance you have ever spoken has an
outcome. That is the whole of criterion 3.

---

## 8. Measures — weigh once, reuse forever

"One katori" is meaningless until pinned to *your* katori. Weigh it once;
it becomes a personal constant.

You record whether you **weighed** it or **estimated** it. Both are usable;
the difference is tracked, because a change in how you measure is a change
in measurement regime, and that is what corrupts a model.

> Accuracy is not the goal. **Stability is.** A personal constant that
> never moves beats a population average that is closer to true, because a
> constant bias cancels out of the regression and a wandering one does not.

Changing a calibration **re-derives every past entry in that unit**, and
each gets its own revision row — the change stays visible in the history
rather than quietly moving the training data.

---

## 9. Editing — nothing is overwritten

Any entry can be edited. Every change writes a revision row recording the
old value, the new value and the reason. Nothing is written over.

This is what later tells a genuine metabolic shift apart from a
correction you made three weeks after the fact.

---

## 10. Importing history

### Healthify export
Food names, portions **as written**, and timestamps. **Their calorie
figures are dropped**, and there is no column to put them in.

A different food database is a step change in bias, and that is the one
thing an adaptive TDEE model cannot cancel out. Six months of their
numbers spliced onto yours is not six months of history; it is a broken
series.

What the history *is* good for:
- seeding **candidate** phrases you already say (ranked by frequency —
  never auto-bound to a food)
- deriving **when you actually eat**, so meal slots are yours rather than
  an app's assumption

### Garmin export
Activities become `workout_session` rows plus a Garmin `session_energy`
row; wellness reports become `daily_metric` rows. Both are idempotent —
re-importing an overlapping month corrects rather than duplicates.

Garmin's calorie figure is stored as **its own estimate** and never added
to any other. Diagnostics lists when each source began, because starting a
new source partway through a series is a step change in measurement, and
that is the one thing an adaptive model cannot cancel out.

This is file import, not an API connection. Connecting to Garmin directly
requires an OAuth client secret and a webhook endpoint to receive pushes —
which means a server that holds a token and sees your health data in
transit. That is a steep price for data that arrives once a day, and it
would end the property that nothing ever leaves your device.

### Food reference data
No food data ships with the app. You load a CSV; every value is stored
with the source you named and the error band that source is good for.
INDB is the intended primary source; IFCT 2017 is personal-use licensed
and must never be committed to a repository.

---

## 10b. Goal — owner-authorised addition

Enter sex, age, height, weight (body fat only if measured), pick an
activity level and a rate, and every formula that can run reports its
estimate **side by side** — they disagree by a couple of hundred kcal on
the same body, and hiding that would claim a precision none of them has.
Constants are pinned by test to calculator.net's published output.

The day's target then appears on Today as "eaten of target" with a
progress bar, split across your meal sections weighted by how you
actually eat in each. A macro budget (editable split, balanced 20/50/30
default; fibre at 14 g/1000 kcal) sits beside it.

**Weekly cycling** redistributes the same weekly total across the days
using training load and the watch's sleep, HRV and stress against your
own rolling baselines. The weekly total is conserved — cycling changes
*when* calories fall, never *how many* — and every day carries a sentence
naming which input moved it. Swing capped at ±20%; set it to 0 to keep a
flat week. Cancelling a plan clears **today forward only**: what the
target was on a logged day is part of that day's record.

A manually set number outranks everything, per principle 8; the safety
floor warns once and never clamps.

## 11. Diagnostics — the criteria, measured

| # | Criterion | Measured as |
|---|---|---|
| 1 | Known repeat meal logged in under 3 s | median / p90 of `capture_timing.total_ms` on fast-path logs |
| 2 | Fast-path fraction > 0.8 | share of entries matched `exact_index` |
| 3 | Zero logs lost | utterances marked done with nothing to show for them — must be 0 |
| 4 | Queue clearable in a minute | open pending count |
| 5 | **30 consecutive days** | streak of local days with any utterance |

Criterion 5 is the real one. The rest are diagnostics for why it failed.

Note criterion 3 distinguishes **lost** from **queued**: a phrase waiting
in the queue is a to-do, not a failure. Only an utterance marked processed
with no entries and no undo counts as lost.

Also on this tab: threshold editing, food/history import, storage status,
and **Export backup**, which downloads the whole database as one
`.sqlite3` file. Browser storage lives in a single profile on a single
device; months of logs with no copy elsewhere is its own data-loss risk.

---

## 12. Behaviour at the edges

| Situation | Behaviour |
|---|---|
| Speech returns nothing | Utterance persisted; queued; toast says so |
| Phrase parses to nothing (*"two katoris"* — a unit with no food) | Nothing written; queued as raw text |
| Uncalibrated household unit | Entry lands `pending_quantity`, reason `unit_uncalibrated` |
| Two index phrases score nearly the same | Slow path. A near-tie is a coin flip, not a match |
| Marginal fuzzy hit | Logged **and shown with its score**, but *not* added to the index |
| Browser denies persistent storage | App works; Diagnostics states plainly that nothing is being saved |
| Offline | Everything works; the database is local. Only STT may need a network |
| No food data loaded | Every log goes to the queue — nothing to resolve against |

---

## 13. Non-goals for v0

Not built, though the schema accommodates them without migration:

Garmin *API* sync · adaptive TDEE model · exercise logger ·
micronutrient UI · recommendation engine · templates beyond what
`phrase_index` gives free · accounts · sync · sharing.

Goal setting and calorie targets, originally out of scope, were put in
scope by the owner and are built — see *Goal* below.

Garmin **file import** is built (§10) because the owner asked for it; it
needs no server and reuses the existing importer pattern. There is still
no UI reading those metrics back beyond a coverage summary — the brief
puts sleep/HRV/stress displays out of scope until there is a model to
feed.

The single largest risk to this project is scope creep.
