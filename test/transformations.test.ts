/**
 * Corner cases of each transformation type and of model assembly, on small synthetic
 * mappings, so that each rule is pinned down independently of the sample export.
 */
import { describe, expect, it } from 'vitest';
import { convertFolder } from '../src/convert.ts';
import { defaultConverters, type TransformationConverter } from '../src/converters.ts';
import { UnsupportedError } from '../src/errors.ts';
import { parameterSql } from '../src/parameters.ts';
import { tableKey } from '../src/powercenter.ts';
import {
  convertSpec,
  input,
  output,
  parseSpec,
  sourceQualifier,
  variable,
  wire,
  type LinkSpec,
  type MappingSpec,
  type PortSpec,
  type TransformationSpec,
} from './support/mapping-xml.ts';
import { cteBody, cteNames } from './support/sql.ts';

// ---- fixtures ------------------------------------------------------------------

const sq = sourceQualifier('SQ', 'S', ['A', 'B']);

/** S(A, B) -> SQ -> the given transformations -> T(X). */
function mapping(transformations: TransformationSpec[], links: LinkSpec[], overrides: Partial<MappingSpec> = {}): MappingSpec {
  return {
    sources: { S: ['A', 'B'] },
    targets: { T: ['X'] },
    transformations: [sq.transformation, ...transformations],
    links: [...sq.links, ...links],
    ...overrides,
  };
}

/** S(A, B) -> SQ -> EXP -> T(X); `connected` are the EXP ports fed by SQ. */
function expressionMapping(ports: PortSpec[], connected: string[] = ['A']): MappingSpec {
  return mapping([{ name: 'EXP', type: 'Expression', ports }], [...wire('SQ', 'EXP', connected), ['EXP', 'X', 'T', 'X']]);
}

/** A Source Qualifier with the given settings, straight into T(X). */
function qualifierMapping(attrs: Record<string, string>): MappingSpec {
  const qualifier = sourceQualifier('SQ', 'S', ['A', 'B'], attrs);
  return { sources: { S: ['A', 'B'] }, targets: { T: ['X'] }, transformations: [qualifier.transformation], links: [...qualifier.links, ['SQ', 'A', 'T', 'X']] };
}

function convertOk(...mappings: MappingSpec[]) {
  const result = convertSpec(...mappings);
  expect(result.errors).toEqual([]);
  return result.models[0]!;
}

function conversionError(...mappings: MappingSpec[]): string {
  const result = convertSpec(...mappings);
  expect(result.errors).toHaveLength(1);
  return result.errors[0]!;
}

// ---- transformations ------------------------------------------------------------

describe('Source Qualifier', () => {
  it('reads the source table and keeps only the connected ports', () => {
    const qualifier = sourceQualifier('SQ', 'S', ['A', 'B']);
    const { sql } = convertOk({
      sources: { S: ['A', 'B'] },
      targets: { T: ['X'] },
      transformations: [qualifier.transformation],
      links: [['S', 'A', 'SQ', 'A'], ['SQ', 'A', 'T', 'X']],
    });
    expect(cteBody(sql, 'sq')).toBe("-- Source Qualifier SQ\nselect\n    s.a\nfrom {{ source('raw', 's') }} as s");
  });

  it('selects distinct rows when Select Distinct is set', () => {
    expect(cteBody(convertOk(qualifierMapping({ 'Select Distinct': 'YES' })).sql, 'sq')).toContain('select distinct');
  });

  it('copies the source filter verbatim, with a warning', () => {
    const model = convertOk(qualifierMapping({ 'Source Filter': 'S.A > 1' }));
    expect(cteBody(model.sql, 'sq')).toContain('where S.A > 1');
    expect(model.warnings).toContain('SQ: source filter copied verbatim, check it is valid in the target warehouse');
  });

  it('warns that pre- and post-session SQL is dropped', () => {
    const model = convertOk(qualifierMapping({ 'Pre SQL': 'delete from x', 'Post SQL': 'analyze x' }));
    expect(model.warnings).toEqual([
      'SQ: "Pre SQL" is ignored; use a dbt hook if it is still needed',
      'SQ: "Post SQL" is ignored; use a dbt hook if it is still needed',
    ]);
  });

  it.each(['Sql Query', 'User Defined Join'])('refuses a "%s" override', (setting) => {
    expect(conversionError(qualifierMapping({ [setting]: 'select 1 from dual' }))).toBe(
      `m_test -> T: SQ has a "${setting}" override; port that SQL by hand`,
    );
  });

  it('refuses to join two sources in one qualifier', () => {
    const qualifier = sourceQualifier('SQ', 'S', ['A', 'B']);
    const error = conversionError({
      sources: { S: ['A'], S2: ['B'] },
      targets: { T: ['X'] },
      transformations: [qualifier.transformation],
      links: [['S', 'A', 'SQ', 'A'], ['S2', 'B', 'SQ', 'B'], ['SQ', 'A', 'T', 'X']],
    });
    expect(error).toBe('m_test -> T: source qualifier SQ reads from 2 upstream pipelines (S, S2)');
  });
});

