-- The dbt-labs/jaffle-shop models the PowerCenter export mirrors, ported to plain
-- DuckDB SQL so the test can run them next to the generated models:
--   {{ source('ecom', 'raw_x') }}  -> raw.raw_x
--   {{ ref('x') }}                 -> reference.x
--   {{ cents_to_dollars('c') }}    -> (c / 100)::numeric(16, 2)
--   {{ dbt.date_trunc('day', c) }} -> date_trunc('day', c)
-- Source: https://github.com/dbt-labs/jaffle-shop/tree/main/models
-- Not ported: stg_supplies.supply_uuid (needs dbt_utils), metricflow_time_spine.

create schema reference;

create view reference.stg_customers as
select
    id as customer_id,
    name as customer_name
from raw.raw_customers;

create view reference.stg_locations as
select
    id as location_id,
    name as location_name,
    tax_rate,
    date_trunc('day', opened_at) as opened_date
from raw.raw_stores;

create view reference.stg_order_items as
select
    id as order_item_id,
    order_id,
    sku as product_id
from raw.raw_items;

create view reference.stg_orders as
select
    id as order_id,
    store_id as location_id,
    customer as customer_id,
    subtotal as subtotal_cents,
    tax_paid as tax_paid_cents,
    order_total as order_total_cents,
    (subtotal / 100)::numeric(16, 2) as subtotal,
    (tax_paid / 100)::numeric(16, 2) as tax_paid,
    (order_total / 100)::numeric(16, 2) as order_total,
    date_trunc('day', ordered_at) as ordered_at
from raw.raw_orders;

create view reference.stg_products as
select
    sku as product_id,
    name as product_name,
    type as product_type,
    description as product_description,
    (price / 100)::numeric(16, 2) as product_price,
    coalesce(type = 'jaffle', false) as is_food_item,
    coalesce(type = 'beverage', false) as is_drink_item
from raw.raw_products;

create view reference.stg_supplies as
select
    id as supply_id,
    sku as product_id,
    name as supply_name,
    (cost / 100)::numeric(16, 2) as supply_cost,
    -- raw_supplies.perishable is loaded as varchar (as in the Oracle source), so cast here.
    perishable::boolean as is_perishable_supply
from raw.raw_supplies;

create view reference.products as select * from reference.stg_products;

create view reference.supplies as select * from reference.stg_supplies;

create view reference.locations as select * from reference.stg_locations;

create view reference.order_items as
with order_supplies_summary as (
    select product_id, sum(supply_cost) as supply_cost
    from reference.stg_supplies
    group by 1
)
select
    order_items.*,
    orders.ordered_at,
    products.product_name,
    products.product_price,
    products.is_food_item,
    products.is_drink_item,
    order_supplies_summary.supply_cost
from reference.stg_order_items as order_items
left join reference.stg_orders as orders on order_items.order_id = orders.order_id
left join reference.stg_products as products on order_items.product_id = products.product_id
left join order_supplies_summary on order_items.product_id = order_supplies_summary.product_id;

create view reference.orders as
with order_items_summary as (
    select
        order_id,
        sum(supply_cost) as order_cost,
        sum(product_price) as order_items_subtotal,
        count(order_item_id) as count_order_items,
        sum(case when is_food_item then 1 else 0 end) as count_food_items,
        sum(case when is_drink_item then 1 else 0 end) as count_drink_items
    from reference.order_items
    group by 1
),
compute_booleans as (
    select
        orders.*,
        order_items_summary.order_cost,
        order_items_summary.order_items_subtotal,
        order_items_summary.count_food_items,
        order_items_summary.count_drink_items,
        order_items_summary.count_order_items,
        order_items_summary.count_food_items > 0 as is_food_order,
        order_items_summary.count_drink_items > 0 as is_drink_order
    from reference.stg_orders as orders
    left join order_items_summary on orders.order_id = order_items_summary.order_id
)
select
    *,
    row_number() over (partition by customer_id order by ordered_at asc) as customer_order_number
from compute_booleans;

create view reference.customers as
with customer_orders_summary as (
    select
        orders.customer_id,
        count(distinct orders.order_id) as count_lifetime_orders,
        count(distinct orders.order_id) > 1 as is_repeat_buyer,
        min(orders.ordered_at) as first_ordered_at,
        max(orders.ordered_at) as last_ordered_at,
        sum(orders.subtotal) as lifetime_spend_pretax,
        sum(orders.tax_paid) as lifetime_tax_paid,
        sum(orders.order_total) as lifetime_spend
    from reference.orders as orders
    group by 1
)
select
    customers.*,
    customer_orders_summary.count_lifetime_orders,
    customer_orders_summary.first_ordered_at,
    customer_orders_summary.last_ordered_at,
    customer_orders_summary.lifetime_spend_pretax,
    customer_orders_summary.lifetime_tax_paid,
    customer_orders_summary.lifetime_spend,
    case when customer_orders_summary.is_repeat_buyer then 'returning' else 'new' end as customer_type
from reference.stg_customers as customers
left join customer_orders_summary on customers.customer_id = customer_orders_summary.customer_id;
