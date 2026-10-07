-- Explicit issuance provenance. NULL preserves every existing token's subject/policy.
-- Kept as an immutable identifier, not an FK: issuer deletion must not erase provenance
-- or turn a delegated machine credential back into an unrestricted personal token.
ALTER TABLE api_tokens ADD COLUMN issued_by_user_id TEXT;
