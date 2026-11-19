/** The CLI end to end, run as a separate process the way a user runs it. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportXml, folderXml, input, output, sourceQualifier } from './support/mapping-xml.ts';

const workDir = mkdtempSync(join(tmpdir(), 'pwc2dbt-cli-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const cli = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8' });
const outDir = (name: string) => join(workDir, name);

/** A folder with one good mapping and one using an unsupported transformation. */
function exportWithOneFailure(): string {
  const sq = sourceQualifier('SQ', 'S', ['A']);
  const xml = exportXml([
    folderXml('F', [
      { name: 'm_good', sources: { S: ['A'] }, targets: { GOOD: ['A'] }, transformations: [sq.transformation], links: [...sq.links, ['SQ', 'A', 'GOOD', 'A']] },
      {
        name: 'm_bad',
        sources: { S: ['A'] },
        targets: { BAD: ['A'] },
        transformations: [sq.transformation, { name: 'LKP', type: 'Lookup Procedure', ports: [input('A_IN'), output('A', 'A_IN')] }],
        links: [...sq.links, ['SQ', 'A', 'LKP', 'A_IN'], ['LKP', 'A', 'BAD', 'A']],
      },
    ]),
  ]);
  const path = join(workDir, 'one-failure.xml');
  writeFileSync(path, xml);
  return path;
}

describe('the command line', () => {
  it('converts the sample and exits with 0', () => {
    const run = cli('examples/FLOWLINE_DEMO_JAFFLESHOP.xml', '--out', outDir('sample'));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Done: 16 models written, 17 warnings, 0 errors.');
    expect(readdirSync(join(outDir('sample'), 'models')).sort()).toEqual(['m_fl_js_marts_core', 'm_fl_js_marts_enriched', 'm_fl_js_staging_full', 'sources.yml']);
    expect(existsSync(join(outDir('sample'), 'dbt_project.yml'))).toBe(true);
  });

  it('hides warning details with --quiet', () => {
    const run = cli('examples/FLOWLINE_DEMO_JAFFLESHOP.xml', '--out', outDir('quiet'), '--quiet');
    expect(run.stdout).toContain('(6 warnings)');
    expect(run.stdout).not.toContain('warning: ');
  });

  it('writes what it can, reports failures on stderr and exits with 1', () => {
    const run = cli(exportWithOneFailure(), '--out', outDir('partial'));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('FAILED   m_bad -> BAD: Lookup Procedure transformation LKP is not supported');
    expect(existsSync(join(outDir('partial'), 'models', 'm_good', 'good.sql'))).toBe(true);
  });

  it('writes one project per folder when the export has several', () => {
    const path = join(workDir, 'two-folders.xml');
    writeFileSync(path, exportXml([folderXml('SALES', []), folderXml('HR', [])]));
    expect(cli(path, '--out', outDir('folders')).status).toBe(0);
    expect(readdirSync(outDir('folders')).sort()).toEqual(['hr', 'sales']);
  });

  it.each([
    ['no input file', [], 2, 'Usage:'],
    ['a missing file', ['missing.xml'], 2, 'error: ENOENT'],
    ['a file that is not an export', ['package.json'], 2, 'error: no POWERMART'],
    ['an invalid project name', ['examples/FLOWLINE_DEMO_JAFFLESHOP.xml', '--project', 'bad name', '--out', outDir('bad')], 2, 'invalid dbt project name'],
    ['an unknown option', ['--frobnicate'], 2, 'error:'],
  ])('exits with 2 for %s', (_, args, status, message) => {
    const run = cli(...args);
    expect(run.status).toBe(status);
    expect(run.stdout + run.stderr).toContain(message);
  });

  it('prints the usage with --help and exits with 0', () => {
    const run = cli('--help');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Usage:');
  });
});
