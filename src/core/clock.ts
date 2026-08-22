/**
 * One clock that means the same thing on the main thread and inside the
 * database worker.
 *
 * performance.now() is relative to each context's own time origin, so a
 * mic tap timed on the main thread and a commit timed in the worker are
 * not comparable. timeOrigin is absolute in both, so adding it gives a
 * shared epoch with sub-millisecond resolution — which matters when the
 * whole budget is 3000 ms.
 */
export const absNow = (): number => performance.timeOrigin + performance.now();
