/** Human-readable conversion report. Pure: it returns lines, the CLI decides where to print them. */
import type { ConversionResult } from './convert.ts';

export interface FolderReport {
  /** For stdout. */
  lines: string[];
  /** For stderr: one line per target that could not be converted. */
  errorLines: string[];
  models: number;
  warnings: number;
  errors: number;
}

export function folderReport(folderName: string, outDir: string, result: ConversionResult, quiet: boolean): FolderReport {
  const width = Math.max(...result.models.map((model) => model.name.length), 0);
  const lines = [`Folder ${folderName} -> ${outDir}`];
  for (const { name, mapping, warnings } of result.models) {
    const count = warnings.length > 0 ? `  (${plural(warnings.length, 'warning')})` : '';
    lines.push(`  ok       ${name.padEnd(width)}  ${mapping}${count}`);
    if (!quiet) lines.push(...warnings.map((warning) => `             warning: ${warning}`));
  }

  return {
    lines,
    errorLines: result.errors.map((error) => `  FAILED   ${error}`),
    models: result.models.length,
    warnings: result.models.reduce((total, model) => total + model.warnings.length, 0),
    errors: result.errors.length,
  };
}

export function summaryLine({ models, warnings, errors }: Pick<FolderReport, 'models' | 'warnings' | 'errors'>): string {
  return `Done: ${plural(models, 'model')} written, ${plural(warnings, 'warning')}, ${plural(errors, 'error')}.`;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
