-- Apply the requested public USD selling rates to every SMM provider group.
-- This intentionally replaces any older global smm_usd_rates setting while
-- preserving all service-specific prices stored in smm_pricing.
INSERT INTO settings (`key`, `value`)
VALUES (
  'smm_usd_rates',
  '{"default":{"XAF":800,"XOF":850,"GMD":73,"CDF":7000,"GNF":15000},"peakerr":{"XAF":800,"XOF":850,"GMD":80,"CDF":7000,"GNF":15000}}'
)
ON DUPLICATE KEY UPDATE `value` = VALUES(`value`);