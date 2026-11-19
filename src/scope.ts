import { attempt, UnsupportedError } from './errors.ts';
import { translate, type Resolver, type Sql } from './expression.ts';
import type { Port } from './powercenter.ts';

/**
 * Inlining copies a variable's SQL into every expression that uses it, so a chain of variables
 * that each use the previous one twice doubles in size at every step. Past this size the chain
 * is reported instead of growing without bound.
 */
const MAX_VARIABLE_SQL = 100_000;

/**
 * What an expression can refer to by name: the input ports, the local variables and the
 * mapping parameters of one transformation. PowerCenter names are case-insensitive.
 */
export class Scope {
  private readonly values = new Map<string, Sql | UnsupportedError>();
  private readonly parameter: (name: string) => Sql | undefined;

  constructor(parameter: (name: string) => Sql | undefined) {
    this.parameter = parameter;
  }

  define(name: string, value: Sql): void {
    this.values.set(name.toUpperCase(), value);
  }

  /** Resolves a name; this is the Resolver the translator is given. */
  readonly resolve: Resolver = (name) => {
    const value = this.values.get(name.toUpperCase()) ?? this.parameter(name);
    if (value === undefined) throw new UnsupportedError(`unknown port or variable ${name}`);
    if (value instanceof UnsupportedError) throw value;
    return value;
  };

  /**
   * Defines local variables, evaluated top to bottom like PowerCenter does.
   *
   * A variable that reads itself, or one defined below it, sees the previous row's value
   * (a running counter, for example). A select has no equivalent of that, so such a variable
   * is stored as an error: reading it, directly or through another variable, fails.
   */
  defineVariables(variables: Port[]): void {
    const notYetDefined = new Set(variables.map((variable) => variable.name.toUpperCase()));
    for (const variable of variables) {
      const value = attempt(() =>
        translate(variable.expression, (name) => {
          if (notYetDefined.has(name.toUpperCase())) {
            throw new UnsupportedError(`${variable.name} reads the previous row's value of ${name} (stateful variable port)`);
          }
          return this.resolve(name);
        }),
      );
      const tooLarge = !(value instanceof UnsupportedError) && value.text.length > MAX_VARIABLE_SQL;
      this.values.set(
        variable.name.toUpperCase(),
        tooLarge ? new UnsupportedError(`${variable.name} is too large to inline (${value.text.length} characters of SQL)`) : value,
      );
      notYetDefined.delete(variable.name.toUpperCase());
    }
  }
}
