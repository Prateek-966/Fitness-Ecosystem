import { describe, expect, it } from 'vitest';
import { normalise, parse, singularise } from '../src/core/parse';

/**
 * The brief names three phrases that must parse locally, with no model
 * call. They are the first three tests here and they are not negotiable:
 * if any of them needs the network, the fast path is not a fast path.
 */
describe('the phrases named in the brief', () => {
  it('parses "two rotis"', () => {
    expect(parse('two rotis')).toEqual([
      { phrase: 'roti', rawPhrase: 'two rotis', quantity: 2, unitCode: null },
    ]);
  });

  it('parses "60g atta"', () => {
    expect(parse('60g atta')).toEqual([
      { phrase: 'atta', rawPhrase: '60g atta', quantity: 60, unitCode: 'g' },
    ]);
  });

  it('parses "one katori rajma"', () => {
    expect(parse('one katori rajma')).toEqual([
      { phrase: 'rajma', rawPhrase: 'one katori rajma', quantity: 1, unitCode: 'katori' },
    ]);
  });
});

describe('quantities', () => {
  it('reads digits and decimals', () => {
    expect(parse('2.5 katori dal')[0]).toMatchObject({ quantity: 2.5, unitCode: 'katori' });
  });

  it('reads number words up to twenty', () => {
    expect(parse('twelve almonds')[0]).toMatchObject({ quantity: 12, phrase: 'almond' });
  });

  it('reads "half" and "quarter"', () => {
    expect(parse('half a plate rice')[0]).toMatchObject({ quantity: 0.5, unitCode: 'plate' });
    expect(parse('quarter cup milk')[0]).toMatchObject({ quantity: 0.25, unitCode: 'cup' });
  });

  it('keeps the integer part of a spoken mixed fraction', () => {
    // Splitting on "and" before rewriting this would silently drop the 1.
    expect(parse('one and a half rotis')).toEqual([
      { phrase: 'roti', rawPhrase: '1.5 rotis', quantity: 1.5, unitCode: null },
    ]);
  });

  it('treats a bare article as one', () => {
    expect(parse('an apple')[0]).toMatchObject({ quantity: 1, phrase: 'apple' });
  });

  it('leaves quantity null when none was said', () => {
    expect(parse('rajma')[0]).toMatchObject({ quantity: null, phrase: 'rajma' });
  });
});

describe('units', () => {
  it('does not let "g" shadow "grams"', () => {
    expect(parse('200 grams paneer')[0]).toMatchObject({ quantity: 200, unitCode: 'g', phrase: 'paneer' });
  });

  it('does not mistake a food beginning with a unit letter for a unit', () => {
    expect(parse('ghee')[0]).toMatchObject({ phrase: 'ghee', unitCode: null });
    expect(parse('2 cupcakes')[0]).toMatchObject({ phrase: 'cupcake', unitCode: null });
  });

  it('folds kg and litres into the stored base unit', () => {
    expect(parse('1.5 kg chicken')[0]).toMatchObject({ quantity: 1500, unitCode: 'g' });
    expect(parse('1 litre milk')[0]).toMatchObject({ quantity: 1000, unitCode: 'ml' });
  });

  it('maps bowl to katori', () => {
    expect(parse('one bowl curd')[0]).toMatchObject({ unitCode: 'katori', phrase: 'curd' });
  });

  it('reads "no" as pieces only after a number', () => {
    expect(parse('2 no idli')[0]).toMatchObject({ quantity: 2, unitCode: 'piece', phrase: 'idli' });
    // "no sugar" is a negation, not two pieces of sugar.
    expect(parse('no sugar')[0]).toMatchObject({ unitCode: null, phrase: 'no sugar' });
  });

  it('swallows "of" after a unit', () => {
    expect(parse('two cups of tea')[0]).toMatchObject({ quantity: 2, unitCode: 'cup', phrase: 'tea' });
  });
});

describe('multiple items', () => {
  it('splits on commas and "and"', () => {
    const items = parse('two rotis, one katori dal and a glass of milk');
    expect(items.map((i) => i.phrase)).toEqual(['roti', 'dal', 'milk']);
    expect(items.map((i) => i.quantity)).toEqual([2, 1, 1]);
    expect(items.map((i) => i.unitCode)).toEqual([null, 'katori', 'glass']);
  });

  it('splits on "with"', () => {
    expect(parse('rice with rajma').map((i) => i.phrase)).toEqual(['rice', 'rajma']);
  });
});

describe('refusing to guess', () => {
  it('drops a unit with no food after it', () => {
    // "two katoris" of WHAT. That is ambiguity, and ambiguity never
    // reaches the log.
    expect(parse('two katoris')).toEqual([]);
  });

  it('returns nothing for an empty or punctuation-only utterance', () => {
    expect(parse('')).toEqual([]);
    expect(parse('...')).toEqual([]);
  });
});

describe('normalisation', () => {
  it('is stable: the same food always lands on the same key', () => {
    const keys = ['Two Rotis', 'two rotis', 'TWO ROTIS!', 'two  rotis']
      .map((s) => parse(s)[0].phrase);
    expect(new Set(keys).size).toBe(1);
  });

  it('strips plurals conservatively', () => {
    expect(singularise('rotis')).toBe('roti');
    expect(singularise('idlis')).toBe('idli');
    expect(singularise('tomatoes')).toBe('tomato');
    expect(singularise('berries')).toBe('berry');
    expect(singularise('sandwiches')).toBe('sandwich');
  });

  it('does not over-stem foods that end in s', () => {
    for (const w of ['rice', 'juice', 'hummus', 'couscous', 'dosa', 'chickpeas']) {
      expect(singularise(w)).toBe(w);
    }
  });

  it('strips punctuation without joining words', () => {
    expect(normalise('dal-chawal')).toBe('dal chawal');
  });
});
