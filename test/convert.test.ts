import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertFolder, type DbtModel } from '../src/convert.ts';
import { dbtProjectFiles } from '../src/dbt.ts';
import { decodeExport, parseExport, type Folder } from '../src/powercenter.ts';
import { cteBody, cteNames } from './support/sql.ts';

const loadSample = (): Folder => parseExport(decodeExport(readFileSync('examples/FLOWLINE_DEMO_JAFFLESHOP.xml')))[0]!;
const result = convertFolder(loadSample());
const model = (name: string): DbtModel => {
  const found = result.models.find((m) => m.name === name);
  if (!found) throw new Error(`no model ${name}`);
  return found;
};
/** One CTE's body, so that an assertion cannot match another CTE by accident. */
const cte = (modelName: string, cteName: string): string => cteBody(model(modelName).sql, cteName);

describe('parsing the sample export', () => {
  it('finds the mappings, sources and targets', () => {
    const folder = loadSample();
    expect(folder.mappings.map((m) => m.name)).toEqual(['m_FL_JS_STAGING_FULL', 'm_FL_JS_MARTS_ENRICHED', 'm_FL_JS_MARTS_CORE']);
    expect(folder.sources.size).toBe(12);
    expect(folder.targets.size).toBe(16);
  });

  it('decodes character references inside expressions', () => {
    const exp = loadSample().mappings[0]!.transformations.get('EXP_LOCATIONS')!;
    expect(exp.ports.find((p) => p.name === 'REGION')!.expression).toContain("'EMEA',\r\nIIF(");
  });
});

describe('converting the sample', () => {
  it('produces one model per target and no errors', () => {
    expect(result.errors).toEqual([]);
    expect(result.models.map((m) => m.name).sort()).toEqual(
      [
        'customer_360', 'customers', 'order_financials', 'order_item_enriched', 'order_items', 'orders',
        'product_daily_performance', 'products', 'stg_customers', 'stg_locations', 'stg_order_items',
        'stg_orders', 'stg_products', 'stg_supplies', 'store_daily_kpis', 'supplies',
      ].sort(),
    );
  });

  it('reads raw tables as sources and tables loaded by another mapping as refs', () => {
    expect(result.sources).toEqual([
      { name: 'raw', tables: ['raw_customers', 'raw_items', 'raw_orders', 'raw_products', 'raw_stores', 'raw_supplies'] },
    ]);
    expect(model('stg_orders').sql).toContain("{{ source('raw', 'raw_orders') }}");
    expect(model('orders').sql).toContain("{{ ref('stg_orders') }}");
    expect(model('orders').sql).not.toContain('source(');
  });

  it.each(result.models.map((m) => m.name))('%s: every CTE comes after the CTEs it reads from', (name) => {
    const names = cteNames(model(name).sql);
    names.forEach((cteName, position) => {
      const body = cte(name, cteName);
      const readFrom = names.filter((other) => new RegExp(`\\b(from|join) ${other}\\b`).test(body));
      for (const other of readFrom) expect(names.indexOf(other), `${cteName} reads ${other}`).toBeLessThan(position);
    });
    expect(names.length).toBeGreaterThan(0);
  });
});

