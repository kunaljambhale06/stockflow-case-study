import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

// PART 1 - FIXED: POST /api/products
//
// ISSUES FOUND IN THE ORIGINAL CODE:
//
// 1. NO INPUT VALIDATION
//    Original did: data['name'], data['sku'] etc with no checks
//    Problem: if any field is missing the whole request crashes with a 500.
//    Fix: validate required fields upfront and return a 400 with a clear message.
//
// 2. NO UNIQUE SKU CHECK
//    Business rule says SKUs must be unique across the platform.
//    Original code just tried to insert and would throw a DB-level constraint error
//    that leaks implementation details to the client (ugly 500 instead of 400).
//    Fix: check for existing SKU before inserting and return a readable error.
//
// 3. TWO SEPARATE COMMITS = PARTIAL DATA ON FAILURE
//    Original did: commit product -> commit inventory as two separate transactions.
//    If the inventory insert failed, the product row already existed with no inventory.
//    That's silent corrupted data - product exists but has no stock record.
//    Fix: wrap both inserts in a single transaction so it's all-or-nothing.
//
// 4. PRICE NOT VALIDATED AS A NUMBER
//    Original trusted whatever came in as price. A string like "abc" would either
//    fail at the DB level or get stored as 0 depending on the column type.
//    Fix: parse and validate price is a positive finite number.
//
// 5. initial_quantity NOT VALIDATED
//    Could be negative, null, or missing entirely. Inventory with -10 units is nonsense.
//    Fix: default to 0 if not provided, reject negative values.
//
// 6. NO ERROR HANDLING AT ALL
//    Any DB error would bubble up as an unhandled rejection and kill the process
//    or return a 500 with a stack trace.
//    Fix: try/catch with proper cleanup (release the client back to the pool).
//
// 7. NO HTTP STATUS CODES
//    Original returned 200 for everything. A created resource should be 201.
//    Errors should be 400 (bad input) or 500 (server fault).
//    Fix: use correct status codes throughout.

router.post("/", async (req, res) => {
  const { name, sku, price, warehouse_id, initial_quantity } = req.body;

  // Validate required fields
  if (!name || !sku || price === undefined || !warehouse_id) {
    return res.status(400).json({
      error: "name, sku, price, and warehouse_id are required",
    });
  }

  const parsedPrice = parseFloat(price);
  if (isNaN(parsedPrice) || parsedPrice < 0) {
    return res.status(400).json({ error: "price must be a positive number" });
  }

  const quantity = initial_quantity ?? 0;
  if (quantity < 0) {
    return res.status(400).json({ error: "initial_quantity cannot be negative" });
  }

  // Grab a single client from the pool so we can run a transaction
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Check SKU uniqueness before inserting - gives a readable error vs DB constraint noise
    const existing = await client.query(
      "SELECT id FROM products WHERE sku = $1",
      [sku]
    );
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `SKU '${sku}' already exists` });
    }

    // Insert the product
    const productResult = await client.query(
      `INSERT INTO products (name, sku, price) VALUES ($1, $2, $3) RETURNING id`,
      [name, sku, parsedPrice]
    );
    const productId = productResult.rows[0].id;

    // Insert the inventory record in the same transaction
    // If this fails, the product insert rolls back too - no orphaned data
    await client.query(
      `INSERT INTO inventory (product_id, warehouse_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_id, warehouse_id)
       DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity`,
      [productId, warehouse_id, quantity]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Product created",
      product_id: productId,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("create_product error:", err);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    // Always release - otherwise the pool runs out of connections under load
    client.release();
  }
});

export default router;