describe('Expression', () => {
  const exp = (sql: string) => cteBody(sql, 'exp');

  it('reads an unconnected input port as NULL', () => {
    expect(exp(convertOk(expressionMapping([input('A'), input('B'), output('X', 'B')])).sql)).toContain('null as x');
  });

  it('resolves port names case-insensitively', () => {
    expect(exp(convertOk(expressionMapping([input('A'), output('X', "a || 'x'")])).sql)).toContain("concat(sq.a, 'x') as x");
  });

  it('inlines a chain of local variables', () => {
    const ports = [input('A'), variable('v1', "A || '-'"), variable('v2', "v1 || '+'"), output('X', 'v2')];
    expect(exp(convertOk(expressionMapping(ports)).sql)).toContain("concat(concat(sq.a, '-'), '+') as x");
  });

  it('turns an unknown port into NULL with a warning', () => {
    const model = convertOk(expressionMapping([input('A'), output('X', 'ZZZ + 1')]));
    expect(exp(model.sql)).toContain('null /* UNSUPPORTED: see warning above */ as x');
    expect(model.warnings).toEqual(['EXP.X set to NULL: unknown port or variable ZZZ. Informatica expression: ZZZ + 1']);
  });

  it('turns an empty output expression into NULL with a warning', () => {
    const model = convertOk(expressionMapping([input('A'), output('X', '')]));
    expect(model.warnings[0]).toMatch(/^EXP\.X set to NULL: unexpected end of expression/);
  });

  it('keeps converting the other ports when one cannot be translated', () => {
    const model = convertOk(
      mapping(
        [{ name: 'EXP', type: 'Expression', ports: [input('A'), output('X', 'MD5(A)'), output('Y', 'A')] }],
        [...wire('SQ', 'EXP', ['A']), ...wire('EXP', 'T', ['X', 'Y'])],
        { targets: { T: ['X', 'Y'] } },
      ),
    );
    expect(exp(model.sql)).toContain('null /* UNSUPPORTED: see warning above */ as x');
    expect(exp(model.sql)).toContain('sq.a as y');
    expect(model.warnings).toEqual(['EXP.X set to NULL: function MD5() is not supported. Informatica expression: MD5(A)']);
  });

  it('refuses a variable that reads one defined below it (the previous row value)', () => {
    const ports = [input('A'), variable('v1', "v2 || 'x'"), variable('v2', 'A'), output('X', 'v1'), output('Y', 'v2')];
    const model = convertOk(
      mapping([{ name: 'EXP', type: 'Expression', ports }], [...wire('SQ', 'EXP', ['A']), ...wire('EXP', 'T', ['X', 'Y'])], {
        targets: { T: ['X', 'Y'] },
      }),
    );
    expect(model.warnings).toEqual([
      "EXP.X set to NULL: v1 reads the previous row's value of v2 (stateful variable port). Informatica expression: v1",
    ]);
    expect(exp(model.sql)).toContain('sq.a as y');
  });

  it('refuses a running counter and everything computed from it', () => {
    const ports = [input('A'), variable('v_count', 'v_count + 1'), variable('v_double', 'v_count * 2'), output('X', 'v_double')];
    const model = convertOk(expressionMapping(ports));
    expect(model.warnings).toEqual([
      "EXP.X set to NULL: v_count reads the previous row's value of v_count (stateful variable port). Informatica expression: v_double",
    ]);
  });

  it('stops inlining a chain of variables whose SQL doubles at every step', () => {
    const doubling = Array.from({ length: 40 }, (_, i) => variable(`v${i + 1}`, `v${i} + v${i}`));
    const model = convertOk(expressionMapping([input('A'), variable('v0', 'A + A'), ...doubling, output('X', 'v40')]));
    expect(model.warnings[0]).toMatch(/^EXP\.X set to NULL: v\d+ is too large to inline \(\d+ characters of SQL\)/);
    expect(model.sql.length).toBeLessThan(10_000);
  });
});

