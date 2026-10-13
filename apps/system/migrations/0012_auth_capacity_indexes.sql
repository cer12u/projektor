-- Additive auth ingress indexes. Production rollout is a separate approved step.
CREATE INDEX auth_challenges_expiry ON login_challenges(expires_at);
CREATE INDEX auth_limits_window ON login_limits(window_start);
CREATE INDEX auth_pending_nonces_expiry ON browser_exchange_nonces(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX auth_pending_tickets_expiry ON browser_exchange_tickets(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX auth_tickets_nonce ON browser_exchange_tickets(nonce_hash);
