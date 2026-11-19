/**
 * Reads a PowerCenter repository export (the XML from Repository Manager or
 * `pmrep objectexport`) into a small typed model.
 *
 * Only what the converter needs is kept: source and target definitions, mappings with
 * their transformations (ports, groups, attributes), instances and connectors.
 * Sessions, workflows and configs are ignored.
 */
import { XMLParser } from 'fast-xml-parser';
import { UnsupportedError } from './errors.ts';

/** A column of a SOURCE or TARGET definition. */
export interface TableField {
  name: string;
  datatype: string;
  precision: number;
  scale: number;
}

/** A SOURCE or TARGET definition, i.e. a physical table. */
export interface TableDefinition {
  name: string;
  /** Schema owner, e.g. "RAW". Becomes the dbt source name. */
  owner: string;
  /** Database the table was imported from (DBDNAME). Empty for targets. */
  database: string;
  fields: TableField[];
}

/** A port (column) of a transformation. */
export interface Port {
  name: string;
  datatype: string;
  /** INPUT, OUTPUT, INPUT/OUTPUT, LOCAL VARIABLE, INPUT/MASTER, INPUT/OUTPUT/MASTER, ... */
  portType: string;
  /** Expression of OUTPUT and LOCAL VARIABLE ports; "" otherwise. */
  expression: string;
  /** Group the port belongs to (Router and Union); "" otherwise. */
  group: string;
  /** Router output ports: the input port they copy. */
  refField: string;
  /** Aggregator: the port is a group-by key. */
  isGroupBy: boolean;
}

/** A port group: Router output groups, Union input and output groups. */
export interface PortGroup {
  name: string;
  /** INPUT, OUTPUT or OUTPUT/DEFAULT */
  type: string;
  /** Router condition of the group; "" otherwise. */
  expression: string;
}

export interface Transformation {
  name: string;
  /** e.g. "Expression", "Joiner", "Source Qualifier", "Custom Transformation" */
  type: string;
  ports: Port[];
  /** The same ports by name, so looking one up does not scan wide transformations. */
  portsByName: Map<string, Port>;
  groups: PortGroup[];
  /** TABLEATTRIBUTE settings, e.g. "Join Type" -> "Normal Join". */
  attributes: Map<string, string>;
  /** Union: which input port feeds which output port. */
  fieldDependencies: { input: string; output: string }[];
}

/** A use of a definition inside a mapping. One definition can have several instances. */
export interface Instance {
  name: string;
  /** SOURCE, TARGET or TRANSFORMATION */
  kind: string;
  /** The source, target or transformation definition behind the instance. */
  definition: string;
  /** Source instances: the database the definition comes from. */
  database: string;
}

/** A port-to-port link between two instances. */
export interface Connector {
  fromInstance: string;
  fromField: string;
  toInstance: string;
  toField: string;
}

/** A mapping parameter or variable such as $$RUN_DATE. */
export interface MappingVariable {
  name: string;
  datatype: string;
  defaultValue: string;
}

export interface Mapping {
  name: string;
  /** The mapping's own transformations plus the folder's reusable ones. */
  transformations: Map<string, Transformation>;
  instances: Map<string, Instance>;
  connectors: Connector[];
  /** Keyed by upper-case name: PowerCenter names are case-insensitive. */
  variables: Map<string, MappingVariable>;
}

export interface Folder {
  name: string;
  /** Keyed by tableKey(): two databases may hold a table of the same name. */
  sources: Map<string, TableDefinition>;
  targets: Map<string, TableDefinition>;
  mappings: Mapping[];
}

// ---------------------------------------------------------------------------
// Small questions about the model
// ---------------------------------------------------------------------------

export const isInput = (port: Port): boolean => port.portType.includes('INPUT');
export const isOutput = (port: Port): boolean => port.portType.includes('OUTPUT');
export const isVariable = (port: Port): boolean => port.portType === 'LOCAL VARIABLE';
export const isMaster = (port: Port): boolean => port.portType.includes('MASTER');
export const isDateType = (datatype: string): boolean => /date|time/i.test(datatype);

export const tableKey = (database: string, name: string): string => `${database}/${name}`;

export function findPort(transformation: Transformation, name: string): Port {
  const port = transformation.portsByName.get(name);
  if (!port) throw new UnsupportedError(`port ${name} not found on ${transformation.name}`);
  return port;
}

// ---------------------------------------------------------------------------
// Reading the export
// ---------------------------------------------------------------------------

/**
 * Exports declare their own encoding (usually Windows-1252), so the raw bytes are
 * decoded with it instead of being assumed to be UTF-8.
 */
export function decodeExport(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const encoding = /encoding="([^"]+)"/i.exec(head)?.[1] ?? 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

