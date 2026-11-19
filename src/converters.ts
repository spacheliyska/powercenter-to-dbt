/**
 * One converter per PowerCenter transformation type. Each turns an instance of its
 * transformation into a query: the body of one CTE in the generated model.
 *
 * Converters only know the ConversionContext interface, never the model builder behind it.
 * Supporting a new transformation type means writing one class and listing it in
 * `defaultConverters`; nothing else changes.
 */
import { attempt, UnsupportedError } from './errors.ts';
import { atom, translate, type Sql } from './expression.ts';
import {
  findPort,
  isInput,
  isMaster,
  isOutput,
  isVariable,
  type Instance,
  type Port,
  type PortGroup,
  type Transformation,
} from './powercenter.ts';
import type { Scope } from './scope.ts';
import { columnName, identifier, selectItem, type Query, type Select } from './sql.ts';

/** The upstream end of a connector: the port of an instance that feeds another port. */
export interface Link {
  instance: string;
  field: string;
}

/** An upstream port as a converter reads it: the CTE it lives in and a reference to its column. */
export interface PortReference {
  relation: string;
  column: Sql;
}

/** What a converter may ask of the model being built. */
export interface ConversionContext {
  /** Which upstream port feeds each input port of the instance. */
  inputsOf(instance: Instance): ReadonlyMap<string, Link>;
  /** Locates an upstream port, building the CTEs it depends on if that has not happened yet. */
  referenceTo(link: Link): PortReference;
  /** The dbt `source()` or `ref()` call that reads the table behind a source instance. */
  tableOf(sourceInstance: string): string;
  /** A scope that already resolves the mapping's parameters. */
  newScope(): Scope;
  /** Reports something that converted but deserves a human look. */
  warn(message: string): void;
}

