-- Run once against watersport_db before deploying the Finance & VAT page.
-- Existing expense.amount is preserved as the full recorded amount paid.
-- Historical VAT stays unknown until a user reviews the supplier document.
ALTER TABLE expenses
    ADD COLUMN supplier_name VARCHAR(255) NULL AFTER created_by,
    ADD COLUMN supplier_trn VARCHAR(32) NULL AFTER supplier_name,
    ADD COLUMN supplier_invoice_number VARCHAR(100) NULL AFTER supplier_trn,
    ADD COLUMN expense_net_amount DECIMAL(12,2) NULL AFTER supplier_invoice_number,
    ADD COLUMN vat_rate DECIMAL(5,2) NULL AFTER expense_net_amount,
    ADD COLUMN vat_amount DECIMAL(12,2) NULL AFTER vat_rate,
    ADD COLUMN recoverable_vat_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER vat_amount,
    ADD COLUMN vat_treatment VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN' AFTER recoverable_vat_amount;
