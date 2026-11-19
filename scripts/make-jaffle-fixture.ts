/**
 * Builds the small, deterministic slice of jaffle-shop data used by the
 * integration test (the full seeds are ~16 MB).
 *
 * Usage: node scripts/make-jaffle-fixture.ts <path to jaffle-shop>/seeds/jaffle-data
 *
 * Slice: every store, product and supply; the first 25 customers by id; their
 * orders from the first two months; and those orders' items. Customers whose
 * first order is later than that have no orders, which exercises the outer joins.
 */
import { mkdirSync } from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';

const seeds = process.argv[2];
if (!seeds) throw new Error('Usage: node scripts/make-jaffle-fixture.ts <jaffle-shop>/seeds/jaffle-data');
const out = 'test/fixtures/jaffle';
mkdirSync(out, { recursive: true });

const csv = (name: string) => `read_csv('${seeds}/${name}.csv', header = true, all_varchar = true)`;
const queries: Record<string, string> = {
  raw_stores: `select * from ${csv('raw_stores')}`,
  raw_products: `select * from ${csv('raw_products')}`,
  raw_supplies: `select * from ${csv('raw_supplies')}`,
  raw_customers: `select * from ${csv('raw_customers')} order by id limit 25`,
  raw_orders: `
    select * from ${csv('raw_orders')}
    where customer in (select id from ${csv('raw_customers')} order by id limit 25)
      and ordered_at < '2024-11-01'
    order by id`,
  raw_items: `
    select * from ${csv('raw_items')}
    where order_id in (
      select id from ${csv('raw_orders')}
      where customer in (select id from ${csv('raw_customers')} order by id limit 25)
        and ordered_at < '2024-11-01')
    order by id`,
};

const connection = await (await DuckDBInstance.create()).connect();
for (const [table, query] of Object.entries(queries)) {
  await connection.run(`copy (${query}) to '${out}/${table}.csv' (header)`);
  const count = await connection.runAndReadAll(`select count(*) as n from read_csv('${out}/${table}.csv')`);
  console.log(`${table}: ${count.getRowObjects()[0]!.n} rows`);
}
