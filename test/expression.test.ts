import { describe, expect, it } from 'vitest';
import { UnsupportedError } from '../src/errors.ts';
import { atom, strftimeFormat, translate, type Resolver } from '../src/expression.ts';

// Ports resolve to columns of a CTE called "t"; ports ending in _DATE are dates.
const resolve: Resolver = (name) => atom(`t.${name.toLowerCase()}`, name.toUpperCase().endsWith('_DATE'));
const sql = (expression: string) => translate(expression, resolve).text;

describe('operators and precedence', () => {
  it('qualifies port references and keeps arithmetic', () => {
    expect(sql('PRICE/100')).toBe('t.price / 100');
  });

  it('adds parentheses only where SQL needs them', () => {
    expect(sql('(PRICE - COST) / PRICE')).toBe('(t.price - t.cost) / t.price');
    expect(sql('PRICE + (PRICE * RATE)')).toBe('t.price + t.price * t.rate');
    expect(sql('A - (B - C)')).toBe('t.a - (t.b - t.c)');
  });

  it('maps Informatica not-equal operators to <>', () => {
    expect(sql('A != 1 OR B ^= 2 OR C <> 3')).toBe('t.a <> 1 or t.b <> 2 or t.c <> 3');
  });

  it('keeps NOT binding tightly, as in Informatica', () => {
    // Informatica reads NOT A = B as (NOT A) = B; SQL would read it as NOT (A = B).
    expect(sql('NOT A = B')).toBe('(not t.a) = t.b');
    expect(sql('NOT ISNULL(A)')).toBe('not t.a is null');
  });

  it('ignores comments and Windows line breaks', () => {
    expect(sql("IIF(A > 1,\r\n  'x', -- big\r\n  'y')")).toBe("case when t.a > 1 then 'x' else 'y' end");
  });

  it('does not turn a double negative into a SQL comment', () => {
    expect(sql('-(-A)')).toBe('-(-t.a)');
  });
});

describe('functions', () => {
  it('turns IIF into CASE and flattens nested IIFs', () => {
    expect(sql("IIF(TAX_RATE >= 0.15, 'EMEA', IIF(TAX_RATE >= 0.09, 'APAC', 'AMER'))")).toBe(
      "case when t.tax_rate >= 0.15 then 'EMEA' when t.tax_rate >= 0.09 then 'APAC' else 'AMER' end",
    );
  });

  it('turns ISNULL into IS NULL', () => {
    expect(sql('IIF(ISNULL(X), 0, Y)')).toBe('case when t.x is null then 0 else t.y end');
  });

  it('writes IIF(ISNULL(x), y, x) as coalesce(x, y), but only when both x are the same expression', () => {
    expect(sql('IIF(ISNULL(X), 0, X)')).toBe('coalesce(t.x, 0)');
    expect(sql("IIF(ISNULL(A + B), 'none', A + B)")).toBe("coalesce(t.a + t.b, 'none')");
    expect(sql('IIF(ISNULL(A + B), 0, A + C)')).toBe('case when t.a + t.b is null then 0 else t.a + t.c end');
    // Inside a flattened IIF chain too.
    expect(sql('IIF(A > 1, 1, IIF(ISNULL(X), 0, X))')).toBe('case when t.a > 1 then 1 else coalesce(t.x, 0) end');
  });

  it('supports both DECODE forms', () => {
    expect(sql("DECODE(TYPE, 'A', 1, 'B', 2, 0)")).toBe("case when t.type = 'A' then 1 when t.type = 'B' then 2 else 0 end");
    expect(sql("DECODE(TRUE, X > 1, 'big', 'small')")).toBe("case when t.x > 1 then 'big' else 'small' end");
  });

  it('passes simple string functions through', () => {
    expect(sql("UPPER(LTRIM(RTRIM(TYPE))) = 'JAFFLE'")).toBe("upper(ltrim(rtrim(t.type))) = 'JAFFLE'");
  });

  it('translates aggregates, including the conditional form', () => {
    expect(sql('COUNT(*)')).toBe('count(*)');
    expect(sql('SUM(AMOUNT)')).toBe('sum(t.amount)');
    expect(sql("SUM(AMOUNT, STATUS = 'paid')")).toBe("sum(case when t.status = 'paid' then t.amount end)");
  });
});