export function parseExport(xml: string): Folder[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    // Expressions contain numeric character references such as &#xD;&#xA;.
    htmlEntities: true,
    // Every element is a list, so one child and many children look the same.
    // Attributes stay plain strings, which is what attr() relies on.
    isArray: (_name, _path, _isLeaf, isAttribute) => !isAttribute,
    // Sessions, workflows and configs are never read: leave their (often large) subtrees unparsed.
    stopNodes: ['*.SESSION', '*.WORKFLOW', '*.WORKLET', '*.CONFIG', '*.SCHEDULER', '*.TASK'],
  });
  const folders = children(parser.parse(xml) as XmlNode, 'POWERMART')
    .flatMap((powermart) => children(powermart, 'REPOSITORY'))
    .flatMap((repository) => children(repository, 'FOLDER'))
    .map(parseFolder);

  if (folders.length === 0) throw new Error('no POWERMART/REPOSITORY/FOLDER found: is this a PowerCenter export?');
  return folders;
}

type XmlNode = Record<string, unknown>;

const children = (node: XmlNode, tag: string): XmlNode[] => (node[tag] as XmlNode[] | undefined) ?? [];
const attr = (node: XmlNode, name: string): string => (node[name] as string | undefined) ?? '';
const byName = <T extends { name: string }>(items: T[]): Map<string, T> => new Map(items.map((item) => [item.name, item]));

function parseFolder(node: XmlNode): Folder {
  const reusable = children(node, 'TRANSFORMATION').map(parseTransformation);
  const sources = children(node, 'SOURCE').map((source) => parseTable(source, 'SOURCEFIELD'));
  return {
    name: attr(node, 'NAME'),
    sources: new Map(sources.map((source) => [tableKey(source.database, source.name), source])),
    targets: byName(children(node, 'TARGET').map((target) => parseTable(target, 'TARGETFIELD'))),
    mappings: children(node, 'MAPPING').map((mapping) => parseMapping(mapping, reusable)),
  };
}

function parseTable(node: XmlNode, fieldTag: string): TableDefinition {
  return {
    name: attr(node, 'NAME'),
    owner: attr(node, 'OWNERNAME'),
    database: attr(node, 'DBDNAME'),
    fields: children(node, fieldTag).map((field) => ({
      name: attr(field, 'NAME'),
      datatype: attr(field, 'DATATYPE'),
      precision: Number(attr(field, 'PRECISION')),
      scale: Number(attr(field, 'SCALE')),
    })),
  };
}

function parseMapping(node: XmlNode, reusable: Transformation[]): Mapping {
  const variables = children(node, 'MAPPINGVARIABLE').map((variable) => ({
    name: attr(variable, 'NAME'),
    datatype: attr(variable, 'DATATYPE'),
    defaultValue: attr(variable, 'DEFAULTVALUE'),
  }));
  return {
    name: attr(node, 'NAME'),
    transformations: byName([...reusable, ...children(node, 'TRANSFORMATION').map(parseTransformation)]),
    instances: byName(
      children(node, 'INSTANCE').map((instance) => ({
        name: attr(instance, 'NAME'),
        kind: attr(instance, 'TYPE'),
        definition: attr(instance, 'TRANSFORMATION_NAME'),
        database: attr(instance, 'DBDNAME'),
      })),
    ),
    connectors: children(node, 'CONNECTOR').map((connector) => ({
      fromInstance: attr(connector, 'FROMINSTANCE'),
      fromField: attr(connector, 'FROMFIELD'),
      toInstance: attr(connector, 'TOINSTANCE'),
      toField: attr(connector, 'TOFIELD'),
    })),
    variables: new Map(variables.map((variable) => [variable.name.toUpperCase(), variable])),
  };
}

function parseTransformation(node: XmlNode): Transformation {
  const ports = children(node, 'TRANSFORMFIELD').map((field) => ({
    name: attr(field, 'NAME'),
    datatype: attr(field, 'DATATYPE'),
    portType: attr(field, 'PORTTYPE'),
    expression: attr(field, 'EXPRESSION'),
    group: attr(field, 'GROUP'),
    refField: attr(field, 'REF_FIELD'),
    isGroupBy: attr(field, 'EXPRESSIONTYPE') === 'GROUPBY',
  }));
  return {
    name: attr(node, 'NAME'),
    type: attr(node, 'TYPE'),
    ports,
    portsByName: byName(ports),
    groups: children(node, 'GROUP').map((group) => ({
      name: attr(group, 'NAME'),
      type: attr(group, 'TYPE'),
      expression: attr(group, 'EXPRESSION'),
    })),
    attributes: new Map(children(node, 'TABLEATTRIBUTE').map((a) => [attr(a, 'NAME'), attr(a, 'VALUE')])),
    fieldDependencies: children(node, 'FIELDDEPENDENCY').map((d) => ({
      input: attr(d, 'INPUTFIELD'),
      output: attr(d, 'OUTPUTFIELD'),
    })),
  };
}
