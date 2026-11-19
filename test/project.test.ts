import { describe, expect, it } from 'vitest';
import type { ConversionResult, DbtModel } from '../src/convert.ts';
import { dbtProjectFiles } from '../src/dbt.ts';
import { folderReport, summaryLine } from '../src/report.ts';

const model = (name: string, warnings: string[] = []): DbtModel => ({ name, mapping: 'm_Staging', sql: `select 1 -- ${name}`, warnings, sources: [] });
const result = (overrides: Partial<ConversionResult> = {}): ConversionResult => ({ models: [], sources: [], errors: [], ...overrides });

describe('dbt project files', () => {
  it('writes the project file, sources.yml and one folder per mapping', () => {
    const files = dbtProjectFiles(result({ models: [model('stg_orders')], sources: [{ name: 'raw', tables: ['orders'] }] }), 'demo');
    expect(files).toEqual([
      { path: 'dbt_project.yml', content: 'name: demo\nversion: "1.0.0"\nconfig-version: 2\nprofile: demo\nmodel-paths: ["models"]\n' },
      { path: 'models/sources.yml', content: 'version: 2\n\nsources:\n  - name: raw\n    tables:\n      - name: orders\n' },
      { path: 'models/m_staging/stg_orders.sql', content: 'select 1 -- stg_orders' },
    ]);
  });

  it('writes a valid sources.yml when nothing is read with source()', () => {
    expect(dbtProjectFiles(result(), 'demo')[1]!.content).toBe('version: 2\n\nsources: []\n');
  });

  it.each(['my project', '1demo', 'demo-project', ''])('refuses the project name "%s"', (name) => {
    expect(() => dbtProjectFiles(result(), name)).toThrow('invalid dbt project name');
  });
});

describe('conversion report', () => {
  const converted = result({ models: [model('stg_orders', ['look here']), model('customers')], errors: ['m -> T: no'] });

  it('lists every model, its warnings, and the failed targets separately', () => {
    const report = folderReport('F', 'out', converted, false);
    expect(report.lines).toEqual([
      'Folder F -> out',
      '  ok       stg_orders  m_Staging  (1 warning)',
      '             warning: look here',
      '  ok       customers   m_Staging',
    ]);
    expect(report.errorLines).toEqual(['  FAILED   m -> T: no']);
    expect([report.models, report.warnings, report.errors]).toEqual([2, 1, 1]);
  });

  it('hides the warning details when quiet', () => {
    expect(folderReport('F', 'out', converted, true).lines).not.toContain('             warning: look here');
  });

  it('summarises with correct plurals', () => {
    expect(summaryLine({ models: 1, warnings: 0, errors: 2 })).toBe('Done: 1 model written, 0 warnings, 2 errors.');
  });
});