describe('Filter', () => {
  const filterMapping = (attrs: Record<string, string>) =>
    mapping([{ name: 'FIL', type: 'Filter', ports: [{ name: 'A' }, { name: 'B' }], attrs }], [...wire('SQ', 'FIL', ['A', 'B']), ['FIL', 'A', 'T', 'X']]);

  it('turns the condition into WHERE', () => {
    const { sql } = convertOk(filterMapping({ 'Filter Condition': 'A > 1 AND NOT ISNULL(B)' }));
    expect(cteBody(sql, 'fil')).toContain('where sq.a > 1 and not sq.b is null');
  });

  it('keeps every row when there is no condition', () => {
    expect(cteBody(convertOk(filterMapping({})).sql, 'fil')).toContain('where true');
  });
});

describe('Sorter', () => {
  it('drops the ordering but keeps Distinct', () => {
    const { sql } = convertOk(
      mapping(
        [{ name: 'SRT', type: 'Sorter', ports: [{ name: 'A' }, { name: 'B' }], attrs: { Distinct: 'YES' } }],
        [...wire('SQ', 'SRT', ['A', 'B']), ['SRT', 'A', 'T', 'X']],
      ),
    );
    expect(cteBody(sql, 'srt')).toBe(
      '-- Sorter SRT\n-- sort order dropped: a table or view has no row order\nselect distinct\n    sq.a,\n    sq.b\nfrom sq',
    );
  });
});

describe('Joiner', () => {
  /** S1(A, B) -> SQ1 (detail) and S2(C, D) -> SQ2 (master) -> JNR on A = C -> T(X). */
  function joinerMapping(attrs: Record<string, string>, masterLinks = wire('SQ2', 'JNR', ['C', 'D'])): MappingSpec {
    const sq1 = sourceQualifier('SQ1', 'S1', ['A', 'B']);
    const sq2 = sourceQualifier('SQ2', 'S2', ['C', 'D']);
    const joiner: TransformationSpec = {
      name: 'JNR',
      type: 'Joiner',
      ports: [{ name: 'A' }, { name: 'B' }, { name: 'C', type: 'INPUT/OUTPUT/MASTER' }, { name: 'D', type: 'INPUT/OUTPUT/MASTER' }],
      attrs: { 'Join Condition': 'A = C', ...attrs },
    };
    return {
      sources: { S1: ['A', 'B'], S2: ['C', 'D'] },
      targets: { T: ['X'] },
      transformations: [sq1.transformation, sq2.transformation, joiner],
      links: [...sq1.links, ...sq2.links, ...wire('SQ1', 'JNR', ['A', 'B']), ...masterLinks, ['JNR', 'D', 'T', 'X']],
    };
  }

  it.each([
    ['Normal Join', 'from sq1\n    inner join sq2'],
    ['Master Outer Join', 'from sq1\n    left join sq2'], // keeps every detail row
    ['Detail Outer Join', 'from sq2\n    left join sq1'], // keeps every master row
    ['Full Outer Join', 'from sq1\n    full outer join sq2'],
  ])('%s', (joinType, from) => {
    const body = cteBody(convertOk(joinerMapping({ 'Join Type': joinType })).sql, 'jnr');
    expect(body).toContain(`${from}\n        on sq1.a = sq2.c`);
    expect(body).toContain(`-- ${joinType} (master sq2, detail sq1)`);
  });

  it('is a normal join when no join type is set', () => {
    expect(cteBody(convertOk(joinerMapping({})).sql, 'jnr')).toContain('inner join sq2');
  });

  it('refuses an unknown join type', () => {
    expect(conversionError(joinerMapping({ 'Join Type': 'Cross Join' }))).toBe('m_test -> T: join type "Cross Join" in JNR is not supported');
  });

  it('refuses to join a pipeline to itself', () => {
    const error = conversionError(joinerMapping({}, wire('SQ1', 'JNR', [['A', 'C'], ['B', 'D']])));
    expect(error).toBe('m_test -> T: joiner JNR joins sq1 to itself');
  });

  it('needs a connected master side', () => {
    expect(conversionError(joinerMapping({}, []))).toBe('m_test -> T: master side of joiner JNR reads from 0 upstream pipelines (none)');
  });
});

