/**
 * Converts PowerCenter mappings into dbt models: one model per target.
 *
 * A model is a chain of CTEs, one per transformation instance, named after it, so every
 * column can be traced back to the mapping. The ModelBuilder walks the connectors backwards
 * from the target and asks the converter of each transformation type for its query.
 * CTEs are added after the CTEs they read from, so the WITH clause is always in dependency order.
 */
import { defaultConverters, type ConversionContext, type Link, type PortReference, type TransformationConverter } from './converters.ts';
import { UnsupportedError } from './errors.ts';
import { atom, type Sql } from './expression.ts';
import { parameterSql } from './parameters.ts';
import {
  findPort,
  isDateType,
  isOutput,
  tableKey,
  type Connector,
  type Folder,
  type Instance,
  type Mapping,
  type TableDefinition,
  type Transformation,
} from './powercenter.ts';
import { Scope } from './scope.ts';
import { columnName, identifier, indent, renderQuery, selectItem, type Select } from './sql.ts';

export interface SourceTable {
  schema: string;
  table: string;
}

export interface DbtModel {
  /** dbt model name, e.g. "stg_orders". */
  name: string;
  /** The PowerCenter mapping the model comes from. */
  mapping: string;
  sql: string;
  /** Things that converted but need a human to look at them. */
  warnings: string[];
  /** The tables the model reads with {{ source() }}. */
  sources: SourceTable[];
}

export interface DbtSource {
  /** dbt source name: the schema owner of the tables, e.g. "raw". */
  name: string;
  tables: string[];
}

export interface ConversionResult {
  models: DbtModel[];
  /** Tables read with {{ source() }}. Tables that another mapping loads are read with {{ ref() }} instead. */
  sources: DbtSource[];
  /** Targets that could not be converted at all, with the reason. */
  errors: string[];
}

/** What the models of one mapping share. Built once per mapping, not once per target. */
interface MappingContext {
  folder: Folder;
  mapping: Mapping;
  /** The connectors that arrive at each instance. */
  incoming: Map<string, Connector[]>;
  /** Tables that some mapping loads, so they are read with ref(). */
  loadedTables: ReadonlySet<string>;
  converters: ReadonlyMap<string, TransformationConverter>;
}

export function convertFolder(folder: Folder, converters: readonly TransformationConverter[] = defaultConverters): ConversionResult {
  const converterByType = new Map(converters.map((converter) => [converter.type, converter]));
  const loadedTables = new Set(folder.mappings.flatMap(targetsOf).map((target) => target.definition));

  const models = new Map<string, DbtModel>();
  const errors: string[] = [];
  for (const mapping of folder.mappings) {
    const context: MappingContext = {
      folder,
      mapping,
      incoming: Map.groupBy(mapping.connectors, (connector) => connector.toInstance),
      loadedTables,
      converters: converterByType,
    };
    for (const target of targetsOf(mapping)) {
      try {
        const model = new ModelBuilder(context).build(target);
        const existing = models.get(model.name);
        if (existing) throw new UnsupportedError(`model "${model.name}" already exists (loaded by mapping ${existing.mapping})`);
        models.set(model.name, model);
      } catch (error) {
        // One target that cannot be converted must not stop the others, whatever the reason.
        const reason = error instanceof UnsupportedError ? error.message : `unexpected ${error}`;
        errors.push(`${mapping.name} -> ${target.definition}: ${reason}`);
      }
    }
  }

  return { models: [...models.values()], sources: groupSources([...models.values()]), errors };
}

const targetsOf = (mapping: Mapping): Instance[] => [...mapping.instances.values()].filter((instance) => instance.kind === 'TARGET');

