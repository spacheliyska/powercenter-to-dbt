import { UnsupportedError } from './errors.ts';
import { atom, type Sql } from './expression.ts';
import { isDateType, type MappingVariable } from './powercenter.ts';

/** A mapping parameter such as $$RUN_DATE as a dbt variable, defaulting to the value the mapping declares. */
export function parameterSql({ name, datatype, defaultValue }: MappingVariable): Sql {
  const variable = name.replace(/^\$+/, '').toLowerCase();

  if (isDateType(datatype)) {
    return atom(`cast('{{ var("${variable}", ${JSON.stringify(isoTimestamp(name, defaultValue))}) }}' as timestamp)`, true);
  }
  if (/char|string|text/i.test(datatype)) {
    // The filter doubles any quote in the value, whether it is the default or comes from --vars.
    return atom(`'{{ var("${variable}", ${JSON.stringify(defaultValue)}) | replace("'", "''") }}'`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(defaultValue)) throw new UnsupportedError(`parameter ${name} has no numeric default value`);
  return atom(`{{ var("${variable}", ${defaultValue}) }}`);
}

/** PowerCenter writes date defaults as "MM/DD/YYYY HH24:MI:SS". */
function isoTimestamp(name: string, value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}:\d{2}:\d{2}))?/.exec(value);
  if (!match) throw new UnsupportedError(`cannot read default value "${value}" of ${name}`);
  const [, month, day, year, time = '00:00:00'] = match;
  return `${year}-${month}-${day} ${time}`;
}
