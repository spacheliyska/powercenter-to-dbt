/**
 * Scale: inputs far larger than real mappings. Each test checks that the conversion still
 * completes (no stack overflow, no runaway output) and that the result is still right, by
 * running the generated SQL in DuckDB where that is affordable.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertFolder } from '../src/convert.ts';
import { UnsupportedError } from '../src/errors.ts';
import { atom, translate } from '../src/expression.ts';
import { chainMapping, longExpression, manyMappings, wideMapping } from './support/generators.ts';
import { parseSpec } from './support/mapping-xml.ts';
import { cteNames } from './support/sql.ts';
import { Warehouse } from './support/warehouse.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'pwc2dbt-scale-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** Converts the mapping, loads `rows` into its source table S and returns the target's rows. */
async function run(spec: ReturnType<typeof chainMapping>, header: string[], rows: number[][]): Promise<Record<string, unknown>[]> {
  const folder = parseSpec(spec);
  const result = convertFolder(folder);
  expect(result.errors).toEqual([]);
  writeFileSync(join(dataDir, 's.csv'), [header.join(','), ...rows.map((row) => row.join(','))].join('\n'));
  const warehouse = await Warehouse.create(folder, result, dataDir);
  return warehouse.query('select * from t order by 1');
}

const resolve = (name: string) => atom(`t.${name.toLowerCase()}`);

describe('long chains of transformations', () => {
  it('converts a chain of 10,000 transformations without running out of stack', () => {
    const result = convertFolder(parseSpec(chainMapping(10_000)));
    expect(result.errors).toEqual([]);
    const names = cteNames(result.models[0]!.sql);
    expect(names).toHaveLength(10_001);
    expect(names.at(-1)).toBe('exp_10000');
  });

  it('computes the right values through a chain of 300 when the SQL runs', async () => {
    expect(await run(chainMapping(300), ['a'], [[1], [41]])).toEqual([{ a: 301 }, { a: 341 }]);
  });
});

describe('wide transformations', () => {
  it('converts a mapping that is 5,000 columns wide', () => {
    const result = convertFolder(parseSpec(wideMapping(5_000)));
    expect(result.errors).toEqual([]);
    const finalSelect = result.models[0]!.sql.split('\n\nselect\n')[1]!;
    expect(finalSelect.split(',\n')).toHaveLength(5_000);
  });

  it('computes the right values for 300 columns when the SQL runs', async () => {
    const header = Array.from({ length: 300 }, (_, i) => `c_${i + 1}`);
    const rows = [header.map((_, i) => (i === 0 ? 1 : i)), header.map((_, i) => (i === 0 ? 1 : 1000 + i))];
    const [row] = await run(wideMapping(300), header, rows);
    expect(row).toMatchObject({ r_1: 2, m_2: 2002, m_300: 2598 }); // r_1 = c_1 * 2, m_i = max(c_i) * 2
  });
});

describe('many mappings', () => {
  it('converts 2,000 mappings in one folder, linking marts to staging tables with ref()', () => {
    const result = convertFolder(parseSpec(...manyMappings(1_000)));
    expect(result.errors).toEqual([]);
    expect(result.models).toHaveLength(2_000);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.tables).toHaveLength(1_000);
    const marts = result.models.filter((model) => model.name.startsWith('mart_'));
    expect(marts.every((mart) => mart.sql.includes(`{{ ref('stg_${mart.name.slice('mart_'.length)}') }}`))).toBe(true);
  });
});

describe('long expressions', () => {
  it('turns a concatenation of 5,000 columns into a single concat()', () => {
    const sql = translate(longExpression(5_000, '||'), resolve).text;
    expect(sql.startsWith('concat(t.c_1, t.c_2, ')).toBe(true);
    expect(sql.split(', ')).toHaveLength(5_000);
  });

  it.each(['+', 'AND', 'OR'])('translates a chain of 50,000 operands joined by %s', (operator) => {
    const sql = translate(longExpression(50_000, operator), resolve).text;
    expect(sql.split(` ${operator.toLowerCase()} `)).toHaveLength(50_000);
  });

  it('translates a DECODE with 2,000 cases into one CASE', () => {
    const cases = Array.from({ length: 2_000 }, (_, i) => `'K${i}', ${i}`).join(', ');
    expect(translate(`DECODE(CODE, ${cases}, -1)`, resolve).text.match(/ when /g)).toHaveLength(2_000);
  });

  it('flattens 2,000 nested IIFs into one CASE', () => {
    const nested = `${Array.from({ length: 2_000 }, (_, i) => `IIF(CODE = ${i}, 'v${i}', `).join('')}'other'${')'.repeat(2_000)}`;
    const sql = translate(nested, resolve).text;
    expect(sql.match(/ when /g)).toHaveLength(2_000);
    expect(sql.match(/case /g)).toHaveLength(1);
  });

  it('reports absurd nesting as unsupported instead of crashing', () => {
    expect(() => translate(`${'('.repeat(100_000)}A${')'.repeat(100_000)}`, resolve)).toThrow(UnsupportedError);
  });
});
