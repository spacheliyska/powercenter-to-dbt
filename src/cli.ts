/**
 * Usage: node src/cli.ts <powercenter-export.xml> [--out <dir>] [--project <name>] [--quiet]
 *
 * Writes one dbt model per PowerCenter target, plus sources.yml and dbt_project.yml, and prints
 * a report. Exit code: 0 = everything converted; 1 = some targets could not be converted (the
 * others are still written); 2 = bad usage or unreadable input.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { convertFolder } from './convert.ts';
import { dbtProjectFiles, type ProjectFile } from './dbt.ts';
import { decodeExport, parseExport } from './powercenter.ts';
import { folderReport, summaryLine } from './report.ts';

const USAGE = 'Usage: node src/cli.ts <powercenter-export.xml> [--out <dir>] [--project <name>] [--quiet]';

function main(argv: string[]): number {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'dbt_project' },
      project: { type: 'string', default: 'pwc_converted' },
      quiet: { type: 'boolean', short: 'q', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [input] = positionals;
  if (values.help || !input) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  const folders = parseExport(decodeExport(readFileSync(input)));
  const totals = { models: 0, warnings: 0, errors: 0 };
  for (const folder of folders) {
    const result = convertFolder(folder);
    // One dbt project per folder, so that their models and sources.yml cannot overwrite each other.
    const outDir = folders.length > 1 ? join(values.out, folder.name.toLowerCase()) : values.out;
    writeFiles(outDir, dbtProjectFiles(result, values.project));

    const report = folderReport(folder.name, outDir, result, values.quiet);
    console.log(report.lines.join('\n'));
    if (report.errorLines.length > 0) console.error(report.errorLines.join('\n'));
    totals.models += report.models;
    totals.warnings += report.warnings;
    totals.errors += report.errors;
  }

  console.log(summaryLine(totals));
  return totals.errors > 0 ? 1 : 0;
}

/** One mkdir per distinct directory (not per file) and one write per file. */
function writeFiles(outDir: string, files: ProjectFile[]): void {
  const targets = files.map(({ path, content }) => ({ path: join(outDir, path), content }));
  for (const directory of new Set(targets.map(({ path }) => dirname(path)))) mkdirSync(directory, { recursive: true });
  for (const { path, content } of targets) writeFileSync(path, content);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exitCode = 2;
}
