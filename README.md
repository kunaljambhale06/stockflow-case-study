# stockflow-case-study

Node.js + Express REST API for the StockFlow B2B inventory management case study.
 
---

## Project structure
 
```
stockflow-api/
├── src/
│   ├── index.js              # Express app entry point
│   ├── db/
│   │   └── pool.js           # Postgres connection pool
│   └── routes/
│       ├── products.js       # Part 1 - fixed product creation
│       └── alerts.js         # Part 3 - low-stock alerts
├── docs/
│   └── schema.sql            # Part 2 - database schema
├── .env.example
└── package.json
```
 
---
 
## Running locally
 
```bash
npm install
cp .env.example .env
# Edit .env with your Postgres connection string
npm run dev
```
 
Requires Node 18+ (uses `--watch` for dev, native ESM via `"type": "module"`).
 
---
 
## Part 1 — Code review & debug
 
**File:** `src/routes/products.js`
 
The original code had 7 issues. Here's the summary — full reasoning is in the file comments.
 
| # | Issue | Impact in production |
|---|-------|----------------------|
| 1 | No input validation | Any missing field throws a 500 with a stack trace |
| 2 | No unique SKU check | Relies on a DB constraint error, which leaks internals and returns a 500 instead of a 400 |
| 3 | Two separate commits | If inventory insert fails after product is committed, you get a product with no stock record — silent corrupted data |
| 4 | Price not validated as a number | String input could store `NaN` or `0` depending on DB column type |
| 5 | `initial_quantity` not validated | Negative stock is nonsense; missing quantity crashes the insert |
| 6 | No error handling | Unhandled rejections crash the process or return raw stack traces |
| 7 | Always returns 200 | Created resources should be 201; bad input should be 400 |
 
**The most important fix** is wrapping both inserts in a single transaction. Two separate `commit()` calls means a crash between them leaves you with a product that has no inventory row — that's the kind of bug that causes phantom stock counts and alert failures downstream.
 
---
 
## Part 2 — Database schema
 
**File:** `docs/schema.sql`
 
### Tables
 
| Table | Purpose |
|-------|---------|
| `companies` | B2B customers of StockFlow |
| `users` | Employees of a company |
| `warehouses` | Physical locations a company owns |
| `products` | Items with a SKU and price, scoped to a company |
| `product_bundle_items` | Self-referential: which products make up a bundle |
| `inventory` | Stock level per product per warehouse |
| `inventory_log` | Append-only record of every stock change |
| `suppliers` | External suppliers |
| `company_suppliers` | Which companies use which suppliers |
| `product_suppliers` | Which supplier provides which product, with lead time and cost |
 
### Key design decisions
 
**Inventory as a join table, not a column on products**  
Products can exist in multiple warehouses with different quantities. That's a many-to-many between products and warehouses, so `inventory` is the join table that holds `quantity` per location.
 
**Append-only `inventory_log`**  
The requirement says to track when inventory levels change. Instead of overwriting the inventory row and losing history, every change appends a row to `inventory_log`. This gives us a full audit trail and lets us calculate sales velocity (units sold per day) for the low-stock projection.
 
**Soft deletes (`deleted_at`)**  
Hard-deleting a product that has sales history would break foreign keys or orphan logs. Soft deletes keep the data integrity while hiding the record from normal queries.
 
**SKU uniqueness scoped to company, not globally**  
Two different companies may legitimately use the same SKU format. A global unique constraint would reject valid data. The constraint is `UNIQUE(company_id, sku)`.
 
### Open questions for the product team
 
1. Can a product have different prices in different warehouses? If yes, price moves from `products` to `inventory`.
2. What counts as "recent" for low-stock alerts — 7 days? 30? Should it be configurable per company?
3. Does reserving a bundle deduct component stock on order or only on fulfillment?
4. Do we need multi-currency support? If yes, `price` needs a `currency_code` column.
5. Should `inventory_log` track which user made the change, or just the reason?
 
---
 
## Part 3 — Low-stock alerts endpoint
 
**File:** `src/routes/alerts.js`
 
```
GET /api/companies/:company_id/alerts/low-stock
```
 
### Assumptions
 
| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | "Recent sales activity" = at least 1 sale in last 30 days | Products with zero sales in 30 days could be discontinued — alerting on them would be noise |
| A2 | Default threshold = 20 units, overridable per product | Kept as env var so it can change without a deploy |
| A3 | `days_until_stockout` = `stock / (units_sold_30d / 30)` | Null if velocity is 0 (can't project), 0 if already out of stock |
| A4 | Preferred supplier shown first, then shortest lead time | Gives the buyer the most actionable contact |
| A5 | Bundle products excluded from alerts | Bundle stock is derived from components — alerting on the bundle itself would be misleading |
 
### How the query works
 
1. **`recent_sales` CTE** — calculates units sold per inventory record in the last N days, using `inventory_log` rows with `change_reason = 'sale'`
2. **`ranked_suppliers` CTE** — picks one supplier per product using `ROW_NUMBER()` ordered by preferred flag, then lead time
3. **Main query** — joins everything, filters below threshold + has sales activity, calculates days until stockout, orders by urgency (out of stock first, then fewest days left)
 
### Edge cases handled
 
- Non-numeric `company_id` → 400
- Company not found or soft-deleted → 404
- No warehouses or no products → empty `alerts` array (not an error)
- Product with no supplier → `supplier: null` in response (not omitted)
- Stock already at 0 → `days_until_stockout: 0`
- Zero sales velocity → `days_until_stockout: null`
- Negative stock (data anomaly) → clamped to 0 via `GREATEST(quantity, 0)`
 
---
 
## What I would add with more time
 
- **Authentication middleware** — right now any caller can query any company's alerts by guessing a company ID. In production, a JWT would carry the `company_id` claim and the route would verify the caller owns that company.
- **Pagination** — a company with thousands of low-stock SKUs across many warehouses would return a huge payload. A `?limit=50&offset=0` or cursor-based pagination would be needed.
- **Integration tests** — I'd use a real Postgres instance (Docker in CI) to test the transaction rollback behaviour in Part 1 and the CTE logic in Part 3.
- **Request ID / structured logging** — add a middleware that stamps each request with a UUID so errors in logs can be traced back to a specific call.