describe('Aggregator', () => {
  const aggregatorMapping = (ports: PortSpec[], feeds = 'N') =>
    mapping([{ name: 'AGG', type: 'Aggregator', ports }], [...wire('SQ', 'AGG', ['A', 'B']), ['AGG', feeds, 'T', 'X']]);

  it('groups by the group-by ports, including conditional aggregates', () => {
    const ports = [{ name: 'A', groupBy: true }, input('B'), output('N', 'COUNT(*)'), output('S', 'SUM(B, B > 0)')];
    expect(cteBody(convertOk(aggregatorMapping(ports)).sql, 'agg')).toBe(
      '-- Aggregator AGG\nselect\n    sq.a,\n    count(*) as n,\n    sum(case when sq.b > 0 then sq.b end) as s\nfrom sq\ngroup by sq.a',
    );
  });

  it('aggregates the whole input when there is no group-by port', () => {
    expect(cteBody(convertOk(aggregatorMapping([input('A'), output('N', 'COUNT(*)')])).sql, 'agg')).not.toContain('group by');
  });

  it('warns about a port that is neither grouped nor aggregated', () => {
    const model = convertOk(aggregatorMapping([{ name: 'A', groupBy: true }, { name: 'B' }], 'B'));
    expect(cteBody(model.sql, 'agg')).toContain('any_value(sq.b) as b');
    expect(model.warnings).toEqual([
      "AGG.B: not aggregated; Informatica returns the last row's value, any_value() returns an arbitrary one",
    ]);
  });
});

describe('Router', () => {
  /** RTR splits SQ.A into BIG (A > 10), SMALL (A < 5) and the default group REST; each feeds its own target. */
  function routerMapping(groups = [{ name: 'BIG', expr: 'A > 10' }, { name: 'SMALL', expr: 'A < 5' }]): MappingSpec {
    const names = [...groups.map((g) => g.name), 'REST'];
    const router: TransformationSpec = {
      name: 'RTR',
      type: 'Router',
      groups: [{ name: 'INPUT', type: 'INPUT' }, ...groups.map((g) => ({ name: g.name, type: 'OUTPUT', expr: g.expr })), { name: 'REST', type: 'OUTPUT/DEFAULT' }],
      ports: [{ name: 'A', type: 'INPUT', group: 'INPUT' }, ...names.map((name) => ({ name: `A_${name}`, type: 'OUTPUT', group: name, ref: 'A' }))],
    };
    return mapping([router], [...wire('SQ', 'RTR', ['A']), ...names.map((name): LinkSpec => ['RTR', `A_${name}`, `T_${name}`, 'X'])], {
      targets: Object.fromEntries(names.map((name) => [`T_${name}`, ['X']])),
    });
  }

  it('gives each connected group its own CTE, with only that group condition', () => {
    const result = convertSpec(routerMapping());
    expect(result.errors).toEqual([]);
    const big = result.models.find((model) => model.name === 't_big')!;
    expect(cteNames(big.sql)).toEqual(['sq', 'rtr__big']);
    expect(cteBody(big.sql, 'rtr__big')).toContain("-- group BIG\nselect\n    sq.a as a_big\nfrom sq\nwhere sq.a > 10");
  });

  it('sends the rows no group matched to the default group (a NULL condition counts as false)', () => {
    const rest = convertSpec(routerMapping()).models.find((model) => model.name === 't_rest')!;
    expect(cteBody(rest.sql, 'rtr__rest')).toContain('where not (coalesce(sq.a > 10, false) or coalesce(sq.a < 5, false))');
  });

  it('sends every row to the default group when it is the only one', () => {
    const rest = convertSpec(routerMapping([])).models.find((model) => model.name === 't_rest')!;
    expect(cteBody(rest.sql, 'rtr__rest')).toContain('where true');
  });
});

