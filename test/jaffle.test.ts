/**
 * Runs every generated model in DuckDB on a slice of the real jaffle-shop data
 * and compares it with the jaffle-shop project the mapping mirrors.
 *
 * The first group of tests is "same as jaffle-shop". The second group pins
 * down every place where the output differs, and why: in each case the
 * converter does what the mapping says, and the mapping differs from
 * jaffle-shop (or is wired wrongly).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { convertFolder } from '../src/convert.ts';
import { decodeExport, parseExport } from '../src/powercenter.ts';
import { Warehouse, type Row } from './support/warehouse.ts';

const folder = parseExport(decodeExport(readFileSync('examples/FLOWLINE_DEMO_JAFFLESHOP.xml')))[0]!;
const result = convertFolder(folder);
let warehouse: Warehouse;

beforeAll(async () => {
  warehouse = await Warehouse.create(folder, result, 'test/fixtures/jaffle');
  const reference = readFileSync('test/reference/jaffle_shop.sql', 'utf8');
  for (const statement of reference.split(/;\s*\n/)) {
    if (statement.replace(/--.*$/gm, '').trim()) await warehouse.run(statement);
  }
});

/**
 * Rows that are in one relation but not the other (multiset difference both
 * ways), comparing converted expressions with reference expressions.
 */
async function differences(converted: string, reference: string, columns: Record<string, string>): Promise<Row[]> {
  const select = (exprs: string[]) => exprs.map((e, i) => `${e} as c${i}`).join(', ');
  const ours = select(Object.keys(columns));
  const theirs = select(Object.values(columns));
  return warehouse.query(`
    select 'only in converted' as side, * from (select ${ours} from ${converted} except all select ${theirs} from ${reference})
    union all
    select 'only in reference' as side, * from (select ${theirs} from ${reference} except all select ${ours} from ${converted})
    limit 5`);
}

const same = (...names: string[]) => Object.fromEntries(names.map((n) => [n, n]));
const money = (converted: string, reference = converted) => ({ [`round(${converted}, 2)`]: `round(${reference}, 2)` });
const count = async (sql: string) => Number((await warehouse.query(`select count(*) as n from ${sql}`))[0]!.n);

it('the comparison catches a real difference (guards against vacuous passes)', async () => {
  const rows = await differences('stg_orders', 'reference.stg_orders', same('order_id', 'subtotal'));
  expect(rows.map((r) => r.side)).toContain('only in converted');
});

it('every generated model runs', async () => {
  for (const model of result.models) {
    await expect(count(model.name), model.name).resolves.toBeGreaterThan(0);
  }
});

