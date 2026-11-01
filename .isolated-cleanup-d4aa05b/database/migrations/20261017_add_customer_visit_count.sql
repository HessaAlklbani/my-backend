-- Run once against watersport_db.
-- Preserve historical visit counts by counting invoices already linked to each customer.
ALTER TABLE customers
    ADD COLUMN No_visit INT UNSIGNED NOT NULL DEFAULT 0;

UPDATE customers c
LEFT JOIN (
    SELECT customer_id, COUNT(*) AS visit_count
    FROM invoices
    GROUP BY customer_id
) invoice_counts ON invoice_counts.customer_id = c.id
SET c.No_visit = COALESCE(invoice_counts.visit_count, 0);