describe('Union', () => {
  /** SQ1 (A, B) and SQ2 (C, D) feed the input groups G1 and G2 of UN, whose outputs are X and Y. */
  function unionMapping(overrides: Partial<TransformationSpec> = {}, links?: LinkSpec[]): MappingSpec {
    const sq1 = sourceQualifier('SQ1', 'S1', ['A', 'B']);
    const sq2 = sourceQualifier('SQ2', 'S2', ['C', 'D']);
    const union: TransformationSpec = {
      name: 'UN',
      type: 'Custom Transformation',
      attrs: { 'Module Identifier': 'pmuniontrans' },
      groups: [{ name: 'OUT', type: 'OUTPUT' }, { name: 'G1', type: 'INPUT' }, { name: 'G2', type: 'INPUT' }],
      ports: [
        ...['X', 'Y'].map((name) => ({ name, type: 'OUTPUT', group: 'OUT' })),
        ...['X1', 'Y1'].map((name) => ({ name, type: 'INPUT', group: 'G1' })),
        ...['X2', 'Y2'].map((name) => ({ name, type: 'INPUT', group: 'G2' })),
      ],
      ...overrides,
    };
    return {
      sources: { S1: ['A', 'B'], S2: ['C', 'D'] },
      targets: { T: ['X', 'Y'] },
      transformations: [sq1.transformation, sq2.transformation, union],
      links: [
        ...sq1.links,
        ...sq2.links,
        ...(links ?? [...wire('SQ1', 'UN', [['A', 'X1'], ['B', 'Y1']]), ...wire('SQ2', 'UN', [['C', 'X2'], ['D', 'Y2']])]),
        ...wire('UN', 'T', ['X', 'Y']),
      ],
    };
  }

  it('is a UNION ALL of the input groups, pairing ports by position when there are no dependencies', () => {
    expect(cteBody(convertOk(unionMapping()).sql, 'un')).toBe(
      '-- Custom Transformation UN\n' +
        '-- input group G1\nselect\n    sq1.a as x,\n    sq1.b as y\nfrom sq1\n\nunion all\n\n' +
        '-- input group G2\nselect\n    sq2.c as x,\n    sq2.d as y\nfrom sq2',
    );
  });

  it('follows the field dependencies when the export has them', () => {
    const body = cteBody(convertOk(unionMapping({ deps: [['Y1', 'X'], ['X1', 'Y']] })).sql, 'un');
    expect(body).toContain('sq1.b as x,\n    sq1.a as y');
  });

  it('skips an input group that is not connected', () => {
    const body = cteBody(convertOk(unionMapping({}, wire('SQ1', 'UN', [['A', 'X1'], ['B', 'Y1']]))).sql, 'un');
    expect(body).not.toContain('union all');
  });

  it('refuses a union without any connected input group', () => {
    expect(conversionError(unionMapping({}, []))).toBe('m_test -> T: union UN has no connected input groups');
  });

  it('refuses any other custom transformation', () => {
    expect(conversionError(unionMapping({ attrs: { 'Module Identifier': 'pmjava' } }))).toBe(
      'm_test -> T: Custom Transformation UN (module "pmjava") is not supported',
    );
  });
});

// ---- model assembly ---------------------------------------------------------------