describe('matches jaffle-shop', () => {
  it('stg_customers', async () => {
    expect(await differences('stg_customers', 'reference.stg_customers', same('customer_id', 'customer_name'))).toEqual([]);
  });

  it('stg_locations (Router + Union round trip keeps every store)', async () => {
    const columns = same('location_id', 'location_name', 'tax_rate', 'opened_date');
    expect(await differences('stg_locations', 'reference.stg_locations', columns)).toEqual([]);
  });

  it('stg_order_items', async () => {
    const columns = same('order_item_id', 'order_id', 'product_id');
    expect(await differences('stg_order_items', 'reference.stg_order_items', columns)).toEqual([]);
  });

  it('stg_orders keys, and the TO_DATE(TO_CHAR(...)) day truncation', async () => {
    const columns = { ...same('order_id', 'customer_id', 'location_id'), ordered_at_day: 'ordered_at' };
    expect(await differences('stg_orders', 'reference.stg_orders', columns)).toEqual([]);
  });

  it('stg_products (integer flags vs booleans)', async () => {
    const columns = {
      ...same('product_id', 'product_name', 'product_type', 'product_description'),
      'is_food_item = 1': 'is_food_item',
      'is_drink_item = 1': 'is_drink_item',
    };
    expect(await differences('stg_products', 'reference.stg_products', columns)).toEqual([]);
  });

  it('stg_supplies (all but the perishable flag)', async () => {
    const columns = { ...same('supply_id', 'product_id', 'supply_name'), ...money('supply_cost') };
    expect(await differences('stg_supplies', 'reference.stg_supplies', columns)).toEqual([]);
  });

  it('products and supplies pass staging through', async () => {
    expect(await differences('products', 'reference.products', same('product_id', 'product_name', 'product_type'))).toEqual([]);
    expect(await differences('supplies', 'reference.supplies', same('supply_id', 'product_id', 'supply_name'))).toEqual([]);
  });

  it('order_items (all but the price, see below)', async () => {
    const columns = {
      ...same('order_item_id', 'order_id', 'product_id', 'product_name'),
      ordered_at_day: 'ordered_at',
      'is_food_item = 1': 'is_food_item',
      ...money('supply_cost_per_product', 'supply_cost'),
    };
    expect(await differences('order_items', 'reference.order_items', columns)).toEqual([]);
  });

  it('customers, for the customers it keeps', async () => {
    const columns = {
      ...same('customer_id', 'customer_name', 'customer_type'),
      lifetime_orders: 'count_lifetime_orders',
      first_order_date: 'first_ordered_at',
      last_order_date: 'last_ordered_at',
    };
    const withOrders = '(select * from reference.customers where count_lifetime_orders is not null)';
    expect(await differences('customers', withOrders, columns)).toEqual([]);
  });
});

describe('differs from jaffle-shop because of the mapping', () => {
  it('stg_orders: the target connectors swap the cents and dollar columns', async () => {
    const columns = { subtotal: 'subtotal_cents', subtotal_cents: 'subtotal', order_total: 'order_total_cents', order_total_cents: 'order_total' };
    expect(await differences('stg_orders', 'reference.stg_orders', { order_id: 'order_id', ...columns })).toEqual([]);
  });

  it('stg_products: the target connectors swap price and price in cents', async () => {
    const columns = { product_id: 'product_id', product_price: 'product_price * 100', product_price_cents: 'product_price' };
    expect(await differences('stg_products', 'reference.stg_products', columns)).toEqual([]);
  });

  it('orders: amounts are 100x too small (the swapped "cents" column is divided by 100 again)', async () => {
    const columns = { order_id: 'order_id', ...money('subtotal * 100', 'subtotal'), ...money('order_total * 100', 'order_total') };
    const withItems = '(select * from reference.orders where count_order_items is not null)';
    expect(await differences('orders', withItems, columns)).toEqual([]);
  });

  it('orders: an order without items is dropped (Master Outer Join keeps detail rows only)', async () => {
    const withoutItems = await count('reference.orders where count_order_items is null');
    expect(withoutItems).toBeGreaterThan(0);
    expect(await count('orders')).toBe((await count('reference.orders')) - withoutItems);
  });

  it('customers: customers without orders are dropped (same join pattern)', async () => {
    expect(await count('customers')).toBe(await count('reference.customers where count_lifetime_orders is not null'));
    expect(await count('customers')).toBeLessThan(await count('reference.customers'));
  });

  it("stg_supplies: is_perishable is always 0 (the mapping tests 'Y'/'1', the data says 'True'/'False')", async () => {
    expect(await warehouse.query('select distinct is_perishable from stg_supplies')).toEqual([{ is_perishable: 0 }]);
    expect(await count('reference.stg_supplies where is_perishable_supply')).toBeGreaterThan(0);
  });

  it('store_daily_kpis: unique_customers is always 0 (v_PREV_* is assigned before it is compared)', async () => {
    expect(await warehouse.query('select distinct unique_customers from store_daily_kpis')).toEqual([{ unique_customers: '0' }]);
  });

  it('orders: customer_order_number is NULL (stateful variable port, not converted)', async () => {
    expect(await count('orders where customer_order_number is not null')).toBe(0);
  });
});
