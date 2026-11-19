/**
 * Synthetic mappings of any size, for the scale tests, the performance tests and the benchmarks.
 * Each one stresses a different dimension: chain length, width, number of mappings.
 */
import { input, output, sourceQualifier, wire, type LinkSpec, type MappingSpec, type TransformationSpec } from './mapping-xml.ts';

const range = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

/** S(A) -> SQ -> EXP_1 -> ... -> EXP_n -> T(A). Every Expression adds 1, so T.A = S.A + n. */
export function chainMapping(length: number): MappingSpec {
  const sq = sourceQualifier('SQ', 'S', ['A']);
  const expressions = range(length).map((i): TransformationSpec => ({
    name: `EXP_${i}`,
    type: 'Expression',
    ports: [input('A_IN'), output('A', 'A_IN + 1', 'decimal')],
  }));
  const links: LinkSpec[] = [
    ...sq.links,
    ['SQ', 'A', 'EXP_1', 'A_IN'],
    ...range(length - 1).map((i): LinkSpec => [`EXP_${i}`, 'A', `EXP_${i + 1}`, 'A_IN']),
    [`EXP_${length}`, 'A', 'T', 'A'],
  ];
  return { sources: { S: ['A:number'] }, targets: { T: ['A'] }, transformations: [sq.transformation, ...expressions], links };
}

/**
 * S(C_1..C_n) -> SQ -> EXP (R_i = C_i * 2) -> AGG (group by R_1, M_i = MAX(R_i)) -> T(R_1, M_2..M_n).
 * Every transformation is n ports wide, so any per-port scan would make this quadratic.
 */
export function wideMapping(width: number): MappingSpec {
  const columns = range(width).map((i) => `C_${i}`);
  const sq = sourceQualifier('SQ', 'S', columns);
  const expression: TransformationSpec = {
    name: 'EXP',
    type: 'Expression',
    ports: range(width).flatMap((i) => [input(`C_${i}`), output(`R_${i}`, `C_${i} * 2`, 'decimal')]),
  };
  const aggregator: TransformationSpec = {
    name: 'AGG',
    type: 'Aggregator',
    ports: [{ name: 'R_1', groupBy: true }, ...range(width).slice(1).flatMap((i) => [input(`R_${i}`), output(`M_${i}`, `MAX(R_${i})`, 'decimal')])],
  };
  const targetColumns = ['R_1', ...range(width).slice(1).map((i) => `M_${i}`)];
  return {
    sources: { S: columns.map((column) => `${column}:number`) },
    targets: { T: targetColumns },
    transformations: [sq.transformation, expression, aggregator],
    links: [
      ...sq.links,
      ...wire('SQ', 'EXP', columns),
      ...wire('EXP', 'AGG', range(width).map((i) => `R_${i}`)),
      ...wire('AGG', 'T', targetColumns),
    ],
  };
}

/**
 * A folder of 2 x count mappings: count staging mappings (RAW_i -> STG_i) and count mart
 * mappings that read the staging tables (STG_i -> MART_i), so the marts use ref().
 */
export function manyMappings(count: number): MappingSpec[] {
  return range(count).flatMap((i): MappingSpec[] => {
    const staging = sourceQualifier(`SQ_RAW_${i}`, `RAW_${i}`, ['ID', 'NAME']);
    const mart = sourceQualifier(`SQ_STG_${i}`, `STG_${i}`, ['ID', 'NAME']);
    return [
      {
        name: `m_staging_${i}`,
        sources: { [`RAW_${i}`]: ['ID', 'NAME'] },
        targets: { [`STG_${i}`]: ['ID', 'NAME'] },
        transformations: [
          staging.transformation,
          { name: `EXP_${i}`, type: 'Expression', ports: [{ name: 'ID' }, input('NAME_IN'), output('NAME', 'UPPER(LTRIM(RTRIM(NAME_IN)))')] },
        ],
        links: [
          ...staging.links,
          ...wire(`SQ_RAW_${i}`, `EXP_${i}`, ['ID', ['NAME', 'NAME_IN']]),
          ...wire(`EXP_${i}`, `STG_${i}`, ['ID', 'NAME']),
        ],
      },
      {
        name: `m_mart_${i}`,
        sources: { [`STG_${i}`]: ['ID', 'NAME'] },
        targets: { [`MART_${i}`]: ['NAME', 'N'] },
        transformations: [
          mart.transformation,
          { name: `AGG_${i}`, type: 'Aggregator', ports: [{ name: 'NAME', groupBy: true }, input('ID'), output('N', 'COUNT(ID)', 'integer')] },
        ],
        links: [...mart.links, ...wire(`SQ_STG_${i}`, `AGG_${i}`, ['ID', 'NAME']), ...wire(`AGG_${i}`, `MART_${i}`, ['NAME', 'N'])],
      },
    ];
  });
}

/** An expression with `terms` operands joined by `operator`, e.g. C_1 || C_2 || ... */
export function longExpression(terms: number, operator: string): string {
  return range(terms).map((i) => `C_${i}`).join(` ${operator} `);
}
