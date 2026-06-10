-- Password recovery via 6-digit code.
-- The code-based flow (/auth/forgot-password + /auth/reset-password) stores a
-- short-lived numeric code on the user row and clears it once the password is reset.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code VARCHAR(6);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_expires_at TIMESTAMPTZ;
