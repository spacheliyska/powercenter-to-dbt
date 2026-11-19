/**
 * A throwaway DuckDB "warehouse" for running generated models without dbt:
 *
 * 1. creates the raw tables from the PowerCenter SOURCE definitions (so column
 *    types match the original Oracle tables) and loads CSV data into them;
 * 2. renders the little Jinja the converter emits (source, ref, var);
 * 3. creates each model as a view, in dependency order.
 */
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { ConversionResult, DbtModel } from '../../src/convert.ts';
import type { Folder, TableField } from '../../src/powercenter.ts';

export type Row = Record<string, unknown>;

export class Warehouse {
  private connection: DuckDBConnection;

  private constructor(connection: DuckDBConnection) {
    this.connection = connection;
  }

  static async create(folder: Folder, result: ConversionResult, dataDir: string): Promise<Warehouse> {
    const warehouse = new Warehouse(await (await DuckDBInstance.create()).connect());
    await warehouse.loadSources(folder, result, dataDir);
    await warehouse.createModels(result.models);
    return warehouse;
  }

  async run(sql: string): Promise<void> {
    await this.connection.run(sql);
  }

  async query(sql: string): Promise<Row[]> {
    return (await this.connection.runAndReadAll(sql)).getRowObjectsJson() as Row[];
  }

  private async loadSources(folder: Folder, result: ConversionResult, dataDir: string): Promise<void> {
    for (const source of result.sources) {
      await this.run(`create schema ${source.name}`);
      for (const table of source.tables) {
        const definition = [...folder.sources.values()].find((candidate) => candidate.name.toLowerCase() === table);
        if (!definition) throw new Error(`no source definition for ${table}`);
        const columns = definition.fields.map((f) => `${f.name.toLowerCase()} ${duckdbType(f)}`).join(', ');
        await this.run(`create table ${source.name}.${table} (${columns})`);
        await this.run(
          `insert into ${source.name}.${table} by name select * from read_csv('${dataDir}/${table}.csv', header = true, all_varchar = true)`,
        );
      }
    }
  }

  private async createModels(models: DbtModel[]): Promise<void> {
    const pending = new Map(models.map((m) => [m.name, m]));
    while (pending.size > 0) {
      const ready = [...pending.values()].filter((m) => refs(m.sql).every((r) => !pending.has(r)));
      if (ready.length === 0) throw new Error(`circular refs between ${[...pending.keys()].join(', ')}`);
      for (const model of ready) {
        try {
          await this.run(`create view ${model.name} as ${renderJinja(model.sql)}`);
        } catch (error) {
          throw new Error(`model ${model.name} failed to compile in DuckDB: ${(error as Error).message}`);
        }
        pending.delete(model.name);
      }
    }
  }
}

/** Renders the only Jinja the converter emits. */
export function renderJinja(sql: string): string {
  return sql
    .replace(/\{\{\s*source\('(\w+)',\s*'(\w+)'\)\s*\}\}/g, '$1.$2')
    .replace(/\{\{\s*ref\('(\w+)'\)\s*\}\}/g, '$1')
    .replace(/\{\{\s*var\("\w+",\s*"([^"]*)"\)\s*\}\}/g, '$1');
}

function refs(sql: string): string[] {
  return [...sql.matchAll(/\{\{\s*ref\('(\w+)'\)\s*\}\}/g)].map((m) => m[1]!);
}

/** Oracle column types from the SOURCE definition -> DuckDB. */
function duckdbType(field: TableField): string {
  const type = field.datatype.toLowerCase();
  if (type.startsWith('number')) return field.scale > 0 ? `decimal(${field.precision}, ${field.scale})` : 'double';
  if (type.includes('date') || type.includes('timestamp')) return 'timestamp';
  return 'varchar';
}
