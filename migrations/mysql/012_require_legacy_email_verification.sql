-- Earlier releases of migration 010 grandfathered accounts without an OTP
-- record. Reset those timestamps, including for current administrators:
-- their exemption follows their current role, so demotion must require OTP.
-- Accounts that completed OTP verification have a record and keep their status.
UPDATE users u
LEFT JOIN signup_email_verifications sev ON sev.user_id = u.id
SET u.email_verified_at = NULL
WHERE sev.user_id IS NULL
  AND u.email_verified_at IS NOT NULL;