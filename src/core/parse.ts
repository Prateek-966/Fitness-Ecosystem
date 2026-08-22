/**
 * Deterministic local parser: utterance text -> (quantity, unit, food phrase).
 *
 * No model call, ever, on this path. Regex over number words and unit
 * words is enough for the shapes that actually get spoken — "two rotis",
 * "60g atta", "one katori rajma" — and it is the difference between a
 * sub-second log and a network round trip.
 *
 * When this parser is unsure it returns LESS, not a guess. An item with a
 * null quantity is a known gap the log can carry. A wrong quantity is not.
 */

export interface ParsedItem {
  /** Normalised food phrase: lowercase, punctuation stripped, singularised. */
  phrase: string;
  /** Exactly what was said. Kept for the audit trail and the slow path. */
  rawPhrase: string;
  quantity: number | null;
  unitCode: string | null;
}

/** Spoken unit -> canonical unit.code. */
const UNIT_WORDS: Record<string, string> = {
  g: 'g', gram: 'g', grams: 'g', gm: 'g', gms: 'g', gramme: 'g', grammes: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  katori: 'katori', katoris: 'katori', bowl: 'katori', bowls: 'katori',
  cup: 'cup', cups: 'cup',
  glass: 'glass', glasses: 'glass',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece',
  plate: 'plate', plates: 'plate',
  slice: 'slice', slices: 'slice',
};

/**
 * "no"/"nos" means "pieces" in Indian usage ("2 no idli") but it is also
 * the most common negation word in English. Only honoured when a number
 * was already parsed, so "no sugar" never becomes a piece of sugar.
 */
const QUANTITY_GATED_UNITS: Record<string, string> = { no: 'piece', nos: 'piece' };

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
  half: 0.5, quarter: 0.25,
  a: 1, an: 1,
};

/** Absolute units expressed in a multiple of the stored base unit. */
const UNIT_SCALE: Record<string, { code: string; factor: number }> = {
  kg: { code: 'g', factor: 1000 },
  l: { code: 'ml', factor: 1000 },
};

/**
 * Rewrites spoken fraction phrases into digits BEFORE the utterance is
 * split on "and". Without this, "one and a half rotis" splits into "one"
 * and "a half rotis" and loses the integer part.
 */
const FRACTION_PHRASES: Array<[RegExp, string]> = [
  [/\b(a|one)\s+and\s+a\s+half\b/g, '1.5'],
  [/\btwo\s+and\s+a\s+half\b/g, '2.5'],
  [/\bthree\s+and\s+a\s+half\b/g, '3.5'],
  [/\bone\s+and\s+a\s+quarter\b/g, '1.25'],
  [/\bhalf\s+a\b/g, '0.5'],
  [/\bhalf\s+of\s+a\b/g, '0.5'],
  [/\ba\s+half\b/g, '0.5'],
  [/\ba\s+quarter\s+of\s+a\b/g, '0.25'],
  [/\b1\/2\b/g, '0.5'],
  [/\b1\/4\b/g, '0.25'],
  [/\b3\/4\b/g, '0.75'],
  [/½/g, '0.5'],
  [/¼/g, '0.25'],
  [/¾/g, '0.75'],
];

/** Words that carry no food meaning at the head of a phrase. */
const LEADING_FILLER = /^(?:of|some|a|an|the|my|and)\s+/;

const SPLIT = /\s*(?:,|;|\band\b|\bwith\b|\bplus\b|\balso\b)\s*/;

/**
 * Unit patterns, compiled once. Longest spelling first, so "grams" is not
 * shadowed by "g". The capture path runs this on every utterance; there is
 * no reason for it to rebuild forty regexes per chunk.
 */
const byLength = (a: string, b: string) => b.length - a.length;
const unitPattern = (word: string) => new RegExp(`^${word}\\b\\s*(?:of\\s+)?`);
const UNIT_PATTERNS = Object.keys(UNIT_WORDS).sort(byLength)
  .map((w) => ({ code: UNIT_WORDS[w], re: unitPattern(w) }));
const GATED_PATTERNS = Object.keys(QUANTITY_GATED_UNITS).sort(byLength)
  .map((w) => ({ code: QUANTITY_GATED_UNITS[w], re: unitPattern(w) }));

