/**
 * Translates the Informatica transformation language (the expressions of Expression,
 * Aggregator, Filter, Router and Joiner transformations) into DuckDB SQL.
 *
 * tokenize -> parse into a small AST (with Informatica's operator precedence) -> render SQL,
 * adding parentheses only where SQL's own precedence would change the meaning.
 *
 * Anything that cannot be translated faithfully throws UnsupportedError, so the caller can
 * flag it instead of emitting SQL that silently means something else.
 */
import { UnsupportedError } from './errors.ts';

/** A rendered SQL fragment. */
export interface Sql {
  text: string;
  /** How tightly the outermost operator binds (see SQL_PRECEDENCE). */
  precedence: number;
  /** True for date/time values: TRUNC and TO_CHAR depend on it. */
  isDate: boolean;
}

/** Turns a port, variable or parameter name used in an expression into SQL. */
export type Resolver = (name: string) => Sql;

// SQL (DuckDB/Postgres) operator precedence, weakest first.
const SQL_PRECEDENCE = { or: 1, and: 2, not: 3, is: 4, comparison: 5, additive: 6, multiplicative: 7, unary: 8, atom: 9 } as const;

export const atom = (text: string, isDate = false): Sql => ({ text, precedence: SQL_PRECEDENCE.atom, isDate });

export function translate(expression: string, resolve: Resolver): Sql {
  try {
    return render(new Parser(tokenize(expression)).parse(), resolve);
  } catch (error) {
    // Long operator chains are handled with loops; only thousands of nested levels get here.
    if (error instanceof RangeError) throw new UnsupportedError('expression is nested too deeply to translate');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; text: string; upper: string }
  | { kind: 'number' | 'string' | 'op'; text: string }
  | { kind: 'end'; text: '' };

const END: Token = { kind: 'end', text: '' };

/**
 * Whitespace and comments (-- or //) come first and are skipped. After them, one alternative
 * per token kind. `unknown` catches anything else, including a string that is never closed.
 */
const TOKEN_PATTERN =
  /\s+|--.*|\/\/.*|(?<number>\d+(?:\.\d*)?|\.\d+)|'(?<string>(?:[^']|'')*)'|(?<name>\$?\$?[A-Za-z_]\w*)|(?<op><>|!=|\^=|<=|>=|\|\||[-+*\/%=<>(),])|(?<unknown>.)/g;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (const { groups, index } of source.matchAll(TOKEN_PATTERN)) {
    const { number, string, name, op, unknown } = groups!;
    if (unknown !== undefined) throw new UnsupportedError(`cannot read expression near "${source.slice(index, index + 20)}"`);
    if (number !== undefined) tokens.push({ kind: 'number', text: number });
    else if (string !== undefined) tokens.push({ kind: 'string', text: string.replaceAll("''", "'") });
    else if (name !== undefined) tokens.push({ kind: 'name', text: name, upper: name.toUpperCase() });
    else if (op !== undefined) tokens.push({ kind: 'op', text: op });
  }
  tokens.push(END);
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Node =
  | { kind: 'number'; text: string }
  | { kind: 'string'; value: string }
  | { kind: 'keyword'; value: 'TRUE' | 'FALSE' | 'NULL' }
  | { kind: 'name'; name: string }
  | { kind: 'star' }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'unary'; op: '-' | '+' | 'NOT'; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node };

interface BinaryOperator {
  /** Informatica precedence: a higher level binds tighter. */
  level: number;
  /** The SQL spelling and the precedence of the SQL expression it produces. */
  sql: string;
  precedence: number;
}