describe('dates', () => {
  it('uses the argument type to tell date TRUNC from number TRUNC', () => {
    expect(sql('TRUNC(OPENED_DATE)')).toBe("date_trunc('day', t.opened_date)");
    expect(sql("TRUNC(OPENED_DATE, 'MM')")).toBe("date_trunc('month', t.opened_date)");
    expect(sql('TRUNC(AMOUNT)')).toBe('trunc(t.amount)');
  });

  it('converts TO_CHAR/TO_DATE formats to strftime/strptime', () => {
    expect(sql("TO_DATE(TO_CHAR(ORDERED_DATE, 'DD-MM-YY'), 'DD-MM-YY')")).toBe(
      "strptime(strftime(t.ordered_date, '%d-%m-%y'), '%d-%m-%y')",
    );
    expect(strftimeFormat('YYYY-MM-DD HH24:MI:SS')).toBe('%Y-%m-%d %H:%M:%S');
    expect(strftimeFormat('MONTH MON MM')).toBe('%B %b %m');
  });

  it('keeps DATE_DIFF(later, earlier) the right way round, as elapsed time', () => {
    expect(sql("DATE_DIFF(RUN_DATE, LAST_DATE, 'DD')")).toBe('(epoch(t.run_date) - epoch(t.last_date)) / 86400');
    expect(sql("DATE_DIFF(RUN_DATE, LAST_DATE, 'HH24')")).toBe('(epoch(t.run_date) - epoch(t.last_date)) / 3600');
  });

  it('truncates dates to the unit the format names', () => {
    expect(sql("TRUNC(OPENED_DATE, 'YYYY')")).toBe("date_trunc('year', t.opened_date)");
  });

  it('formats numbers with TO_CHAR as plain text', () => {
    expect(sql('TO_CHAR(AMOUNT)')).toBe('cast(t.amount as varchar)');
  });

  it('treats SYSDATE as the current timestamp', () => {
    expect(sql("TRUNC(SYSDATE, 'MM')")).toBe("date_trunc('month', current_timestamp)");
  });
});

describe('edge cases', () => {
  it('keeps escaped quotes inside string literals', () => {
    expect(sql("IIF(A = 'it''s', 'yes', 'no')")).toBe("case when t.a = 'it''s' then 'yes' else 'no' end");
  });

  it('is not confused by punctuation inside a string literal', () => {
    expect(sql("CONCAT(A, ')')")).toBe("concat(t.a, ')')");
  });

  it('writes a whole || chain as one concat(), however it is parenthesized', () => {
    expect(sql('A || B || C')).toBe('concat(t.a, t.b, t.c)');
    expect(sql("A || ('-' || B)")).toBe("concat(t.a, '-', t.b)");
  });

  it('treats SUBSTR start 0 as 1, like Informatica', () => {
    expect(sql('SUBSTR(NAME, 0, 2)')).toBe('substr(t.name, 1, 2)');
    expect(sql('SUBSTR(NAME, POS)')).toBe('substr(t.name, case when t.pos = 0 then 1 else t.pos end)');
  });

  it('counts the rows that match a condition', () => {
    expect(sql('COUNT(*, X > 1)')).toBe('count(case when t.x > 1 then 1 end)');
    expect(sql('COUNT(X)')).toBe('count(t.x)');
  });

  it('cannot chain comparisons in SQL, so it parenthesizes them', () => {
    expect(sql('A = B = C')).toBe('(t.a = t.b) = t.c');
  });

  it('keeps a double negative', () => {
    expect(sql('- -A')).toBe('-(-t.a)');
  });

  it('gives DECODE without a default no ELSE', () => {
    expect(sql("DECODE(A, 1, 'one')")).toBe("case when t.a = 1 then 'one' end");
  });
});

describe('unsupported input fails loudly', () => {
  it.each([
    ['an unknown function', 'MD5(X)'],
    ['IIF without an else value', 'IIF(X > 1, 1)'],
    ['a lookup call', ':LKP.LKP_CUSTOMER(ID)'],
    ['an unsupported date format', "TO_CHAR(ORDERED_DATE, 'RR')"],
    ['a syntax error', 'IIF(X > 1, 1'],
    ['an unclosed string', "A = 'abc"],
    ['an empty expression', '   '],
    ['trailing input', 'A B'],
    ['* outside COUNT', 'SUM(*)'],
    ['a number format in TO_CHAR', "TO_CHAR(AMOUNT, '999.99')"],
    ['DATE_DIFF in months (Informatica prorates them)', "DATE_DIFF(RUN_DATE, LAST_DATE, 'MM')"],
    ['TRUNC of a number to a precision', 'TRUNC(AMOUNT, 2)'],
    ['DECODE with too few arguments', 'DECODE(A, 1)'],
  ])('%s', (_, expression) => {
    expect(() => sql(expression)).toThrow(UnsupportedError);
  });
});
