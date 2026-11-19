/** Throughput numbers for the README: `npm run bench`. */
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { convertFolder } from '../src/convert.ts';
import { atom, translate } from '../src/expression.ts';
import { decodeExport, parseExport } from '../src/powercenter.ts';
import { chainMapping, longExpression, manyMappings, wideMapping } from '../test/support/generators.ts';
import { parseSpec } from '../test/support/mapping-xml.ts';

const sampleBytes = readFileSync('examples/FLOWLINE_DEMO_JAFFLESHOP.xml');
const sample = parseExport(decodeExport(sampleBytes))[0]!;
const resolve = (name: string) => atom(`t.${name.toLowerCase()}`);

test('sample export (730 KB, 16 models)', async ({ bench }) => {
  await bench.compare(
    bench('parse', () => {
      parseExport(decodeExport(sampleBytes));
    }),
    bench('convert', () => {
      convertFolder(sample);
    }),
  );
});

test('synthetic mappings', async ({ bench }) => {
  const chain = parseSpec(chainMapping(1_000));
  const wide = parseSpec(wideMapping(1_000));
  const folder = parseSpec(...manyMappings(250));
  await bench.compare(
    bench('chain of 1,000 transformations', () => {
      convertFolder(chain);
    }),
    bench('mapping 1,000 columns wide', () => {
      convertFolder(wide);
    }),
    bench('folder of 500 mappings', () => {
      convertFolder(folder);
    }),
  );
});

test('expressions', async ({ bench }) => {
  const typical = "IIF(ISNULL(PRICE), 0, PRICE) * (1 + IIF(TAX_RATE >= 0.15, 0.2, 0.1)) - DISCOUNT";
  const concatenation = longExpression(1_000, '||');
  await bench.compare(
    bench('typical expression', () => {
      translate(typical, resolve);
    }),
    bench('concatenation of 1,000 columns', () => {
      translate(concatenation, resolve);
    }),
  );
});