// Informatica gives NOT, unlike SQL, a unary operator that binds tighter than any binary one.
const { or, and, comparison, additive, multiplicative } = SQL_PRECEDENCE;
const BINARY_OPERATORS = new Map<string, BinaryOperator>([
  ['OR', { level: 1, sql: 'or', precedence: or }],
  ['AND', { level: 2, sql: 'and', precedence: and }],
  ['=', { level: 3, sql: '=', precedence: comparison }],
  ['<>', { level: 3, sql: '<>', precedence: comparison }],
  ['!=', { level: 3, sql: '<>', precedence: comparison }],
  ['^=', { level: 3, sql: '<>', precedence: comparison }],
  ['<', { level: 4, sql: '<', precedence: comparison }],
  ['<=', { level: 4, sql: '<=', precedence: comparison }],
  ['>', { level: 4, sql: '>', precedence: comparison }],
  ['>=', { level: 4, sql: '>=', precedence: comparison }],
  ['||', { level: 5, sql: 'concat', precedence: SQL_PRECEDENCE.atom }], // rendered as concat(), see renderBinary
  ['+', { level: 6, sql: '+', precedence: additive }],
  ['-', { level: 6, sql: '-', precedence: additive }],
  ['*', { level: 7, sql: '*', precedence: multiplicative }],
  ['/', { level: 7, sql: '/', precedence: multiplicative }],
  ['%', { level: 7, sql: '%', precedence: multiplicative }],
]);

const describe = (token: Token): string => (token.kind === 'end' ? 'end of expression' : `"${token.text}"`);

class Parser {
  private readonly tokens: Token[];
  private position = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): Node {
    const node = this.parseBinary(1);
    if (this.peek().kind !== 'end') throw new UnsupportedError(`unexpected ${describe(this.peek())}`);
    return node;
  }

  /** Precedence climbing: parses operators that bind at least as tight as `minLevel`. */
  private parseBinary(minLevel: number): Node {
    let left = this.parseUnary();
    for (let next = this.peekOperator(); next && next.level >= minLevel; next = this.peekOperator()) {
      this.position++;
      left = { kind: 'binary', op: next.op, left, right: this.parseBinary(next.level + 1) };
    }
    return left;
  }

  private parseUnary(): Node {
    const op = this.peekUnaryOperator();
    if (!op) return this.parsePrimary();
    this.position++;
    return { kind: 'unary', op, operand: this.parseUnary() };
  }

  private parsePrimary(): Node {
    const token = this.next();
    switch (token.kind) {
      case 'number':
        return { kind: 'number', text: token.text };
      case 'string':
        return { kind: 'string', value: token.text };
      case 'name':
        return this.at('(') ? { kind: 'call', name: token.upper, args: this.parseArguments() } : nameNode(token);
      case 'op':
        if (token.text === '(') {
          const inner = this.parseBinary(1);
          this.expect(')');
          return inner;
        }
        if (token.text === '*') return { kind: 'star' }; // only valid inside COUNT(*)
    }
    throw new UnsupportedError(`unexpected ${describe(token)}`);
  }

  private parseArguments(): Node[] {
    this.expect('(');
    const args: Node[] = [];
    if (!this.at(')')) {
      do args.push(this.parseBinary(1));
      while (this.accept(','));
    }
    this.expect(')');
    return args;
  }

  private peekOperator(): { op: string; level: number } | undefined {
    const token = this.peek();
    if (token.kind !== 'op' && token.kind !== 'name') return undefined;
    const op = token.kind === 'name' ? token.upper : token.text;
    const operator = BINARY_OPERATORS.get(op);
    return operator && { op, level: operator.level };
  }

  private peekUnaryOperator(): '-' | '+' | 'NOT' | undefined {
    const token = this.peek();
    if (token.kind === 'name') return token.upper === 'NOT' ? 'NOT' : undefined;
    return token.kind === 'op' && (token.text === '-' || token.text === '+') ? token.text : undefined;
  }

  private peek(): Token {
    return this.tokens[this.position]!;
  }

  private next(): Token {
    return this.tokens[this.position++]!;
  }

  /** Is the next token this operator or punctuation (and not, say, a string with the same text)? */
  private at(text: string): boolean {
    const token = this.peek();
    return token.kind === 'op' && token.text === text;
  }

  private accept(text: string): boolean {
    if (!this.at(text)) return false;
    this.position++;
    return true;
  }

  private expect(text: string): void {
    if (!this.accept(text)) throw new UnsupportedError(`expected "${text}" but found ${describe(this.peek())}`);
  }
}

