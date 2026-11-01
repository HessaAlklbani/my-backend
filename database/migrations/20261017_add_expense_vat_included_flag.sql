-- Explicitly record whether a supplier receipt's entered amount includes VAT.
-- Keep legacy records NULL until a staff member reviews the supporting document.
ALTER TABLE expenses
    ADD COLUMN amount_includes_vat TINYINT(1) NULL DEFAULT NULL AFTER vat_treatment;