describe('model assembly', () => {
  const passThrough = mapping([], [['SQ', 'A', 'T', 'X']], { targets: { T: ['X', 'Y'] } });

  it('loads an unconnected target column as NULL, with a warning', () => {
    const model = convertOk(passThrough);
    expect(model.sql).toContain('select\n    sq.a as x,\n    null as y\nfrom sq');
    expect(model.warnings).toEqual(['target column Y is not connected; it is loaded as NULL']);
  });

  it('refuses a target fed by two pipelines', () => {
    const sq2 = sourceQualifier('SQ2', 'S2', ['C']);
    const spec = mapping([sq2.transformation], [...sq2.links, ['SQ', 'A', 'T', 'X'], ['SQ2', 'C', 'T', 'Y']], {
      sources: { S: ['A', 'B'], S2: ['C'] },
      targets: { T: ['X', 'Y'] },
    });
    expect(conversionError(spec)).toBe('m_test -> T: target T reads from 2 upstream pipelines (sq, sq2)');
  });

  it('refuses a mapping that loops back on itself', () => {
    const loop: TransformationSpec[] = ['E1', 'E2'].map((name) => ({ name, type: 'Expression', ports: [input('A'), output('X', 'A')] }));
    const spec = mapping(loop, [['E2', 'X', 'E1', 'A'], ['E1', 'X', 'E2', 'A'], ['E1', 'X', 'T', 'X']]);
    expect(conversionError(spec)).toBe('m_test -> T: the mapping loops back to E1');
  });

  it('reports an unsupported transformation type for that target only', () => {
    const result = convertSpec(
      mapping([{ name: 'LKP', type: 'Lookup Procedure', ports: [input('A'), output('X', 'A')] }], [['SQ', 'A', 'LKP', 'A'], ['LKP', 'X', 'T', 'X']]),
      { ...passThrough, name: 'm_other', targets: { T2: ['X'] }, links: [...sq.links, ['SQ', 'A', 'T2', 'X']] },
    );
    expect(result.errors).toEqual(['m_test -> T: Lookup Procedure transformation LKP is not supported']);
    expect(result.models.map((model) => model.name)).toEqual(['t2']);
  });

  it('reports a transformation whose definition is missing (a mapplet)', () => {
    const folder = parseSpec(expressionMapping([input('A'), output('X', 'A')]));
    folder.mappings[0]!.transformations.delete('EXP');
    expect(convertFolder(folder).errors).toEqual(['m_test -> T: transformation EXP not found (mapplets are not supported)']);
  });

  it('refuses a second model with the same name', () => {
    const result = convertSpec({ ...passThrough, name: 'm_one' }, { ...passThrough, name: 'm_two' });
    expect(result.errors).toEqual(['m_two -> T: model "t" already exists (loaded by mapping m_one)']);
    expect(result.models).toHaveLength(1);
  });

  it('reads a table that another mapping loads with ref(), and any other table with source()', () => {
    const staging = mapping([], [['SQ', 'A', 'STG', 'X']], { name: 'm_staging', targets: { STG: ['X'] } });
    const stagingQualifier = sourceQualifier('SQ_STG', 'STG', ['X']);
    const mart: MappingSpec = {
      name: 'm_mart',
      sources: { STG: ['X'] },
      targets: { MART: ['X'] },
      transformations: [stagingQualifier.transformation],
      links: [...stagingQualifier.links, ['SQ_STG', 'X', 'MART', 'X']],
    };

    const result = convertSpec(staging, mart);
    expect(result.models.find((model) => model.name === 'mart')!.sql).toContain("{{ ref('stg') }} as stg");
    expect(result.sources).toEqual([{ name: 'raw', tables: ['s'] }]);

    // Once nothing loads STG, it is just another source.
    const folder = parseSpec(staging, mart);
    folder.mappings[0]!.instances.delete('STG');
    expect(convertFolder(folder).models[0]!.sql).toContain("{{ source('raw', 'stg') }} as stg");
  });

  it('tells apart two source tables of the same name in different databases', () => {
    const folder = parseSpec(mapping([], [['SQ', 'A', 'T', 'X']]));
    const original = [...folder.sources.values()][0]!;
    folder.sources.set(tableKey('CRM_DB', 'S'), { ...original, owner: 'CRM', database: 'CRM_DB' });
    folder.mappings[0]!.instances.get('S')!.database = 'CRM_DB';
    expect(convertFolder(folder).models[0]!.sql).toContain("{{ source('crm', 's') }}");
  });

  it('quotes reserved words used as column names', () => {
    const qualifier = sourceQualifier('SQ', 'S', ['ORDER', 'GROUP']);
    const { sql } = convertOk({
      sources: { S: ['ORDER', 'GROUP'] },
      targets: { T: ['ORDER'] },
      transformations: [qualifier.transformation],
      links: [...qualifier.links, ['SQ', 'ORDER', 'T', 'ORDER']],
    });
    expect(sql).toContain('s."order",\n        s."group"');
    expect(sql).toContain('select\n    sq."order"\nfrom sq');
  });

  it('turns any PowerCenter name into a valid identifier', () => {
    expect(convertOk(mapping([], [['SQ', 'A', 'ORDER#1', 'X']], { targets: { 'ORDER#1': ['X'] } })).name).toBe('order_1');
  });

  it('warns about a link that looks like swapped columns, but not about a plain rename', () => {
    const exp: TransformationSpec = { name: 'EXP', type: 'Expression', ports: [input('A'), input('B'), output('P', 'A'), output('Q', 'B')] };
    const swapped = convertOk(mapping([exp], [...wire('SQ', 'EXP', ['A', 'B']), ['EXP', 'Q', 'T', 'P']], { targets: { T: ['P'] } }));
    expect(swapped.warnings).toEqual(['suspicious wiring: EXP.Q feeds T.P, but EXP also has a port named P']);

    const renamed = convertOk(mapping([exp], [...wire('SQ', 'EXP', ['A', 'B']), ['EXP', 'Q', 'T', 'X']]));
    expect(renamed.warnings).toEqual([]);
  });

  it('accepts a converter for a new transformation type without other changes', () => {
    class LookupStub implements TransformationConverter {
      readonly type = 'Lookup Procedure';
      convert() {
        return { columns: ['42 as x'], from: 'sq' };
      }
    }
    const folder = parseSpec(mapping([{ name: 'LKP', type: 'Lookup Procedure', ports: [input('A'), output('X', 'A')] }], [['SQ', 'A', 'LKP', 'A'], ['LKP', 'X', 'T', 'X']]));
    expect(convertFolder(folder).errors).toHaveLength(1);
    const { models, errors } = convertFolder(folder, [...defaultConverters, new LookupStub()]);
    expect(errors).toEqual([]);
    expect(cteBody(models[0]!.sql, 'lkp')).toBe('-- Lookup Procedure LKP\nselect\n    42 as x\nfrom sq');
  });
});

