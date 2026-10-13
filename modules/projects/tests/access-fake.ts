import { PlatformError } from "../../../platform/public";
import type {
  AccessApi,
  Permission,
  PrincipalSummary,
  RequestScope,
  Role,
} from "../../access/public";

interface Actor {
  readonly id: string;
  readonly workspaceId: string;
  readonly role: Role;
  readonly kind: "human" | "machine";
  readonly clientId?: string;
  readonly scope: Permission;
  active: boolean;
}
/** Consumer fake for precisely the Access public methods Projects uses. */
export function fakeAccess(): {
  readonly access: Pick<AccessApi, "authorize" | "getPrincipalSummary" | "getMembership">;
  issue(actor: Actor): RequestScope;
  revoke(scope: RequestScope): void;
} {
  const issued = new WeakMap<RequestScope, Actor>();
  const actors = new Map<string, Actor>();
  function issue(actor: Actor): RequestScope {
    actors.set(`${actor.workspaceId}:${actor.id}`, actor);
    const scope = Object.freeze({
      workspaceId: actor.workspaceId,
      principalId: actor.id,
      role: actor.role,
      kind: actor.kind,
      requestId: "fake",
      ...(actor.clientId ? { clientId: actor.clientId } : {}),
    }) as RequestScope;
    issued.set(scope, actor);
    return scope;
  }
  async function authorize(
    scope: RequestScope,
    permission: Permission = "read",
  ): Promise<RequestScope> {
    const actor = issued.get(scope);
    if (
      !actor ||
      !actor.active ||
      (permission === "write" && (actor.role === "viewer" || actor.scope !== "write"))
    )
      throw new PlatformError("forbidden", "Access denied");
    return issue(actor);
  }
  async function getPrincipalSummary(
    scope: RequestScope,
    principalId: string,
  ): Promise<PrincipalSummary> {
    const live = await authorize(scope);
    const actor = actors.get(`${live.workspaceId}:${principalId}`);
    if (!actor || !actor.active) throw new PlatformError("not_found", "Principal not found");
    return {
      id: actor.id,
      kind: actor.kind,
      issuer: actor.kind === "machine" ? "machine:fake" : "fake",
      subject: actor.id,
    };
  }
  return {
    access: {
      authorize,
      getPrincipalSummary,
      async getMembership(scope, principalId) {
        const live = await authorize(scope);
        const member = actors.get(`${live.workspaceId}:${principalId}`);
        if (!member) throw new PlatformError("not_found", "Membership not found");
        return { id: principalId, role: member.role, version: 1, active: member.active };
      },
    },
    issue,
    revoke(scope) {
      const actor = issued.get(scope);
      if (actor) actor.active = false;
    },
  };
}
/** Run against both the real Access provider and this consumer fake. */
export async function accessConsumerContract(
  access: Pick<AccessApi, "authorize" | "getPrincipalSummary" | "getMembership">,
  scope: RequestScope,
): Promise<void> {
  const live = await access.authorize(scope, "read");
  if (live.workspaceId !== scope.workspaceId || live.principalId !== scope.principalId)
    throw new Error("Access provider changed subject");
  const summary = await access.getPrincipalSummary(scope, scope.principalId);
  const membership = await access.getMembership(scope, scope.principalId);
  if (summary.id !== scope.principalId || summary.kind !== live.kind)
    throw new Error("Access provider returned another principal");
  if (membership.id !== scope.principalId || !membership.active || membership.role !== live.role)
    throw new Error("Access provider returned inconsistent membership");
  async function rejectsCode(action: Promise<unknown>, expected: string): Promise<void> {
    try {
      await action;
    } catch (error) {
      if (error instanceof PlatformError && error.code === expected) return;
      throw error;
    }
    throw new Error(`Access provider failed to reject with ${expected}`);
  }
  await rejectsCode(access.authorize({ ...scope }), "forbidden");
  await rejectsCode(access.getPrincipalSummary({ ...scope }, scope.principalId), "forbidden");
  await rejectsCode(access.getMembership({ ...scope }, scope.principalId), "forbidden");
  await rejectsCode(access.getPrincipalSummary(scope, "contract-absent"), "not_found");
  await rejectsCode(access.getMembership(scope, "contract-absent"), "not_found");
}
