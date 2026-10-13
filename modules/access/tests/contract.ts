import type { AccessApi, AuthenticatedPrincipal, RequestScope } from "../public";
/** Provider contract for future consumer fakes; no storage details or privileged factory. */
export async function membershipContract(
  api: AccessApi,
  principal: AuthenticatedPrincipal,
  workspaceId: string,
): Promise<RequestScope> {
  const scope = await api.requireMembership(principal, workspaceId, "contract");
  const live = await api.authorize(scope, "read");
  if (
    scope.workspaceId !== workspaceId ||
    live.principalId !== scope.principalId ||
    live.workspaceId !== workspaceId
  )
    throw new Error("Access provider contract mismatch");
  try {
    await api.authorize({ ...scope });
  } catch {
    return live;
  }
  throw new Error("Access provider accepted forged scope");
}
