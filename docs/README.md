# Documentation

Start here if you have never seen this project.

| Document | Read it for |
|---|---|
| **[BUILD_BRIEF.md](BUILD_BRIEF.md)** | The original spec. Why the product exists, the nine design principles, what is in and out of scope. **The source of intent** — everything else serves it. |
| **[FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md)** | What the app does, from the outside. Screens, flows, edge cases, acceptance criteria. |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | How it is put together. Layers, the worker boundary, the capture path, where each principle is enforced. |
| **[SCHEMA.md](SCHEMA.md)** | Every table, what it defends, and the views and indexes that matter. |
| **[TECHNICAL_SPEC.md](TECHNICAL_SPEC.md)** | The algorithms: parser, matcher, grams, revisions, statistics, clustering, imports, security. |
| **[../README.md](../README.md)** | Running it, deploying it, and the decisions that need the owner's sign-off. |

## Suggested order

**To understand the product:** BUILD_BRIEF → FUNCTIONAL_SPEC.

**To change the code:** ARCHITECTURE → SCHEMA → the relevant part of
TECHNICAL_SPEC. Then read the tests for whatever you are touching; they
are written to state invariants rather than to cover lines.

**To review the data model:** SCHEMA, then [`db/schema.sql`](../db/schema.sql),
which is the authority and is heavily commented.

## Reference copies

`resolve.reference.py` and `schema.reference.sql` are the originals supplied
with the brief, kept verbatim for comparison. The shipped implementation
differs from `resolve.reference.py` in several places — each difference is
listed under *"Fixes to the reference implementation"* in the root README,
and each carries a regression test.

## A note on these documents

They are checked against the code by `tests/docs.test.ts`, which fails if a
table, view or setting exists without being documented here. Documentation
that drifts is worse than none, so drift is a test failure rather than a
discovery six months later.
