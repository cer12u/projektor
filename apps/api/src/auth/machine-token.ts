/** Immutable server-recorded provenance, never a token prefix or a caller-supplied header. */
export function isMachineToken(
	row: Readonly<{
		user_id: string | null;
		issued_by_user_id: string | null;
	}>
): boolean {
	return row.issued_by_user_id !== null && row.issued_by_user_id !== row.user_id;
}

/** Run during authentication, including auth-only routes that skip workspace middleware. */
export function machineTokenIsUsable(
	row: Readonly<{
		user_id: string | null;
		workspace_id: string | null;
		member_role: string | null;
		expires_at: number | null;
	}>,
	scopes: readonly string[],
	now: number
): boolean {
	return (
		!!row.user_id &&
		!!row.workspace_id &&
		row.member_role === "member" &&
		row.expires_at !== null &&
		row.expires_at > now &&
		scopes.length > 0 &&
		scopes.every((scope) => scope === "read" || scope === "write")
	);
}
