import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/core/settings';
import { DEFAULT_REL_ERROR } from '../src/core/foodimport';

/**
 * Documentation drift guard.
 *
 * Docs that quietly stop matching the code are worse than no docs: they
 * are believed. These tests make drift a build failure at the moment it
 * happens, rather than a discovery months later.
 */

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const schemaSql = read('db/schema.sql');
const seedSql = read('db/seed.sql');
const SCHEMA_MD = read('docs/SCHEMA.md');
const ARCH_MD = read('docs/ARCHITECTURE.md');
const TECH_MD = read('docs/TECHNICAL_SPEC.md');
const FUNC_MD = read('docs/FUNCTIONAL_SPEC.md');
const DOCS_INDEX = read('docs/README.md');
const ROOT_MD = read('README.md');

const names = (kind: string, sql = schemaSql) =>
  [...sql.matchAll(new RegExp(`CREATE ${kind} (?:IF NOT EXISTS )?(\\w+)`, 'g'))].map((m) => m[1]);

describe('SCHEMA.md documents the actual schema', () => {
  it('mentions every table', () => {
    const undocumented = names('TABLE').filter((t) => !SCHEMA_MD.includes(t));
    expect(undocumented).toEqual([]);
  });

  it('mentions every view', () => {
    const undocumented = names('VIEW').filter((v) => !SCHEMA_MD.includes(v));
    expect(undocumented).toEqual([]);
  });

  it('mentions every uniqueness index, since each one encodes an invariant', () => {
    const all = [...names('UNIQUE INDEX'), ...names('UNIQUE INDEX', seedSql)];
    const undocumented = [...new Set(all)].filter((i) => !SCHEMA_MD.includes(i));
    expect(undocumented).toEqual([]);
  });

  it('does not document tables that no longer exist', () => {
    const real = new Set([...names('TABLE'), ...names('VIEW')]);
    // Anything in a `## N. \`name\`` heading must be a real relation.
    const claimed = [...SCHEMA_MD.matchAll(/^## \d+\. `(\w+)`/gm)].map((m) => m[1]);
    expect(claimed.filter((c) => !real.has(c))).toEqual([]);
  });
});

describe('settings are documented with their real defaults', () => {
  it.each(Object.entries(DEFAULTS))('documents %s = %s', (key, value) => {
    expect(SCHEMA_MD).toContain(key);
    expect(SCHEMA_MD).toMatch(new RegExp(`${key}[^\\n]*\`?${String(value)}`));
  });

  it('seeds every setting the code knows about', () => {
    for (const key of Object.keys(DEFAULTS)) expect(seedSql).toContain(`'${key}'`);
  });
});

describe('provenance is documented accurately', () => {
  it('states the label error band, which is the one that is not obvious', () => {
    const pct = `${DEFAULT_REL_ERROR.label * 100}`.replace(/\.0$/, '');
    for (const doc of [SCHEMA_MD, TECH_MD]) expect(doc).toContain(pct);
  });

  it('names every food source the loader accepts', () => {
    for (const source of Object.keys(DEFAULT_REL_ERROR)) {
      expect(SCHEMA_MD).toContain(source);
    }
  });
});

describe('the docs are navigable', () => {
  const docs = {
    'docs/README.md': DOCS_INDEX,
    'docs/ARCHITECTURE.md': ARCH_MD,
    'docs/SCHEMA.md': SCHEMA_MD,
    'docs/TECHNICAL_SPEC.md': TECH_MD,
    'docs/FUNCTIONAL_SPEC.md': FUNC_MD,
  };

  it('links every spec from the index', () => {
    for (const name of ['ARCHITECTURE', 'SCHEMA', 'TECHNICAL_SPEC', 'FUNCTIONAL_SPEC', 'BUILD_BRIEF']) {
      expect(DOCS_INDEX).toContain(`${name}.md`);
    }
  });

  it('links the docs from the root README', () => {
    expect(ROOT_MD).toContain('docs/');
  });

  it('has no relative link pointing at a missing file', () => {
    for (const [from, body] of Object.entries(docs)) {
      const links = [...body.matchAll(/\]\((?!https?:)([^)#]+)/g)].map((m) => m[1]);
      for (const target of links) {
        const base = new URL(`../${from}`, import.meta.url);
        expect(
          () => readFileSync(new URL(target, base)),
          `${from} → ${target}`,
        ).not.toThrow();
      }
    }
  });

  it('opens every mermaid block it closes', () => {
    for (const [name, body] of Object.entries(docs)) {
      const fences = (body.match(/```/g) ?? []).length;
      expect(fences % 2, `${name} has an unbalanced code fence`).toBe(0);
    }
  });
});

describe('the DOM helper respects the shipped CSP', () => {
  it('never emits an inline style attribute', () => {
    // style-src 'self' blocks inline style attributes but not CSSOM, so a
    // style attribute would silently not apply. This is the one place the
    // difference is easy to get wrong.
    const dom = readFileSync(new URL('../src/app/dom.ts', import.meta.url), 'utf8');
    expect(dom).toContain("el.style.setProperty");
    expect(dom).not.toMatch(/setAttribute\(\s*['"]style['"]/);
  });

  it('has no style attributes written directly in the views', () => {
    for (const f of ['src/app/views.ts', 'src/main.ts', 'index.html']) {
      expect(read(f), f).not.toMatch(/\sstyle\s*=\s*["']/);
    }
  });
});

describe('the docs do not disclaim built features', () => {
  it('FUNCTIONAL_SPEC no longer lists goals as out of scope', () => {
    // Goal setting was owner-authorised into scope; a spec that still
    // lists it under non-goals is documentation lying at readers.
    const notBuilt = FUNC_MD.slice(FUNC_MD.indexOf('## 13'));
    expect(notBuilt).not.toMatch(/goals and targets/);
    expect(FUNC_MD).toContain('calculator.net');
  });

  it('SCHEMA documents the target precedence including cycled', () => {
    for (const source of ['manual', 'cycled', 'adaptive', 'mifflin', 'harris', 'katch']) {
      expect(SCHEMA_MD).toContain(source);
    }
  });
});