/** A bare word is TRUE, FALSE, NULL or the name of a port, variable or parameter. */
function nameNode(token: Extract<Token, { kind: 'name' }>): Node {
  const { text, upper } = token;
  return upper === 'TRUE' || upper === 'FALSE' || upper === 'NULL' ? { kind: 'keyword', value: upper } : { kind: 'name', name: text };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

type Render = (node: Node) => Sql;

/** Session values that look like port names. */
const SESSION_VALUES = new Map([
  ['SYSDATE', atom('current_timestamp', true)],
  ['SESSSTARTTIME', atom('current_timestamp', true)],
]);

function render(node: Node, resolve: Resolver): Sql {
  const renderChild: Render = (child) => render(child, resolve);
  switch (node.kind) {
    case 'number':
      return atom(node.text);
    case 'string':
      return atom(`'${node.value.replaceAll("'", "''")}'`);
    case 'keyword':
      return atom(node.value.toLowerCase());
    case 'name':
      return SESSION_VALUES.get(node.name.toUpperCase()) ?? resolve(node.name);
    case 'star':
      throw new UnsupportedError("'*' is only valid as COUNT(*)");
    case 'unary':
      return renderUnary(node, renderChild);
    case 'binary':
      return renderBinary(node, renderChild);
    case 'call': {
      const translateCall = FUNCTIONS.get(node.name);
      if (!translateCall) throw new UnsupportedError(`function ${node.name}() is not supported`);
      return translateCall(node.args, renderChild);
    }
  }
}

function renderUnary(node: Extract<Node, { kind: 'unary' }>, render: Render): Sql {
  const operand = render(node.operand);
  if (node.op === '+') return operand;
  if (node.op === 'NOT') return { text: `not ${wrap(operand, SQL_PRECEDENCE.not)}`, precedence: SQL_PRECEDENCE.not, isDate: false };
  const text = wrap(operand, SQL_PRECEDENCE.unary);
  // "--x" would start a SQL comment.
  return { text: text.startsWith('-') ? `-(${text})` : `-${text}`, precedence: SQL_PRECEDENCE.unary, isDate: false };
}

type BinaryNode = Extract<Node, { kind: 'binary' }>;

/**
 * A chain such as A + B + C + ... parses into a left-deep tree. Walking its left spine with a
 * loop, instead of recursing once per operand, keeps very long chains off the call stack.
 */
function renderBinary(node: BinaryNode, render: Render): Sql {
  if (node.op === '||') return renderConcat(node, render);
  const spine: BinaryNode[] = [];
  let leftmost: Node = node;
  while (leftmost.kind === 'binary' && leftmost.op !== '||') {
    spine.push(leftmost);
    leftmost = leftmost.left;
  }
  return spine.reduceRight((left, { op, right }) => applyOperator(op, left, render(right)), render(leftmost));
}

function applyOperator(op: string, left: Sql, right: Sql): Sql {
  const { sql, precedence } = BINARY_OPERATORS.get(op)!;
  // Left-associative: an equal-precedence operand needs parentheses on the right, as in a - (b - c).
  // Comparisons cannot be chained in SQL, so they need them on the left as well.
  const leftMin = precedence === comparison ? precedence + 1 : precedence;
  return { text: `${wrap(left, leftMin)} ${sql} ${wrap(right, precedence + 1)}`, precedence, isDate: false };
}

/**
 * Informatica's || skips a NULL operand where SQL's || returns NULL; concat() skips NULLs too.
 * A whole chain becomes one concat(a, b, c): it reads better, and concatenating every column
 * (for a hash) is common enough that the chain must not recurse once per operand.
 * (When every operand is NULL, Informatica gives NULL and concat() gives ''. See the README.)
 */
function renderConcat(node: BinaryNode, render: Render): Sql {
  const operands: Node[] = [];
  const pending: Node[] = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.kind === 'binary' && current.op === '||') pending.push(current.right, current.left);
    else operands.push(current);
  }
  return atom(`concat(${operands.map((operand) => render(operand).text).join(', ')})`);
}

