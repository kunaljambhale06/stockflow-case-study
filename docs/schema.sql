
-- PART 2 - DATABASE SCHEMA
-- StockFlow Inventory Management
--
-- DESIGN DECISIONS:
--
-- 1. UUIDs vs integer IDs
--    Using BIGSERIAL (auto-increment integers) for simplicity in a take-home context.
--    In production I'd use UUID so IDs are safe to expose in URLs and don't leak
--    record counts to clients.
--
-- 2. Soft deletes
--    Critical business records (products, warehouses, suppliers) use deleted_at
--    instead of hard DELETE. Deleting a product that has order history would
--    break foreign key references or orphan audit logs.
--
-- 3. Inventory as a separate table (not a column on products)
--    The requirement says products can exist in multiple warehouses with different
--    quantities. That's a many-to-many relationship - products <-> warehouses -
--    so inventory is the join table that holds the quantity per location.
--
-- 4. inventory_log for audit trail
--    "Track when inventory levels change" is a requirement. Rather than storing
--    history in the inventory row itself, we append to a log. This lets us
--    reconstruct any past state and calculate velocity (units sold per day).
--
-- 5. Bundle products
--    Handled with a self-referential product_bundle_items table.
--    A bundle product (is_bundle = true) has rows in this table pointing to its
--    components. Querying stock of a bundle = min(floor(component_stock / qty_required))
--    across all components - the code layer handles this calculation.
--
-- 6. Supplier <-> product relationship
--    One supplier can supply many products, one product can have multiple suppliers
--    (for redundancy/backup sourcing). product_suppliers is the join table and
--    holds the supplier-specific SKU and lead time.
--
-- QUESTIONS I WOULD ASK THE PRODUCT TEAM:
--
-- Q1: Can a single product have different prices in different warehouses/regions?
--     Currently price lives on the product. If regional pricing is needed
--     we'd move price to the inventory table.
--
-- Q2: What triggers an inventory_log entry - only sales, or also manual adjustments,
--     returns, damaged goods write-offs? Each reason needs its own change_reason value
--     so reporting can distinguish them.
--
-- Q3: For bundle stock calculation - does reserving a bundle reduce component stock
--     immediately (on order) or only on fulfillment? This affects how we track
--     "available" vs "committed" inventory.
--
-- Q4: Multi-currency? If companies operate in different countries, price needs a
--     currency_code column and the alert threshold comparison needs to be currency-aware.
--
-- Q5: What does "recent sales activity" mean for low-stock alerts? Last 7 days?
--     30 days? Should this be configurable per company?
--
-- Q6: Is warehouse_id always required when creating a product, or can a product
--     exist without being allocated to any warehouse yet?
--
-- Q7: Do we need to track which user made an inventory change, or just the system?
--     If yes, inventory_log needs a changed_by (user_id) column.


