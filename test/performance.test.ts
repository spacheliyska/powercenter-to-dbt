/**
 * Performance: conversion time must grow linearly with every dimension of the input.
 *
 * Absolute timings depend on the machine, so the main checks compare a size with four times
 * that size: linear work takes about 4x as long, quadratic work 16x. Allowing up to 8x keeps
 * the tests stable on a busy machine while still catching an accidental quadratic step.
 * The absolute budgets are an order of magnitude above what a laptop needs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertFolder } from '../src/convert.ts';
import { atom, translate } from '../src/expression.ts';
import { decodeExport, parseExport } from '../src/powercenter.ts';
import { chainMapping, longExpression, manyMappings, wideMapping } from './support/generators.ts';
import { exportXml, folderXml, parseSpec } from './support/mapping-xml.ts';

/**
 * The fastest of several runs, in milliseconds, after one warm-up run for the JIT. A busy
 * machine (or garbage collection) can only add time, so the fastest run is the most faithful.
 */
function fastestMs(run: () => unknown, runs = 7): number {
  run();
  return Math.min(
    ...Array.from({ length: runs }, () => {
      const start = performance.now();
      run();
      return performance.now() - start;
    }),
  );
}

/** How many times longer the work for 4 x size takes than the work for size. */
function growth(prepare: (size: number) => () => unknown, size: number): number {
  const small = prepare(size);
  const large = prepare(4 * size);
  return fastestMs(large) / fastestMs(small);
}

const resolve = (name: string) => atom(`t.${name.toLowerCase()}`);

// Each `prepare` builds its input up front and returns only the work that is timed.
const workloads: [string, (size: number) => () => unknown, number][] = [
  ['the length of a chain of transformations', (n) => ((folder) => () => convertFolder(folder))(parseSpec(chainMapping(n))), 1_500],
  ['the width of the transformations', (n) => ((folder) => () => convertFolder(folder))(parseSpec(wideMapping(n))), 1_000],
  ['the number of mappings, parsing included', (n) => ((xml) => () => convertFolder(parseExport(xml)[0]!))(exportXml([folderXml('F', manyMappings(n))])), 100],
  ['the length of an expression', (n) => ((expression) => () => translate(expression, resolve))(longExpression(n, '+')), 10_000],
  ['the length of a concatenation', (n) => ((expression) => () => translate(expression, resolve))(longExpression(n, '||')), 10_000],
];

describe('conversion time grows linearly with', () => {
  it.each(workloads)('%s', (_, prepare, size) => {
    expect(growth(prepare, size)).toBeLessThan(8);
  });
});

describe('time budgets', () => {
  it('converts the sample export, parsing included, in well under a second', () => {
    const bytes = readFileSync('examples/FLOWLINE_DEMO_JAFFLESHOP.xml');
    expect(fastestMs(() => convertFolder(parseExport(decodeExport(bytes))[0]!))).toBeLessThan(1_000);
  });

  it('converts a chain of 10,000 transformations in under 2 seconds', () => {
    const folder = parseSpec(chainMapping(10_000));
    expect(fastestMs(() => convertFolder(folder), 3)).toBeLessThan(2_000);
  });

  it('parses and converts 1,000 mappings in under 3 seconds', () => {
    const xml = exportXml([folderXml('F', manyMappings(500))]);
    expect(fastestMs(() => convertFolder(parseExport(xml)[0]!), 3)).toBeLessThan(3_000);
  });
});
