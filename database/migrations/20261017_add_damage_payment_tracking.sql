-- Add explicit collection tracking for customer damage receivables.
-- Historical bills stay UNPAID until staff verifies collection.
ALTER TABLE damage_bills
    ADD COLUMN payment_status VARCHAR(10) NOT NULL DEFAULT 'UNPAID',
    ADD COLUMN paid_at DATETIME NULL;