/** Parenthesizes `sql` if it binds weaker than `minPrecedence`. */
function wrap(sql: Sql, minPrecedence: number): string {
  return sql.precedence < minPrecedence ? `(${sql.text})` : sql.text;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

type FunctionTranslator = (args: Node[], render: Render) => Sql;

/** The same name and meaning in DuckDB. */
const sameName =
  (name: string): FunctionTranslator =>
  (args, render) =>
    atom(`${name.toLowerCase()}(${args.map((arg) => render(arg).text).join(', ')})`);

const FUNCTIONS = new Map<string, FunctionTranslator>([
  ['IIF', iif],
  ['DECODE', decode],
  ['ISNULL', isNull],
  ['SUBSTR', substr],
  ['COUNT', count],
  ['TRUNC', trunc],
  ['TO_CHAR', toChar],
  ['TO_DATE', toDate],
  ['DATE_DIFF', dateDiff],
  ...['SUM', 'AVG', 'MIN', 'MAX'].map((name) => [name, aggregate(name)] as const),
  ...['UPPER', 'LOWER', 'LTRIM', 'RTRIM', 'LENGTH', 'CONCAT', 'ABS', 'CEIL', 'FLOOR', 'POWER', 'SQRT'].map(
    (name) => [name, sameName(name)] as const,
  ),
]);

/** Checks the number of arguments and gives each one its own type, so callers need no assertions. */
function arity(name: string, args: Node[], min: 1, max: 1): [Node];
function arity(name: string, args: Node[], min: 1, max: 2): [Node, Node?];
function arity(name: string, args: Node[], min: 2, max: 3): [Node, Node, Node?];
function arity(name: string, args: Node[], min: 3, max: 3): [Node, Node, Node];
function arity(name: string, args: Node[], min: number, max: number): (Node | undefined)[] {
  if (args.length < min || args.length > max) throw new UnsupportedError(`${name}() with ${args.length} argument(s) is not supported`);
  return args;
}

/**
 * IIF(c1, a, IIF(c2, b, c)) becomes one flat CASE with a WHEN per nested IIF, and
 * IIF(ISNULL(x), y, x) becomes coalesce(x, y): shorter, and x is not written twice
 * (which matters when x is a variable that is itself inlined).
 */
function iif(args: Node[], render: Render): Sql {
  const coalesce = coalesceShape(args);
  if (coalesce) {
    const [value, fallback] = [render(coalesce[0]), render(coalesce[1])];
    return atom(`coalesce(${value.text}, ${fallback.text})`, value.isDate || fallback.isDate);
  }

  const branches: { condition: Sql; value: Sql }[] = [];
  let rest: Node = { kind: 'call', name: 'IIF', args };
  while (rest.kind === 'call' && rest.name === 'IIF' && !coalesceShape(rest.args)) {
    const [condition, whenTrue, whenFalse]: [Node, Node, Node] = arity('IIF', rest.args, 3, 3);
    branches.push({ condition: render(condition), value: render(whenTrue) });
    rest = whenFalse;
  }
  const otherwise = render(rest);
  const whens = branches.map(({ condition, value }) => `when ${condition.text} then ${value.text}`);
  const isDate = otherwise.isDate || branches.some(({ value }) => value.isDate);
  return atom(`case ${whens.join(' ')} else ${otherwise.text} end`, isDate);
}

/** IIF(ISNULL(x), y, x) has the shape of coalesce(x, y): returns [x, y] if it does. */
function coalesceShape(args: Node[]): [Node, Node] | undefined {
  const [condition, whenNull, otherwise] = args;
  if (args.length !== 3 || condition?.kind !== 'call' || condition.name !== 'ISNULL' || condition.args.length !== 1) return undefined;
  const value = condition.args[0]!;
  return sameTree(value, otherwise) ? [value, whenNull!] : undefined;
}

/** Structural equality of two expression trees (plain objects and arrays). */
function sameTree(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => sameTree((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  );
}

/** DECODE(value, search1, result1, ..., [default]); DECODE(TRUE, cond1, result1, ...) is the usual "switch" idiom. */
function decode(args: Node[], render: Render): Sql {
  if (args.length < 3) throw new UnsupportedError('DECODE needs at least 3 arguments');
  const [value, ...cases] = args as [Node, ...Node[]];
  const isSwitch = value.kind === 'keyword' && value.value === 'TRUE';
  const subject = isSwitch ? '' : wrap(render(value), comparison + 1);

  const whens = Array.from({ length: Math.floor(cases.length / 2) }, (_, pair) => {
    const search = render(cases[2 * pair]!);
    const condition = isSwitch ? search.text : `${subject} = ${wrap(search, comparison + 1)}`;
    return `when ${condition} then ${render(cases[2 * pair + 1]!).text}`;
  });
  const otherwise = cases.length % 2 === 1 ? ` else ${render(cases.at(-1)!).text}` : '';
  return atom(`case ${whens.join(' ')}${otherwise} end`);
}

function isNull(args: Node[], render: Render): Sql {
  const [value] = arity('ISNULL', args, 1, 1);
  return { text: `${wrap(render(value), SQL_PRECEDENCE.is + 1)} is null`, precedence: SQL_PRECEDENCE.is, isDate: false };
}

/** Informatica treats a start of 0 as 1; in DuckDB position 0 lies before the first character. */
function substr(args: Node[], render: Render): Sql {
  const [value, start, length] = arity('SUBSTR', args, 2, 3);
  const from = render(start);
  const first = from.text === '0' ? '1' : `case when ${wrap(from, comparison + 1)} = 0 then 1 else ${from.text} end`;
  return atom(`substr(${render(value).text}, ${first}${length ? `, ${render(length).text}` : ''})`);
}

/** SUM, AVG, MIN, MAX. */
function aggregate(name: string): FunctionTranslator {
  return (args, render) => {
    const [value, condition] = arity(name, args, 1, 2);
    const operand = render(value);
    return atom(`${name.toLowerCase()}(${filtered(operand, condition, render)})`, operand.isDate);
  };
}

/** COUNT(*), or COUNT(x) which skips NULLs. */
function count(args: Node[], render: Render): Sql {
  const [value, condition] = arity('COUNT', args, 1, 2);
  const counted = value.kind === 'star' ? atom(condition ? '1' : '*') : render(value);
  return atom(`count(${filtered(counted, condition, render)})`);
}

/** Aggregates take an optional filter: SUM(x, cond) only adds the rows where cond holds. */
function filtered(operand: Sql, condition: Node | undefined, render: Render): string {
  return condition ? `case when ${render(condition).text} then ${operand.text} end` : operand.text;
}

function trunc(args: Node[], render: Render): Sql {
  const [value, format] = arity('TRUNC', args, 1, 2);
  const operand = render(value);
  if (operand.isDate) return atom(`date_trunc('${datePart(format ? stringLiteral(format) : 'DD')}', ${operand.text})`, true);
  if (format) throw new UnsupportedError('TRUNC(number, precision) is not supported');
  return atom(`trunc(${operand.text})`);
}

function toChar(args: Node[], render: Render): Sql {
  const [value, format] = arity('TO_CHAR', args, 1, 2);
  const operand = render(value);
  if (operand.isDate) return atom(`strftime(${operand.text}, ${dateFormat(format)})`);
  if (format) throw new UnsupportedError('TO_CHAR(number, format) is not supported');
  return atom(`cast(${operand.text} as varchar)`);
}

function toDate(args: Node[], render: Render): Sql {
  const [value, format] = arity('TO_DATE', args, 1, 2);
  return atom(`strptime(${render(value).text}, ${dateFormat(format)})`, true);
}

/** Informatica: DATE_DIFF(date1, date2, unit) = date1 - date2, as elapsed time (a double). */
function dateDiff(args: Node[], render: Render): Sql {
  const [later, earlier, unit] = arity('DATE_DIFF', args, 3, 3);
  const name = stringLiteral(unit).trim().toUpperCase();
  const seconds = SECONDS_PER_UNIT.get(name);
  if (!seconds) throw new UnsupportedError(`DATE_DIFF in '${name}' is prorated by Informatica and is not supported`);
  // DuckDB's date_diff counts the boundaries crossed instead, so use epoch seconds.
  const text = `(epoch(${render(later).text}) - epoch(${render(earlier).text})) / ${seconds}`;
  return { text, precedence: SQL_PRECEDENCE.multiplicative, isDate: false };
}

function stringLiteral(node: Node): string {
  if (node.kind !== 'string') throw new UnsupportedError('date formats must be string literals');
  return node.value;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** The format Informatica uses when TO_DATE and TO_CHAR get none. */
const DEFAULT_DATE_FORMAT = 'MM/DD/YYYY HH24:MI:SS';

/** TRUNC(date, format) -> the unit to truncate to. */
const DATE_PARTS = new Map([
  ...['Y', 'YY', 'YYY', 'YYYY'].map((format) => [format, 'year'] as const),
  ...['MM', 'MON', 'MONTH'].map((format) => [format, 'month'] as const),
  ...['D', 'DD', 'DDD', 'DY', 'DAY'].map((format) => [format, 'day'] as const),
  ...['HH', 'HH12', 'HH24'].map((format) => [format, 'hour'] as const),
  ['MI', 'minute'],
  ['SS', 'second'],
]);

/** DATE_DIFF unit -> seconds. Months and years are prorated by Informatica, so they are left out. */
const SECONDS_PER_UNIT = new Map([
  ['SS', 1],
  ['MI', 60],
  ...['HH', 'HH12', 'HH24'].map((unit) => [unit, 3600] as const),
  ...['D', 'DD', 'DDD', 'DY', 'DAY'].map((unit) => [unit, 86400] as const),
]);

function datePart(format: string): string {
  const part = DATE_PARTS.get(format.trim().toUpperCase());
  if (!part) throw new UnsupportedError(`date part '${format}' is not supported`);
  return part;
}

const dateFormat = (format: Node | undefined): string => `'${strftimeFormat(format ? stringLiteral(format) : DEFAULT_DATE_FORMAT)}'`;

/** Informatica format token -> strftime/strptime code. */
const STRFTIME_CODES = new Map([
  ['YYYY', '%Y'], ['MONTH', '%B'], ['HH24', '%H'], ['HH12', '%I'], ['MON', '%b'], ['DDD', '%j'], ['DAY', '%A'],
  ['YY', '%y'], ['MM', '%m'], ['DD', '%d'], ['DY', '%a'], ['HH', '%I'], ['MI', '%M'], ['SS', '%S'],
  ['MS', '%g'], ['US', '%f'], ['AM', '%p'], ['PM', '%p'],
]);

// Longest tokens come first so that MONTH wins over MON and MM. Any other letter is a format
// we do not know, and a literal % has to be escaped.
const FORMAT_TOKEN = new RegExp(`${[...STRFTIME_CODES.keys()].join('|')}|[A-Za-z]|%`, 'gi');

/** Informatica date format ("DD-MM-YY") -> strftime/strptime format ("%d-%m-%y"). */
export function strftimeFormat(format: string): string {
  return format.replace(FORMAT_TOKEN, (token) => {
    if (token === '%') return '%%';
    const code = STRFTIME_CODES.get(token.toUpperCase());
    if (!code) throw new UnsupportedError(`date format '${format}' is not supported`);
    return code;
  });
}
