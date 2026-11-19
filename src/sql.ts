/** SQL text helpers: names, select-list items and the shape of the generated queries. */
import type { Sql } from './expression.ts';

/** Words that cannot be used as a bare column name. Anything else (name, type, id, ...) is fine in DuckDB. */
const RESERVED_WORDS = new Set(
  `all and any array as asc between by case cast check column create default desc distinct else end except exists false
   for foreign from grant group having in index inner intersect interval is join left like limit not null offset on or
   order outer over partition primary references right select some table then to true union unique user using values
   when where window with`.split(/\s+/),
);

/** Model, CTE and source names: lower case (the dbt convention) and always a valid identifier. */
export function identifier(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return /^\d/.test(safe) ? `_${safe}` : safe;
}

/** A column name as written in SQL: an identifier, double-quoted when it is a reserved word. */
export function columnName(name: string): string {
  const safe = identifier(name);
  return RESERVED_WORDS.has(safe) ? `"${safe}"` : safe;
}

const BARE_RELATION = /^\w+$/;

/** `expression as name`, or just the expression when it already is `relation.name`. */
export function selectItem(sql: Sql, name: string): string {
  const column = columnName(name);
  const isSameColumn = sql.text.endsWith(`.${column}`) && BARE_RELATION.test(sql.text.slice(0, -column.length - 1));
  return isSameColumn ? sql.text : `${sql.text} as ${column}`;
}

export interface Select {
  columns: string[];
  from: string;
  where?: string;
  groupBy?: string[];
  distinct?: boolean;
  /** An explanatory comment printed above the select. */
  note?: string;
}

/** A query is one select, or several selects combined with UNION ALL. */
export type Query = Select | Select[];

export function renderQuery(query: Query): string {
  return Array.isArray(query) ? query.map(renderSelect).join('\n\nunion all\n\n') : renderSelect(query);
}

function renderSelect({ columns, from, where, groupBy, distinct, note }: Select): string {
  const lines = [distinct ? 'select distinct' : 'select', columns.map((column) => `    ${column}`).join(',\n'), `from ${from}`];
  if (note) lines.unshift(`-- ${note}`);
  if (where) lines.push(`where ${where}`);
  if (groupBy?.length) lines.push(`group by ${groupBy.join(', ')}`);
  return lines.join('\n');
}

/** Indents every non-empty line by four spaces. */
export function indent(sql: string): string {
  return sql.replace(/^(?=.)/gm, '    ');
}
