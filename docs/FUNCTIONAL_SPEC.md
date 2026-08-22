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
| **Today** | mic button, typed fallback, day totals with error bars, the day's entries |
| **Queue** | entries needing an amount; phrases not recognised. Badge = combined count |
| **Measures** | your household measures and what each weighs |
| **Diagnostics** | acceptance criteria measured, thresholds, data import, backup |

![Today](screens/today.png)

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

### Food reference data
No food data ships with the app. You load a CSV; every value is stored
with the source you named and the error band that source is good for.
INDB is the intended primary source; IFCT 2017 is personal-use licensed
and must never be committed to a repository.

---

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

Garmin ingestion · adaptive TDEE model · goals and targets · exercise
logger · micronutrient UI · recommendation engine · templates beyond what
`phrase_index` gives free · accounts · sync · sharing.

The single largest risk to this project is scope creep.
