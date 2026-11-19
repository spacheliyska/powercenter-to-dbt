/** Lays the converted models out as a dbt project. Pure: it returns the files, the CLI writes them. */
import type { ConversionResult, DbtSource } from './convert.ts';
import { identifier } from './sql.ts';

export interface ProjectFile {
  /** Relative to the project root, with forward slashes. */
  path: string;
  content: string;
}

const PROJECT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function dbtProjectFiles(result: ConversionResult, projectName: string): ProjectFile[] {
  if (!PROJECT_NAME.test(projectName)) {
    throw new Error(`invalid dbt project name "${projectName}": use letters, digits and underscores`);
  }
  return [
    { path: 'dbt_project.yml', content: projectYaml(projectName) },
    { path: 'models/sources.yml', content: sourcesYaml(result.sources) },
    // One folder per PowerCenter mapping keeps the original grouping visible.
    ...result.models.map((model) => ({ path: `models/${identifier(model.mapping)}/${model.name}.sql`, content: model.sql })),
  ];
}

function projectYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nconfig-version: 2\nprofile: ${name}\nmodel-paths: ["models"]\n`;
}

function sourcesYaml(sources: DbtSource[]): string {
  if (sources.length === 0) return 'version: 2\n\nsources: []\n';
  const blocks = sources.map(({ name, tables }) => [`  - name: ${name}`, '    tables:', ...tables.map((table) => `      - name: ${table}`)].join('\n'));
  return `version: 2\n\nsources:\n${blocks.join('\n')}\n`;
}
