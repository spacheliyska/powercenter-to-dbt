/**
 * Builds minimal PowerCenter export XML for tests, so each corner case can be
 * described in a few lines instead of depending on the big sample export.
 *
 * Instances are created implicitly: every source and target table gets an
 * instance with its own name, and so does every transformation.
 */
import { convertFolder, type ConversionResult } from '../../src/convert.ts';
import { parseExport, type Folder } from '../../src/powercenter.ts';

export interface PortSpec {
  name: string;
  /** Default: INPUT/OUTPUT (a pass-through port). */
  type?: string;
  expr?: string;
  group?: string;
  ref?: string;
  groupBy?: boolean;
  datatype?: string;
}

export interface TransformationSpec {
  name: string;
  type: string;
  ports: PortSpec[];
  attrs?: Record<string, string>;
  groups?: { name: string; type: string; expr?: string }[];
  deps?: [input: string, output: string][];
}

/** [fromInstance, fromField, toInstance, toField] */
export type LinkSpec = [string, string, string, string];

export interface MappingSpec {
  name?: string;
  /** table -> column names; all columns are varchar2 unless typed as "name:datatype". */
  sources?: Record<string, string[]>;
  targets?: Record<string, string[]>;
  transformations?: TransformationSpec[];
  links?: LinkSpec[];
  variables?: { name: string; datatype: string; defaultValue: string }[];
}

const escapeXml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const attributes = (values: Record<string, string | undefined>) =>
  Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${escapeXml(value!)}"`)
    .join('');

function tableXml(tag: 'SOURCE' | 'TARGET', fieldTag: string, tables: Record<string, string[]>): string[] {
  return Object.entries(tables).map(([name, columns]) => {
    const fields = columns.map((column) => {
      const [fieldName, datatype = 'varchar2'] = column.split(':');
      return `<${fieldTag}${attributes({ NAME: fieldName, DATATYPE: datatype, PRECISION: '50', SCALE: '0' })}/>`;
    });
    return `<${tag}${attributes({ NAME: name, OWNERNAME: 'RAW', DBDNAME: 'DB' })}>${fields.join('')}</${tag}>`;
  });
}

function transformationXml(t: TransformationSpec): string {
  const ports = t.ports.map(
    (p) =>
      `<TRANSFORMFIELD${attributes({
        NAME: p.name,
        DATATYPE: p.datatype ?? 'string',
        PORTTYPE: p.type ?? 'INPUT/OUTPUT',
        EXPRESSION: p.expr ?? '',
        GROUP: p.group ?? '',
        REF_FIELD: p.ref ?? '',
        EXPRESSIONTYPE: p.groupBy ? 'GROUPBY' : 'GENERAL',
      })}/>`,
  );
  const groups = (t.groups ?? []).map((g) => `<GROUP${attributes({ NAME: g.name, TYPE: g.type, EXPRESSION: g.expr ?? '' })}/>`);
  const attrs = Object.entries(t.attrs ?? {}).map(([name, value]) => `<TABLEATTRIBUTE${attributes({ NAME: name, VALUE: value })}/>`);
  const deps = (t.deps ?? []).map(([input, output]) => `<FIELDDEPENDENCY${attributes({ INPUTFIELD: input, OUTPUTFIELD: output })}/>`);
  return `<TRANSFORMATION${attributes({ NAME: t.name, TYPE: t.type })}>${[...groups, ...ports, ...attrs, ...deps].join('')}</TRANSFORMATION>`;
}

function mappingXml(m: MappingSpec): string {
  const instance = (name: string, type: string, database?: string) =>
    `<INSTANCE${attributes({ NAME: name, TYPE: type, TRANSFORMATION_NAME: name, DBDNAME: database })}/>`;
  return `<MAPPING${attributes({ NAME: m.name ?? 'm_test' })}>${[
    ...(m.transformations ?? []).map(transformationXml),
    ...Object.keys(m.sources ?? {}).map((t) => instance(t, 'SOURCE', 'DB')),
    ...Object.keys(m.targets ?? {}).map((t) => instance(t, 'TARGET')),
    ...(m.transformations ?? []).map((t) => instance(t.name, 'TRANSFORMATION')),
    ...(m.links ?? []).map(
      ([from, fromField, to, toField]) =>
        `<CONNECTOR${attributes({ FROMINSTANCE: from, FROMFIELD: fromField, TOINSTANCE: to, TOFIELD: toField })}/>`,
    ),
    ...(m.variables ?? []).map(
      (v) => `<MAPPINGVARIABLE${attributes({ NAME: v.name, DATATYPE: v.datatype, DEFAULTVALUE: v.defaultValue })}/>`,
    ),
  ].join('')}</MAPPING>`;
}

/** One FOLDER holding the given mappings; sources and targets are shared across them. */
export function folderXml(name: string, mappings: MappingSpec[]): string {
  const sources = Object.assign({}, ...mappings.map((m) => m.sources ?? {}));
  const targets = Object.assign({}, ...mappings.map((m) => m.targets ?? {}));
  return `<FOLDER${attributes({ NAME: name })}>${[
    ...tableXml('SOURCE', 'SOURCEFIELD', sources),
    ...tableXml('TARGET', 'TARGETFIELD', targets),
    ...mappings.map(mappingXml),
  ].join('')}</FOLDER>`;
}

export function exportXml(folders: string[]): string {
  return `<?xml version="1.0" encoding="Windows-1252"?><POWERMART><REPOSITORY NAME="repo">${folders.join('')}</REPOSITORY></POWERMART>`;
}

export function parseSpec(...mappings: MappingSpec[]): Folder {
  return parseExport(exportXml([folderXml('F', mappings)]))[0]!;
}

export function convertSpec(...mappings: MappingSpec[]): ConversionResult {
  return convertFolder(parseSpec(...mappings));
}

// ---- shorthands ------------------------------------------------------------

/** Same-name links for each field; a [from, to] pair links differently named ports. */
export function wire(from: string, to: string, fields: (string | [string, string])[]): LinkSpec[] {
  return fields.map((f) => {
    const [fromField, toField] = typeof f === 'string' ? [f, f] : f;
    return [from, fromField, to, toField];
  });
}

/** A Source Qualifier over `source`, exposing `columns` (and the links that feed it). */
export function sourceQualifier(name: string, source: string, columns: string[], attrs: Record<string, string> = {}) {
  return {
    transformation: { name, type: 'Source Qualifier', ports: columns.map((c) => ({ name: c })), attrs } satisfies TransformationSpec,
    links: wire(source, name, columns),
  };
}

/** Port helpers. */
export const input = (name: string): PortSpec => ({ name, type: 'INPUT' });
export const output = (name: string, expr: string, datatype?: string): PortSpec => ({ name, type: 'OUTPUT', expr, datatype });
export const variable = (name: string, expr: string): PortSpec => ({ name, type: 'LOCAL VARIABLE', expr });