export interface TransformationConverter {
  /** The PowerCenter transformation type this converter handles, e.g. "Joiner". */
  readonly type: string;
  /** For transformations with several outputs (a Router has one per group): the output a port belongs to. */
  outputOf?(transformation: Transformation, portName: string): string | undefined;
  /** The query behind one instance of the transformation. */
  convert(instance: Instance, transformation: Transformation, context: ConversionContext, output?: string): Query;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NULL = atom('null');

/** The one distinct value in `values`. Most transformations read from a single pipeline. */
function exactlyOne(values: Iterable<string>, what: string): string {
  const distinct = [...new Set(values)];
  if (distinct.length !== 1) {
    throw new UnsupportedError(`${what} reads from ${distinct.length} upstream pipelines (${distinct.join(', ') || 'none'})`);
  }
  return distinct[0]!;
}

/** The input ports of an instance as a scope for its expressions, and the CTEs they are read from. */
function readPorts(context: ConversionContext, instance: Instance, t: Transformation): { scope: Scope; relations: Set<string> } {
  const inputs = context.inputsOf(instance);
  const scope = context.newScope();
  const relations = new Set<string>();
  for (const port of t.ports.filter(isInput)) {
    const link = inputs.get(port.name);
    if (link) {
      const { relation, column } = context.referenceTo(link);
      relations.add(relation);
      scope.define(port.name, column);
    } else {
      scope.define(port.name, NULL); // an unconnected input port reads as NULL
    }
  }
  scope.defineVariables(t.ports.filter(isVariable));
  return { scope, relations };
}

/** readPorts for the transformations that read a single pipeline: also gives the relation to select from. */
function readInput(context: ConversionContext, instance: Instance, t: Transformation): { scope: Scope; from: string } {
  const { scope, relations } = readPorts(context, instance, t);
  return { scope, from: exactlyOne(relations, `${t.type.toLowerCase()} ${t.name}`) };
}

/** The select-list item of an output port. An expression that cannot be translated becomes NULL plus a warning. */
function outputItem(context: ConversionContext, t: Transformation, port: Port, scope: Scope): string {
  const expression = port.portType === 'OUTPUT' ? port.expression : port.name; // INPUT/OUTPUT ports pass their input on
  const sql = attempt(() => translate(expression, scope.resolve));
  if (sql instanceof UnsupportedError) {
    const original = port.expression.replace(/\s+/g, ' ').trim();
    context.warn(`${t.name}.${port.name} set to NULL: ${sql.message}. Informatica expression: ${original}`);
    return `null /* UNSUPPORTED: see warning above */ as ${columnName(port.name)}`;
  }
  return selectItem(sql, port.name);
}

/** Output ports that forward the input port of the same name (Filter, Sorter, Joiner). */
function forwardedItems(t: Transformation, scope: Scope): string[] {
  return t.ports.filter(isOutput).map((port) => selectItem(scope.resolve(port.name), port.name));
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

class SourceQualifierConverter implements TransformationConverter {
  readonly type = 'Source Qualifier';

  convert(instance: Instance, t: Transformation, context: ConversionContext): Query {
    for (const setting of ['Sql Query', 'User Defined Join']) {
      if (t.attributes.get(setting)) throw new UnsupportedError(`${t.name} has a "${setting}" override; port that SQL by hand`);
    }
    for (const setting of ['Pre SQL', 'Post SQL']) {
      if (t.attributes.get(setting)) context.warn(`${t.name}: "${setting}" is ignored; use a dbt hook if it is still needed`);
    }
    // The source filter is database SQL (Oracle here), not an Informatica expression, so it is copied as it is.
    const sourceFilter = t.attributes.get('Source Filter');
    if (sourceFilter) context.warn(`${t.name}: source filter copied verbatim, check it is valid in the target warehouse`);

    const inputs = context.inputsOf(instance);
    const source = exactlyOne([...inputs.values()].map((link) => link.instance), `source qualifier ${t.name}`);
    const alias = identifier(source);
    const columns = t.ports.filter(isOutput).flatMap((port) => {
      const link = inputs.get(port.name);
      return link ? [selectItem(atom(`${alias}.${columnName(link.field)}`), port.name)] : [];
    });

    return {
      columns,
      from: `${context.tableOf(source)} as ${alias}`,
      where: sourceFilter || undefined,
      distinct: t.attributes.get('Select Distinct') === 'YES',
    };
  }
}

class ExpressionConverter implements TransformationConverter {
  readonly type = 'Expression';

  convert(instance: Instance, t: Transformation, context: ConversionContext): Query {
    const { scope, from } = readInput(context, instance, t);
    return { columns: t.ports.filter(isOutput).map((port) => outputItem(context, t, port, scope)), from };
  }
}

class FilterConverter implements TransformationConverter {
  readonly type = 'Filter';

  convert(instance: Instance, t: Transformation, context: ConversionContext): Query {
    const { scope, from } = readInput(context, instance, t);
    const condition = t.attributes.get('Filter Condition') || 'TRUE';
    return { columns: forwardedItems(t, scope), from, where: translate(condition, scope.resolve).text };
  }
}

/** A table or view has no row order, so a Sorter only matters when it removes duplicates. */
class SorterConverter implements TransformationConverter {
  readonly type = 'Sorter';

  convert(instance: Instance, t: Transformation, context: ConversionContext): Query {
    const { scope, from } = readInput(context, instance, t);
    return {
      note: 'sort order dropped: a table or view has no row order',
      columns: forwardedItems(t, scope),
      from,
      distinct: t.attributes.get('Distinct') === 'YES',
    };
  }
}

/** How each join type is written. `first` is the side whose rows are all kept, so it goes on the left. */
const JOINS = new Map<string, { keyword: string; first: 'master' | 'detail' }>([
  ['Normal Join', { keyword: 'inner join', first: 'detail' }],
  ['Master Outer Join', { keyword: 'left join', first: 'detail' }], // Informatica keeps all *detail* rows
  ['Detail Outer Join', { keyword: 'left join', first: 'master' }], // ... and here all master rows
  ['Full Outer Join', { keyword: 'full outer join', first: 'detail' }],
]);

class JoinerConverter implements TransformationConverter {
  readonly type = 'Joiner';

  convert(instance: Instance, t: Transformation, context: ConversionContext): Query {
    const joinType = t.attributes.get('Join Type') ?? 'Normal Join';
    const join = JOINS.get(joinType);
    if (!join) throw new UnsupportedError(`join type "${joinType}" in ${t.name} is not supported`);

    const { scope } = readPorts(context, instance, t);
    const inputs = context.inputsOf(instance);
    const relationOf = (side: 'master' | 'detail'): string => {
      const relations = t.ports
        .filter((port) => isMaster(port) === (side === 'master'))
        .map((port) => inputs.get(port.name))
        .filter((link) => link !== undefined)
        .map((link) => context.referenceTo(link).relation);
      return exactlyOne(relations, `${side} side of joiner ${t.name}`);
    };
    const master = relationOf('master');
    const detail = relationOf('detail');
    if (master === detail) throw new UnsupportedError(`joiner ${t.name} joins ${master} to itself`);

    const condition = translate(t.attributes.get('Join Condition') ?? '', scope.resolve).text;
    const [left, right] = join.first === 'master' ? [master, detail] : [detail, master];
    return {
      note: `${joinType} (master ${master}, detail ${detail})`,
      columns: forwardedItems(t, scope),
      from: `${left}\n    ${join.keyword} ${right}\n        on ${condition}`,
    };
  }
}

class AggregatorConverter implements TransformationConverter {
  readonly type = 'Aggregator';

  convert(instance: Instance, t: Transformation, context: ConversionContext): Query {
    const { scope, from } = readInput(context, instance, t);
    const item = (port: Port): string => {
      if (port.isGroupBy || port.portType === 'OUTPUT') return outputItem(context, t, port, scope);
      // A port that is neither grouped nor aggregated: Informatica returns its value from the last row of each group.
      context.warn(`${t.name}.${port.name}: not aggregated; Informatica returns the last row's value, any_value() returns an arbitrary one`);
      return selectItem(atom(`any_value(${scope.resolve(port.name).text})`), port.name);
    };
    return {
      columns: t.ports.filter(isOutput).map(item),
      from,
      groupBy: t.ports.filter((port) => port.isGroupBy).map((port) => scope.resolve(port.name).text),
    };
  }
}

/** A Router sends a row to every group whose condition holds, so each connected group becomes its own CTE. */
class RouterConverter implements TransformationConverter {
  readonly type = 'Router';

  outputOf(t: Transformation, portName: string): string {
    return findPort(t, portName).group;
  }

  convert(instance: Instance, t: Transformation, context: ConversionContext, groupName?: string): Query {
    const { scope, from } = readInput(context, instance, t);
    const groups = t.groups.filter((group) => group.type.startsWith('OUTPUT'));
    const group = groups.find((candidate) => candidate.name === groupName);
    if (!group) throw new UnsupportedError(`router ${t.name} has no output group ${groupName}`);

    return {
      note: `group ${group.name}`,
      columns: t.ports.filter((port) => port.group === group.name).map((port) => selectItem(scope.resolve(port.refField), port.name)),
      from,
      where: this.condition(group, groups, scope),
    };
  }

  /** A NULL condition counts as false. The default group takes the rows that no other group matched. */
  private condition(group: PortGroup, groups: PortGroup[], scope: Scope): string {
    if (group.type !== 'OUTPUT/DEFAULT') return translate(group.expression, scope.resolve).text;

    const matched = groups
      .filter((other) => other.type === 'OUTPUT')
      .map((other) => `coalesce(${translate(other.expression, scope.resolve).text}, false)`);
    return matched.length > 0 ? `not (${matched.join(' or ')})` : 'true';
  }
}

/** PowerCenter implements the Union transformation as a custom transformation. */
class UnionConverter implements TransformationConverter {
  readonly type = 'Custom Transformation';

  convert(instance: Instance, t: Transformation, context: ConversionContext): Query {
    const module = t.attributes.get('Module Identifier');
    if (module !== 'pmuniontrans') throw new UnsupportedError(`Custom Transformation ${t.name} (module "${module}") is not supported`);

    const outputGroup = t.groups.find((group) => group.type === 'OUTPUT');
    if (!outputGroup) throw new UnsupportedError(`union ${t.name} has no output group`);

    const inputs = context.inputsOf(instance);
    const outputs = t.ports.filter((port) => port.group === outputGroup.name);
    const dependencies = Map.groupBy(t.fieldDependencies, (dependency) => dependency.output);

    // One select per input group that is connected; an unconnected group contributes no rows.
    const branch = (group: PortGroup): Select | undefined => {
      const ports = t.ports.filter((port) => port.group === group.name);
      if (!ports.some((port) => inputs.has(port.name))) return undefined;

      const names = new Set(ports.map((port) => port.name));
      const references = outputs.map((output, position) => {
        // The export says which input port feeds which output port; without it ports pair up by position.
        const input = dependencies.get(output.name)?.find((dependency) => names.has(dependency.input))?.input ?? ports[position]?.name;
        const link = input === undefined ? undefined : inputs.get(input);
        return link && context.referenceTo(link);
      });
      const relations = references.filter((reference) => reference !== undefined).map((reference) => reference.relation);
      return {
        note: `input group ${group.name}`,
        columns: outputs.map((output, i) => {
          const reference = references[i];
          return reference ? selectItem(reference.column, output.name) : `null as ${columnName(output.name)}`;
        }),
        from: exactlyOne(relations, `union group ${group.name}`),
      };
    };

    const branches = t.groups.filter((group) => group.type === 'INPUT').map(branch).filter((select) => select !== undefined);
    if (branches.length === 0) throw new UnsupportedError(`union ${t.name} has no connected input groups`);
    return branches;
  }
}

export const defaultConverters: readonly TransformationConverter[] = [
  new SourceQualifierConverter(),
  new ExpressionConverter(),
  new FilterConverter(),
  new SorterConverter(),
  new JoinerConverter(),
  new AggregatorConverter(),
  new RouterConverter(),
  new UnionConverter(),
];