function groupSources(models: DbtModel[]): DbtSource[] {
  const tablesBySchema = new Map<string, Set<string>>();
  for (const { schema, table } of models.flatMap((model) => model.sources)) {
    tablesBySchema.set(schema, (tablesBySchema.get(schema) ?? new Set()).add(table));
  }
  return [...tablesBySchema]
    .map(([name, tables]) => ({ name, tables: [...tables].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Builds the model of one target. A builder is used once: it is dropped when a build fails. */
class ModelBuilder implements ConversionContext {
  private readonly folder: Folder;
  private readonly mapping: Mapping;
  private readonly incoming: Map<string, Connector[]>;
  private readonly loadedTables: ReadonlySet<string>;
  private readonly converters: ReadonlyMap<string, TransformationConverter>;
  /** CTE name -> body, in dependency order. */
  private readonly ctes = new Map<string, string>();
  private readonly usedInstances = new Set<Instance>();
  private readonly usedSources = new Map<string, SourceTable>();
  private readonly warnings: string[] = [];

  constructor({ folder, mapping, incoming, loadedTables, converters }: MappingContext) {
    this.folder = folder;
    this.mapping = mapping;
    this.incoming = incoming;
    this.loadedTables = loadedTables;
    this.converters = converters;
  }

  build(targetInstance: Instance): DbtModel {
    const target = this.folder.targets.get(targetInstance.definition);
    if (!target) throw new UnsupportedError(`target definition ${targetInstance.definition} not found`);

    this.buildUpstreamOf(targetInstance);
    const final = this.selectTarget(targetInstance, target);
    this.warnAboutMiswiring([targetInstance, ...this.usedInstances]);

    return {
      name: identifier(target.name),
      mapping: this.mapping.name,
      sql: this.render(target.name, final),
      warnings: this.warnings,
      sources: [...this.usedSources.values()],
    };
  }

  // ---- ConversionContext -----------------------------------------------------

  inputsOf(instance: Instance): ReadonlyMap<string, Link> {
    const connectors = this.incoming.get(instance.name) ?? [];
    return new Map(connectors.map((connector) => [connector.toField, { instance: connector.fromInstance, field: connector.fromField }]));
  }

  referenceTo(link: Link): PortReference {
    const instance = this.mapping.instances.get(link.instance);
    if (!instance) throw new UnsupportedError(`instance ${link.instance} not found`);
    const transformation = this.transformationOf(instance);
    const converter = this.converterFor(transformation);
    const relation = this.relation(instance, transformation, converter, converter.outputOf?.(transformation, link.field));
    const port = findPort(transformation, link.field);
    return { relation, column: atom(`${relation}.${columnName(link.field)}`, isDateType(port.datatype)) };
  }

  /** A table that another mapping loads is a dbt ref; any other table is a dbt source. */
  tableOf(sourceInstance: string): string {
    const instance = this.mapping.instances.get(sourceInstance);
    const table = instance && this.folder.sources.get(tableKey(instance.database, instance.definition));
    if (!table) throw new UnsupportedError(`source definition for ${sourceInstance} not found`);

    if (this.loadedTables.has(table.name)) return `{{ ref('${identifier(table.name)}') }}`;
    const source = { schema: identifier(table.owner || 'raw'), table: identifier(table.name) };
    this.usedSources.set(`${source.schema}.${source.table}`, source);
    return `{{ source('${source.schema}', '${source.table}') }}`;
  }

  newScope(): Scope {
    return new Scope((name) => this.parameter(name));
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  // ---- Building ------------------------------------------------------------------

  /**
   * Builds the CTEs upstream of the target, upstream first. The graph is walked with an explicit
   * stack, so each converter then finds its inputs already built and the call stack stays
   * shallow however long the chain of transformations is. A loop in the mapping is caught here.
   */
  private buildUpstreamOf(target: Instance): void {
    const done = new Set<string>();
    const onPath = new Set([target.name]);
    const stack = [{ name: target.name, parents: this.parentsOf(target.name) }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const parent = frame.parents.pop();
      if (parent === undefined) {
        stack.pop();
        onPath.delete(frame.name);
        done.add(frame.name);
        this.buildInstance(frame.name);
      } else if (onPath.has(parent)) {
        throw new UnsupportedError(`the mapping loops back to ${parent}`);
      } else if (!done.has(parent)) {
        onPath.add(parent);
        stack.push({ name: parent, parents: this.parentsOf(parent) });
      }
    }
  }

  /** The instances that feed `name`, last first, so that popping them visits them in order. */
  private parentsOf(name: string): string[] {
    return [...new Set((this.incoming.get(name) ?? []).map((connector) => connector.fromInstance))].reverse();
  }

  /** Sources and the target have no CTE. A Router has one per group, built when a group is first read. */
  private buildInstance(name: string): void {
    const instance = this.mapping.instances.get(name);
    if (instance?.kind !== 'TRANSFORMATION') return;
    const transformation = this.transformationOf(instance);
    const converter = this.converterFor(transformation);
    if (!converter.outputOf) this.relation(instance, transformation, converter, undefined);
  }

  /** The CTE of one output of a transformation instance, built on first use. */
  private relation(instance: Instance, t: Transformation, converter: TransformationConverter, output: string | undefined): string {
    const name = identifier(output ? `${instance.name}__${output}` : instance.name);
    if (!this.ctes.has(name)) {
      const query = converter.convert(instance, t, this, output);
      this.ctes.set(name, `-- ${t.type} ${t.name}\n${renderQuery(query)}`);
      this.usedInstances.add(instance);
    }
    return name;
  }

  /** The final select, which loads every column of the target. */
  private selectTarget(targetInstance: Instance, target: TableDefinition): Select {
    const inputs = this.inputsOf(targetInstance);
    const columns: string[] = [];
    const relations = new Set<string>();
    for (const field of target.fields) {
      const link = inputs.get(field.name);
      if (link) {
        const { relation, column } = this.referenceTo(link);
        relations.add(relation);
        columns.push(selectItem(column, field.name));
      } else {
        this.warn(`target column ${field.name} is not connected; it is loaded as NULL`);
        columns.push(`null as ${columnName(field.name)}`);
      }
    }
    if (relations.size !== 1) {
      throw new UnsupportedError(`target ${target.name} reads from ${relations.size} upstream pipelines (${[...relations].join(', ') || 'none'})`);
    }
    return { columns, from: [...relations][0]! };
  }

  private render(targetName: string, final: Select): string {
    const header = [
      `-- Generated by pwc2dbt from PowerCenter mapping ${this.mapping.name}, target ${targetName}.`,
      ...this.warnings.map((warning) => `-- WARNING: ${warning}`),
    ].join('\n');
    const ctes = [...this.ctes].map(([name, body]) => `${name} as (\n${indent(body)}\n)`).join(',\n\n');
    return `${header}\n\nwith\n\n${ctes}\n\n${renderQuery(final)}\n`;
  }

  // ---- Looking things up ---------------------------------------------------------

  private transformationOf(instance: Instance): Transformation {
    if (instance.kind !== 'TRANSFORMATION') {
      throw new UnsupportedError(`${instance.kind} instance ${instance.name} cannot feed a transformation directly`);
    }
    const transformation = this.mapping.transformations.get(instance.definition);
    if (!transformation) throw new UnsupportedError(`transformation ${instance.definition} not found (mapplets are not supported)`);
    return transformation;
  }

  private converterFor(t: Transformation): TransformationConverter {
    const converter = this.converters.get(t.type);
    if (!converter) throw new UnsupportedError(`${t.type} transformation ${t.name} is not supported`);
    return converter;
  }

  /** $$PARAM as a dbt variable, or nothing if the mapping declares no such parameter. */
  private parameter(name: string): Sql | undefined {
    const parameter = this.mapping.variables.get(name.toUpperCase());
    return parameter && parameterSql(parameter);
  }

  // ---- Wiring check -----------------------------------------------------------------

  /**
   * A -> B although the upstream transformation also has an output port named B is almost always
   * a mis-drawn link (swapped columns). The wiring is converted as drawn, with a warning.
   */
  private warnAboutMiswiring(instances: Iterable<Instance>): void {
    for (const instance of instances) {
      for (const { fromInstance, fromField, toInstance, toField } of this.incoming.get(instance.name) ?? []) {
        if (fromField !== toField && this.hasOutputPort(fromInstance, toField)) {
          this.warn(`suspicious wiring: ${fromInstance}.${fromField} feeds ${toInstance}.${toField}, but ${fromInstance} also has a port named ${toField}`);
        }
      }
    }
  }

  private hasOutputPort(instanceName: string, portName: string): boolean {
    const instance = this.mapping.instances.get(instanceName);
    if (instance?.kind !== 'TRANSFORMATION') return false;
    const port = this.mapping.transformations.get(instance.definition)?.portsByName.get(portName);
    return port !== undefined && isOutput(port);
  }
}