-- Companies (the B2B customers of StockFlow)
CREATE TABLE companies (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

-- Users belong to companies
CREATE TABLE users (
    id          BIGSERIAL PRIMARY KEY,
    company_id  BIGINT       NOT NULL REFERENCES companies(id),
    email       VARCHAR(255) NOT NULL UNIQUE,
    name        VARCHAR(255) NOT NULL,
    role        VARCHAR(50)  NOT NULL DEFAULT 'member', -- 'admin' | 'member'
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

-- Warehouses belong to companies
CREATE TABLE warehouses (
    id          BIGSERIAL PRIMARY KEY,
    company_id  BIGINT       NOT NULL REFERENCES companies(id),
    name        VARCHAR(255) NOT NULL,
    location    TEXT,                   -- free-text address for now; could normalize later
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_warehouses_company ON warehouses(company_id);

-- Products belong to companies
-- Bundles are products whose is_bundle flag is true
-- SKU is unique within a company (not globally, because two companies may reuse the same SKU)
CREATE TABLE products (
    id          BIGSERIAL PRIMARY KEY,
    company_id  BIGINT         NOT NULL REFERENCES companies(id),
    name        VARCHAR(255)   NOT NULL,
    sku         VARCHAR(100)   NOT NULL,
    price       NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
    is_bundle   BOOLEAN        NOT NULL DEFAULT FALSE,
    -- low_stock_threshold: when current stock falls below this, fire an alert
    -- nullable - if null, the company-level or product-type default applies
    low_stock_threshold INT,
    -- days_of_sales_for_activity: how many days back to check for "recent" sales
    -- also nullable so we can fall back to a company default (see Q5 above)
    created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ,

    UNIQUE (company_id, sku)
);

CREATE INDEX idx_products_company ON products(company_id);

-- Bundle components: a bundle product contains N units of M component products
CREATE TABLE product_bundle_items (
    bundle_product_id    BIGINT  NOT NULL REFERENCES products(id),
    component_product_id BIGINT  NOT NULL REFERENCES products(id),
    quantity_required    INT     NOT NULL CHECK (quantity_required > 0),
    PRIMARY KEY (bundle_product_id, component_product_id),
    CHECK (bundle_product_id <> component_product_id) -- prevent self-referential bundle
);

-- Inventory: stock levels per product per warehouse
-- This is the source of truth for "how many units are here right now"
CREATE TABLE inventory (
    id           BIGSERIAL PRIMARY KEY,
    product_id   BIGINT NOT NULL REFERENCES products(id),
    warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),
    quantity     INT    NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (product_id, warehouse_id) -- one row per product-warehouse combination
);

CREATE INDEX idx_inventory_product   ON inventory(product_id);
CREATE INDEX idx_inventory_warehouse ON inventory(warehouse_id);

-- Inventory log: every change to stock appends a row here
-- Lets us calculate velocity and audit who changed what
CREATE TABLE inventory_log (
    id              BIGSERIAL PRIMARY KEY,
    inventory_id    BIGINT         NOT NULL REFERENCES inventory(id),
    quantity_before INT            NOT NULL,
    quantity_after  INT            NOT NULL,
    -- delta is stored explicitly so queries don't need to join adjacent rows
    delta           INT            NOT NULL GENERATED ALWAYS AS (quantity_after - quantity_before) STORED,
    change_reason   VARCHAR(50)    NOT NULL, -- 'sale' | 'restock' | 'adjustment' | 'return' | 'damage'
    reference_id    BIGINT,                  -- order_id, purchase_order_id etc - nullable
    changed_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_log_inventory ON inventory_log(inventory_id);
CREATE INDEX idx_inventory_log_changed_at ON inventory_log(changed_at);

-- Suppliers: external companies that sell products to our customers
CREATE TABLE suppliers (
    id            BIGSERIAL PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    contact_email VARCHAR(255),
    contact_phone VARCHAR(50),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
);

-- A company's view of a supplier (a supplier can work with multiple companies)
CREATE TABLE company_suppliers (
    company_id  BIGINT NOT NULL REFERENCES companies(id),
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id),
    PRIMARY KEY (company_id, supplier_id)
);

-- Which supplier provides which product, and what are the terms
-- A product can have multiple suppliers (backup sourcing)
CREATE TABLE product_suppliers (
    id                BIGSERIAL PRIMARY KEY,
    product_id        BIGINT       NOT NULL REFERENCES products(id),
    supplier_id       BIGINT       NOT NULL REFERENCES suppliers(id),
    supplier_sku      VARCHAR(100),           -- supplier's own SKU for this product
    lead_time_days    INT,                    -- typical days from order to delivery
    unit_cost         NUMERIC(12, 2),         -- what we pay the supplier per unit
    is_preferred      BOOLEAN NOT NULL DEFAULT FALSE, -- show this supplier first in alerts
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (product_id, supplier_id)
);

CREATE INDEX idx_product_suppliers_product ON product_suppliers(product_id);