describe('transformation semantics', () => {
  it('Normal Join becomes an inner join', () => {
    expect(cte('stg_supplies', 'jnr_supplies_products')).toContain(
      'from sq_raw_supplies\n    inner join sq_raw_products1\n        on sq_raw_products1.sku = sq_raw_supplies.sku',
    );
  });

  it('Master Outer Join keeps every *detail* row: detail left join master', () => {
    // Customers are the master side here, so customers without orders are dropped.
    expect(cte('customers', 'jnr_customers_orders')).toContain('from agg_orders_by_customer\n    left join sq_stg_customers');
  });

  it('Aggregator groups by its group-by ports', () => {
    const agg = cte('customers', 'agg_orders_by_customer');
    expect(agg).toContain('count(sq_stg_orders2.order_id) as lifetime_orders');
    expect(agg).toContain('group by sq_stg_orders2.customer_id');
  });

  it('Router becomes one filtered CTE per connected group; the unconnected default group is skipped', () => {
    const sql = model('stg_locations').sql;
    expect(cte('stg_locations', 'rtr_region__g_apac')).toContain("where srt_loc_before.region = 'APAC'");
    expect(sql).toContain('rtr_region__g_amer as (');
    expect(sql).toContain('rtr_region__g_emea as (');
    expect(sql).not.toContain('default1');
  });

  it('Union becomes UNION ALL over its input groups', () => {
    expect(cte('stg_locations', 'un_regions').match(/union all/g)).toHaveLength(2);
  });

  it('Sorter keeps its columns but drops the ordering', () => {
    for (const m of result.models) expect(m.sql).not.toMatch(/order by/i);
  });

  it('Filter becomes WHERE', () => {
    expect(cte('store_daily_kpis', 'fil_locs')).toContain('where not jnr_add_location_info.location_id is null');
  });

  it('inlines stateless variable ports', () => {
    // v_MARGIN_CALC uses v_SUPPLY_COST_CL, both inlined into the output port.
    expect(cte('order_item_enriched', 'exp_item_calculations')).toContain(
      'case when jnr_add_supplies.product_price = 0 then 0 else (jnr_add_supplies.product_price - ' +
        'coalesce(jnr_add_supplies.supply_cost_per_product, 0)) / jnr_add_supplies.product_price end as item_gross_margin_pct',
    );
  });

  it('maps the $$RUN_DATE mapping parameter to a dbt var with its default', () => {
    expect(model('customer_360').sql).toContain(`cast('{{ var("run_date", "2025-12-31 00:00:00") }}' as timestamp)`);
  });
});

describe('what the converter refuses to guess', () => {
  it('replaces stateful variable ports with NULL and says why', () => {
    expect(cte('orders', 'exp_customer_order_num')).toContain('null /* UNSUPPORTED: see warning above */ as customer_order_number');
    expect(model('orders').warnings).toContainEqual(
      expect.stringContaining('v_ORDER_SEQUENCE reads the previous row\'s value of v_ORDER_SEQUENCE'),
    );
    expect(model('orders').sql).toContain('-- WARNING: EXP_CUSTOMER_ORDER_NUM.CUSTOMER_ORDER_NUMBER set to NULL');
  });

  it('flags connectors that look like swapped columns', () => {
    expect(model('stg_orders').warnings).toContainEqual(
      'suspicious wiring: SRT_ORDERS.SUBTOTAL feeds STG_ORDERS.SUBTOTAL_CENTS, but SRT_ORDERS also has a port named SUBTOTAL_CENTS',
    );
    const flagged = result.models.filter((m) => m.warnings.some((w) => w.startsWith('suspicious wiring'))).map((m) => m.name);
    expect(flagged.sort()).toEqual(['customer_360', 'product_daily_performance', 'stg_orders', 'stg_products']);
  });

  it('reports an unsupported transformation for that target only', () => {
    const folder = loadSample();
    folder.mappings[0]!.transformations.get('EXP_PRODUCTS')!.type = 'Lookup Procedure';
    const broken = convertFolder(folder);
    expect(broken.errors).toEqual(['m_FL_JS_STAGING_FULL -> STG_PRODUCTS: Lookup Procedure transformation EXP_PRODUCTS is not supported']);
    expect(broken.models).toHaveLength(15);
  });
});

describe('dbt project layout', () => {
  it('writes one folder per mapping plus sources.yml and dbt_project.yml', () => {
    const paths = dbtProjectFiles(result, 'demo').map((f) => f.path);
    expect(paths).toContain('dbt_project.yml');
    expect(paths).toContain('models/sources.yml');
    expect(paths).toContain('models/m_fl_js_staging_full/stg_orders.sql');
    expect(paths).toContain('models/m_fl_js_marts_core/customers.sql');
  });
});
