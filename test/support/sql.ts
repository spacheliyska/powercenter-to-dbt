/** Reading generated models in tests. */

/** The body of one CTE, without the WITH clause's indentation. */
export function cteBody(sql: string, name: string): string {
  const match = new RegExp(`^${name} as \\(\\n([\\s\\S]*?)\\n\\)`, 'm').exec(sql);
  if (!match) throw new Error(`no CTE ${name} in:\n${sql}`);
  return match[1]!.replace(/^ {4}/gm, '');
}

/** The CTE names of a model, in the order they are defined. */
export function cteNames(sql: string): string[] {
  return [...sql.matchAll(/^(\w+) as \($/gm)].map((match) => match[1]!);
}