export function parse(rawText: string): ParsedItem[] {
  let text = rawText.toLowerCase();
  for (const [re, sub] of FRACTION_PHRASES) text = text.replace(re, sub);

  const items: ParsedItem[] = [];
  for (const rawChunk of text.split(SPLIT)) {
    const item = parseChunk(rawChunk);
    if (item) items.push(item);
  }
  return items;
}

function parseChunk(rawChunk: string): ParsedItem | null {
  let chunk = rawChunk.trim();
  if (!chunk) return null;

  const original = chunk;
  let quantity: number | null = null;
  let unitCode: string | null = null;

  // Quantity: digits first, then number words. "2.5", "two", "half".
  const digits = /^(\d+(?:\.\d+)?)\s*/.exec(chunk);
  if (digits) {
    quantity = parseFloat(digits[1]);
    chunk = chunk.slice(digits[0].length).trim();
  } else {
    const first = chunk.split(/\s+/, 1)[0];
    if (first in NUMBER_WORDS) {
      // "a"/"an" only count as a quantity when something follows them.
      const rest = chunk.slice(first.length).trim();
      if (rest) {
        quantity = NUMBER_WORDS[first];
        chunk = rest;
      }
    }
  }

  // Quantity-gated spellings ("2 no idli") are only in play after a number.
  const patterns = quantity !== null ? [...GATED_PATTERNS, ...UNIT_PATTERNS] : UNIT_PATTERNS;
  for (const { code, re } of patterns) {
    const m = re.exec(chunk);
    if (!m) continue;
    unitCode = code;
    chunk = chunk.slice(m[0].length).trim();
    break;
  }

  // A bare unit with nothing after it is not a food. "two katoris" alone
  // says nothing about what was in the katori — that is ambiguous, and
  // ambiguous never reaches the log.
  if (!chunk) return null;

  chunk = chunk.replace(LEADING_FILLER, '').trim();
  if (!chunk) return null;

  // kg/l are absolute units the database does not store; fold them into
  // g/ml here so nothing downstream has to know they exist.
  if (unitCode && unitCode in UNIT_SCALE && quantity !== null) {
    const scale = UNIT_SCALE[unitCode];
    quantity = quantity * scale.factor;
    unitCode = scale.code;
  } else if (unitCode && unitCode in UNIT_SCALE) {
    unitCode = UNIT_SCALE[unitCode].code;
  }

  const phrase = normalise(chunk);
  if (!phrase) return null;

  return { phrase, rawPhrase: original, quantity, unitCode };
}

/**
 * phrase_index stores normalised phrases: lowercase, no punctuation,
 * no plurals. Normalisation must be stable above all else — the same
 * spoken food has to land on the same key every single time, because
 * a wandering key is a wandering bias.
 */
export function normalise(phrase: string): string {
  const cleaned = phrase
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.split(' ').map(singularise).join(' ');
}

/**
 * Deliberately conservative. Over-stemming collapses two real foods into
 * one key, which is a silent false positive; under-stemming costs one
 * fuzzy match, which is free.
 */
const NEVER_STRIP = new Set([
  // -ice / -uice / -ce
  'rice', 'juice', 'sauce', 'molasses',
  // singulars that merely end in -s
  'grass', 'cress', 'bass', 'gas', 'mass', 'less', 'this',
  // singulars ending in -is. This list is explicit rather than a /is$/
  // rule, because /is$/ eats exactly the plurals that matter most here:
  // rotis, idlis, puris, chapatis, barfis.
  'basis', 'analysis', 'oasis',
  // pluralia tantum: no singular form worth constructing
  'chickpeas', 'oats', 'greens', 'sprouts', 'noodles',
]);

export function singularise(word: string): string {
  if (word.length <= 3) return word;
  if (NEVER_STRIP.has(word)) return word;
  // -ss and -us are reliably not plural markers ('hummus', 'couscous').
  // -is and -os are NOT: 'rotis' and 'samosas' are the common case.
  if (/(?:ss|us)$/.test(word)) return word;
  if (/ies$/.test(word) && word.length > 4) return word.slice(0, -3) + 'y';
  if (/(?:ch|sh|x|z)es$/.test(word)) return word.slice(0, -2);
  if (/oes$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}
