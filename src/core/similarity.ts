/**
 * Phrase similarity for the personal index.
 *
 * This is a port of Python difflib's SequenceMatcher.ratio(), because the
 * thresholds in the brief were reasoned about against that function and
 * swapping in a differently-scaled metric would silently re-tune them.
 *
 * It is a full scan over phrase_index, which is fine at a few hundred
 * phrases. Swap in rapidfuzz or a local embedding index when it stops
 * being fine — `bestMatch` is the interface that must not change.
 */

/** Total size of all matching blocks between a and b. */
function matchingChars(a: string, b: string): number {
  // b2j: positions of each character in b.
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < b.length; i++) {
    const arr = b2j.get(b[i]);
    if (arr) arr.push(i);
    else b2j.set(b[i], [i]);
  }

  let matched = 0;
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];

  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (k === 0) continue;
    matched += k;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  return matched;
}

/** difflib's find_longest_match, same tie-breaking (earliest i, then earliest j). */
function longestMatch(
  a: string, b: string, b2j: Map<string, number[]>,
  alo: number, ahi: number, blo: number, bhi: number,
): [number, number, number] {
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map<number, number>();

  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    for (const j of b2j.get(a[i]) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }
  return [besti, bestj, bestsize];
}

/** difflib ratio: 2 * matched / (len(a) + len(b)). Range 0..1. */
export function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  if (a === b) return 1;
  return (2 * matchingChars(a, b)) / total;
}

export interface Candidate<T> {
  key: string;
  value: T;
}

export interface MatchResult<T> {
  best: Candidate<T> | null;
  bestScore: number;
  runnerUp: Candidate<T> | null;
  runnerUpScore: number;
}

/**
 * Returns the best candidate AND the one it beat. The margin between them
 * is the part that matters: a 0.90 that beat a 0.89 is a coin flip wearing
 * a confident number, and a coin flip is exactly the false positive that
 * never gets caught.
 */
export function bestMatch<T>(phrase: string, candidates: Iterable<Candidate<T>>): MatchResult<T> {
  let best: Candidate<T> | null = null;
  let bestScore = 0;
  let runnerUp: Candidate<T> | null = null;
  let runnerUpScore = 0;

  for (const c of candidates) {
    const s = ratio(phrase, c.key);
    if (s > bestScore) {
      runnerUp = best;
      runnerUpScore = bestScore;
      best = c;
      bestScore = s;
    } else if (s > runnerUpScore) {
      runnerUp = c;
      runnerUpScore = s;
    }
  }
  return { best, bestScore, runnerUp, runnerUpScore };
}