// ---- mapping parameters ----------------------------------------------------------

describe('mapping parameters', () => {
  const parameter = (datatype: string, defaultValue: string) => parameterSql({ name: '$$P_ONE', datatype, defaultValue });

  it.each([
    ['date/time', '12/31/2025 00:00:00', `cast('{{ var("p_one", "2025-12-31 00:00:00") }}' as timestamp)`],
    ['date/time', '01/02/2024', `cast('{{ var("p_one", "2024-01-02 00:00:00") }}' as timestamp)`],
    ['string', "O'Brien", `'{{ var("p_one", "O'Brien") | replace("'", "''") }}'`],
    ['integer', '5', '{{ var("p_one", 5) }}'],
    ['decimal', '-1.5', '{{ var("p_one", -1.5) }}'],
  ])('%s parameter with default %s', (datatype, defaultValue, sql) => {
    expect(parameter(datatype, defaultValue).text).toBe(sql);
  });

  it.each([
    ['date/time', 'yesterday'],
    ['integer', ''],
    ['integer', '5; drop table x'],
  ])('refuses a %s parameter with default "%s"', (datatype, defaultValue) => {
    expect(() => parameter(datatype, defaultValue)).toThrow(UnsupportedError);
  });

  it('resolves $$PARAM in expressions, case-insensitively', () => {
    const spec = { ...expressionMapping([input('A'), output('X', '$$p_one + A')]), variables: [{ name: '$$P_ONE', datatype: 'integer', defaultValue: '7' }] };
    expect(cteBody(convertOk(spec).sql, 'exp')).toContain('{{ var("p_one", 7) }} + sq.a as x');
  });

  it('turns an unknown parameter into NULL with a warning', () => {
    expect(convertOk(expressionMapping([input('A'), output('X', '$$NOPE')])).warnings[0]).toMatch(/unknown port or variable \$\$NOPE/);
  });
});

// ---- determinism -------------------------------------------------------------------

it('gives the same output every time', () => {
  const spec = mapping([{ name: 'EXP', type: 'Expression', ports: [input('A'), output('X', 'IIF(A > 1, A, 0)')] }], [...wire('SQ', 'EXP', ['A']), ['EXP', 'X', 'T', 'X']]);
  expect(convertSpec(spec)).toEqual(convertSpec(spec));
});
