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
/** Apply the same provenance, role and liveness expectations to any Access provider fixture. */
export async function accessConsumerContract(
  access: Pick<AccessApi, "authorize" | "getPrincipalSummary">,
  scope: RequestScope,
): Promise<void> {
  const live = await access.authorize(scope, "read");
  if (live.workspaceId !== scope.workspaceId || live.principalId !== scope.principalId)
    throw new Error("Access provider changed subject");
  try {
    await access.authorize({ ...scope });
  } catch {
    return;
  }
  throw new Error("Access provider accepted copied scope");
}
