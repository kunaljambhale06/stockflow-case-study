import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router({ mergeParams: true });

// PART 3 - GET /api/companies/:company_id/alerts/low-stock
//
// ASSUMPTIONS MADE (would clarify with the team before shipping):
//
// A1. "Recent sales activity" = at least 1 sale in the last 30 days.
//     Products with zero sales in 30 days are excluded - they may just be
//     discontinued or seasonal, not genuinely low stock situations.
//
// A2. Low stock threshold per product - products.low_stock_threshold column.
//     If null, fall back to a default of 20 units (configurable via env var).
//
// A3. days_until_stockout is calculated as:
//       current_stock / (units_sold_last_30_days / 30)
//     If daily velocity rounds to 0 we return null (can't project stockout).
//     If stock is already 0 we return 0.
//
// A4. We return the preferred supplier (product_suppliers.is_preferred = true).
//     If no preferred supplier exists, we pick the one with the shortest lead time.
//     If no supplier at all, supplier is null in the response.
//
// A5. company_id in the URL is trusted to exist - a 404 is returned if not found.
//     In production this would be validated via JWT claims so a user can't
//     query another company's alerts by guessing IDs.
//
// EDGE CASES HANDLED:
// - company not found → 404
// - company has no warehouses or no products → empty alerts array, not an error
// - product is a bundle → excluded (bundle stock is virtual, derived from components)
// - negative stock (data anomaly) → treated as 0 for projection purposes
// - non-numeric company_id → 400

router.get("/", async (req, res) => {
  const { company_id } = req.params;

  if (isNaN(parseInt(company_id, 10))) {
    return res.status(400).json({ error: "company_id must be a number" });
  }

  // Verify the company exists and isn't soft-deleted
  const companyCheck = await pool.query(
    "SELECT id FROM companies WHERE id = $1 AND deleted_at IS NULL",
    [company_id]
  );
  if (companyCheck.rows.length === 0) {
    return res.status(404).json({ error: "Company not found" });
  }

  const DEFAULT_THRESHOLD = parseInt(process.env.DEFAULT_LOW_STOCK_THRESHOLD ?? "20", 10);
  const ACTIVITY_WINDOW_DAYS = parseInt(process.env.ACTIVITY_WINDOW_DAYS ?? "30", 10);

  try {
    // Single query that:
    // 1. Joins products -> inventory -> warehouses for this company
    // 2. Calculates sales velocity from inventory_log (sales only, last 30 days)
    // 3. Filters to only products below their threshold
    // 4. Filters to only products with at least 1 sale in the activity window
    // 5. Fetches the best available supplier per product
    //
    // Using a CTE chain to keep this readable rather than nested subqueries
    const query = `
      WITH

      -- Step 1: sales velocity per product per warehouse over the activity window
      recent_sales AS (
        SELECT
          i.id            AS inventory_id,
          i.product_id,
          i.warehouse_id,
          -- sum of negative deltas = units sold (deltas are negative for sales)
          COALESCE(SUM(CASE WHEN il.change_reason = 'sale' THEN ABS(il.delta) ELSE 0 END), 0)
                          AS units_sold,
          COUNT(CASE WHEN il.change_reason = 'sale' THEN 1 END)
                          AS sale_count
        FROM inventory i
        JOIN warehouses w ON w.id = i.warehouse_id
        LEFT JOIN inventory_log il
               ON il.inventory_id = i.id
              AND il.change_reason = 'sale'
              AND il.changed_at >= NOW() - ($2 || ' days')::INTERVAL
        WHERE w.company_id = $1
          AND w.deleted_at IS NULL
        GROUP BY i.id, i.product_id, i.warehouse_id
      ),

      -- Step 2: pick the best supplier per product
      -- preferred > lowest lead time > first alphabetically
      ranked_suppliers AS (
        SELECT
          ps.product_id,
          s.id            AS supplier_id,
          s.name          AS supplier_name,
          s.contact_email,
          ROW_NUMBER() OVER (
            PARTITION BY ps.product_id
            ORDER BY ps.is_preferred DESC, ps.lead_time_days ASC NULLS LAST, s.name ASC
          ) AS rn
        FROM product_suppliers ps
        JOIN suppliers s ON s.id = ps.supplier_id
        WHERE s.deleted_at IS NULL
      )

      SELECT
        p.id                                              AS product_id,
        p.name                                            AS product_name,
        p.sku,
        w.id                                              AS warehouse_id,
        w.name                                            AS warehouse_name,
        GREATEST(i.quantity, 0)                           AS current_stock,
        COALESCE(p.low_stock_threshold, $3)               AS threshold,

        -- days until stockout: stock / daily_rate, null if rate is 0
        CASE
          WHEN i.quantity <= 0 THEN 0
          WHEN rs.units_sold = 0 THEN NULL
          ELSE FLOOR(
            GREATEST(i.quantity, 0) / (rs.units_sold::FLOAT / $2)
          )
        END                                               AS days_until_stockout,

        rs_sup.supplier_id,
        rs_sup.supplier_name,
        rs_sup.contact_email

      FROM recent_sales rs
      JOIN inventory i       ON i.id = rs.inventory_id
      JOIN products p        ON p.id = rs.product_id
      JOIN warehouses w      ON w.id = rs.warehouse_id
      LEFT JOIN ranked_suppliers rs_sup
             ON rs_sup.product_id = p.id AND rs_sup.rn = 1

      WHERE p.deleted_at  IS NULL
        AND p.is_bundle   = FALSE        -- bundles have no direct stock
        AND rs.sale_count > 0            -- must have had at least one sale recently
        AND i.quantity < COALESCE(p.low_stock_threshold, $3)  -- actually below threshold

      ORDER BY
        -- surface the most urgent first: already out of stock, then fewest days left
        CASE WHEN i.quantity = 0 THEN 0 ELSE 1 END ASC,
        days_until_stockout ASC NULLS LAST,
        p.name ASC
    `;

    const result = await pool.query(query, [
      company_id,
      ACTIVITY_WINDOW_DAYS,
      DEFAULT_THRESHOLD,
    ]);

    const alerts = result.rows.map((row) => ({
      product_id: row.product_id,
      product_name: row.product_name,
      sku: row.sku,
      warehouse_id: row.warehouse_id,
      warehouse_name: row.warehouse_name,
      current_stock: row.current_stock,
      threshold: row.threshold,
      days_until_stockout: row.days_until_stockout,
      supplier: row.supplier_id
        ? {
            id: row.supplier_id,
            name: row.supplier_name,
            contact_email: row.contact_email,
          }
        : null,
    }));

    return res.status(200).json({
      alerts,
      total_alerts: alerts.length,
    });
  } catch (err) {
    console.error("low_stock_alerts error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;