import {
  type Call,
  type Clock,
  type IdGenerator,
  type ModuleStore,
  PlatformError,
  type Row,
} from "../../../platform/public";
import {
  type AuthenticatedPrincipal,
  type CommandResult,
  type EventType,
  type OAuthApi,
  type OAuthAuthorizationRequest,
  type OAuthConsent,
  OAuthError,
  type OAuthTokens,
  type RequestScope,
} from "../public";
import type { queries } from "../storage/queries";
import { type Identity, num, str } from "./identity";
import {
  bounded,
  challenge,
  oauthCheck,
  oauthObject,
  parseToken,
  randomSecret,
  redirectMatches,
  registration,
  scopes,
  secret,
} from "./oauth-rules";
import { deny, hash, identifier, inputObject, valid, version } from "./rules";

type Name = keyof typeof queries;
type Statement = Call<Name>;
export interface OAuthConfig {
  readonly issuer: string;
  readonly resource: string;
}
interface Dependencies {
  readonly store: ModuleStore<"access", Name>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly config?: OAuthConfig;
  readonly interactivePrincipal: (principal: AuthenticatedPrincipal) => Promise<Identity>;
  readonly interactiveScope: (
    scope: RequestScope,
    permission: "read" | "write",
  ) => Promise<RequestScope>;
  readonly manager: (scope: RequestScope) => Promise<RequestScope>;
  readonly replay: (
    w: string,
    p: string,
    op: string,
    fp: string,
  ) => Promise<CommandResult | undefined>;
  readonly commit: (
    w: string,
    p: string,
    op: string,
    fp: string,
    output: CommandResult,
    type: EventType,
    calls: readonly Statement[],
  ) => Promise<CommandResult>;
}
interface ConsentState {
  readonly principalId: string;
  readonly request: OAuthAuthorizationRequest;
  readonly scope: string;
  readonly expiresAt: number;
}
export function createOAuth(deps: Dependencies): {
  api: OAuthApi;
  authenticate: (bearer: string, resource: string) => Promise<Identity>;
  live: (p: Identity) => Promise<void>;
} {
  const { store, clock, ids } = deps;
  const config = deps.config ? { ...deps.config } : undefined;
  if (config) {
    const issuer = new URL(config.issuer);
    const resource = new URL(config.resource);
    valid(issuer.protocol === "https:" && issuer.origin === config.issuer);
    valid(
      resource.protocol === "https:" &&
        !/[?#\\\s]/.test(config.resource) &&
        !resource.username &&
        !resource.password &&
        !resource.hash &&
        !resource.search,
    );
  }
  function configured(): OAuthConfig {
    if (!config) throw new OAuthError("temporarily_unavailable");
    return config;
  }
  const one = async (name: Name, values: Statement["values"]): Promise<Row | undefined> =>
    (await store.run(name, values)).rows[0];
  const consents = new WeakMap<OAuthConsent, ConsentState>();
  async function client(id: string): Promise<Row> {
    configured();
    oauthCheck(bounded(id, 128), "invalid_client");
    const row = await one("oauthClient", [id]);
    oauthCheck(!!row, "invalid_client");
    return row;
  }
  function target(resource: string): void {
    oauthCheck(resource === configured().resource, "invalid_target");
  }
  async function active(w: string, row: Row): Promise<void> {
    const [member, binding] = await Promise.all([
      one("admission", [w, str(row, "principal_id")]),
      one("oauthWorkspaceClient", [w, str(row, "client_id")]),
    ]);
    oauthCheck(
      !!member && member.version === row.membership_version && binding?.revoked === 0,
      "invalid_grant",
    );
    oauthCheck(row.resource === configured().resource, "invalid_grant");
    oauthCheck(
      row.expires_at !== undefined && num(row, "expires_at") > clock.now(),
      "invalid_grant",
    );
  }
  async function family(w: string, id: string): Promise<Row> {
    const row = await one("oauthFamily", [w, id]);
    oauthCheck(!!row && row.revoked === 0, "invalid_grant");
    await active(w, row);
    return row;
  }
  function familyEvent(w: string, id: string, type: EventType): Statement {
    return { name: "oauthFamilyEvent", values: [w, w, ids.next(), type, clock.now(), w, id] };
  }
  async function revoke(w: string, id: string): Promise<void> {
    await store.batch([
      { name: "oauthRevokeFamily", values: [w, id] },
      familyEvent(w, id, "OAuthFamilyRevoked"),
    ]);
  }
  function guard(w: string, id: string): Statement {
    return { name: "guard", values: [w, id] };
  }
  function clear(w: string, id: string): Statement {
    return { name: "clearGuard", values: [w, id] };
  }
  async function tokens(
    w: string,
    id: string,
    scope: string,
    end: number,
    refresh: boolean,
  ): Promise<{ result: OAuthTokens; calls: Statement[] }> {
    const access = `pa1.${w}.${randomSecret()}`;
    const renewal = refresh ? `pr1.${w}.${randomSecret()}` : undefined;
    const lifetime = Math.min(300, end - clock.now());
    const calls: Statement[] = [
      {
        name: "oauthIssueToken",
        values: [w, await hash(access), id, "access", scope, clock.now() + lifetime],
      },
    ];
    if (renewal)
      calls.push({
        name: "oauthIssueToken",
        values: [w, await hash(renewal), id, "refresh", scope, Math.min(end, clock.now() + 604800)],
      });
    return {
      result: {
        access_token: access,
        token_type: "Bearer",
        expires_in: lifetime,
        scope,
        ...(renewal ? { refresh_token: renewal } : {}),
      },
      calls,
    };
  }
  async function authenticate(bearer: string, resource: string): Promise<Identity> {
    try {
      target(resource);
      const parsed = parseToken(bearer, "pa1");
      if (!parsed) deny();
      const tokenHash = await hash(bearer);
      const t = await one("oauthToken", [parsed.workspace, tokenHash]);
      if (t?.kind !== "access" || num(t, "expires_at") <= clock.now()) deny();
      const f = await family(parsed.workspace, str(t, "family_id"));
      const p = await one("principal", [str(f, "principal_id")]);
      if (p?.kind !== "human") deny();
      return {
        id: str(p, "id"),
        kind: "human",
        issuer: str(p, "issuer"),
        subject: str(p, "subject"),
        expiresAt: num(t, "expires_at"),
        workspaceId: parsed.workspace,
        clientId: str(f, "client_id"),
        tokenHash,
        oauthScope: t.scope === "read write" && f.scope === "read write" ? "write" : "read",
      };
    } catch (error) {
      if (error instanceof OAuthError) deny();
      throw error;
    }
  }
  const api: OAuthApi = {
    getAuthorizationServerMetadata() {
      const { issuer } = configured();
      return {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["read", "write"],
        authorization_response_iss_parameter_supported: true,
      };
    },
    getProtectedResourceMetadata() {
      const { issuer, resource } = configured();
      return {
        resource,
        authorization_servers: [issuer],
        scopes_supported: ["read"],
        bearer_methods_supported: ["header"],
      };
    },
    async registerOAuthClient(input) {
      configured();
      const metadata = registration(input);
      const id = randomSecret();
      const now = clock.now();
      const result = await store.run("oauthRegister", [
        id,
        metadata.client_name,
        JSON.stringify(metadata.redirect_uris),
        metadata.scope,
        metadata.grant_types.includes("refresh_token") ? 1 : 0,
        now,
        now - 3600,
      ]);
      oauthCheck(result.changes === 1, "temporarily_unavailable");
      return {
        ...metadata,
        client_id: id,
        client_id_issued_at: now,
        token_endpoint_auth_method: "none",
        response_types: ["code"],
      };
    },
    async getOAuthConsent(principal, input) {
      const p = await deps.interactivePrincipal(principal);
      oauthObject(input);
      const c = await client(input.client_id);
      const redirects: unknown = JSON.parse(str(c, "redirect_uris"));
      oauthCheck(
        Array.isArray(redirects) &&
          redirects.some(
            (uri: unknown) => typeof uri === "string" && redirectMatches(uri, input.redirect_uri),
          ),
        "invalid_redirect_uri",
      );
      try {
        oauthCheck(input.response_type === "code", "unsupported_response_type");
        oauthCheck(
          input.code_challenge_method === "S256" &&
            typeof input.code_challenge === "string" &&
            /^[A-Za-z0-9_-]{43}$/.test(input.code_challenge),
        );
        target(input.resource);
        const scope = scopes(input.scope);
        oauthCheck(scope === "read" || c.scope === "read write", "invalid_scope");
        oauthCheck(
          input.state === undefined ||
            (typeof input.state === "string" && input.state.length <= 2048),
        );
        const consent = Object.freeze({
          clientId: input.client_id,
          clientName: str(c, "name"),
          redirectUri: input.redirect_uri,
          resource: input.resource,
          scope,
        }) as OAuthConsent;
        consents.set(consent, {
          principalId: p.id,
          request: { ...input },
          scope,
          expiresAt: Math.min(p.expiresAt, clock.now() + 600),
        });
        return consent;
      } catch (error) {
        if (error instanceof OAuthError) {
          throw new OAuthError(error.code, {
            redirect_uri: input.redirect_uri,
            iss: configured().issuer,
            ...(typeof input.state === "string" && input.state.length <= 2048
              ? { state: input.state }
              : {}),
          });
        }
        throw error;
      }
    },
    async approveOAuthConsent(scope, consent, input) {
      const state = consents.get(consent);
      oauthCheck(!!state && state.expiresAt > clock.now(), "access_denied");
      const s = await deps.interactiveScope(scope, state.scope === "read write" ? "write" : "read");
      oauthCheck(state.principalId === s.principalId, "access_denied");
      inputObject(input);
      identifier(input.operationId);
      oauthCheck(secret(input.codeSecret));
      const request = state.request;
      const raw = `pc1.${s.workspaceId}.${input.codeSecret}`;
      const codeHash = await hash(raw);
      const fp = await hash(JSON.stringify(["oauthConsent", request, state.scope, codeHash]));
      const saved = await deps.replay(s.workspaceId, s.principalId, input.operationId, fp);
      if (!saved) {
        const m = await one("admission", [s.workspaceId, s.principalId]);
        if (!m) deny();
        await deps.commit(
          s.workspaceId,
          s.principalId,
          input.operationId,
          fp,
          { id: codeHash, version: 1 },
          "OAuthConsentGranted",
          [
            { name: "oauthBindClient", values: [s.workspaceId, request.client_id] },
            {
              name: "oauthIssueCode",
              values: [
                s.workspaceId,
                codeHash,
                request.client_id,
                s.principalId,
                num(m, "version"),
                request.redirect_uri,
                request.code_challenge,
                request.resource,
                state.scope,
                clock.now() + 120,
                s.workspaceId,
                request.client_id,
              ],
            },
          ],
        );
      }
      const c = await one("oauthCode", [s.workspaceId, codeHash]);
      oauthCheck(!!c && c.used === 0, "invalid_grant");
      await active(s.workspaceId, c);
      return {
        redirect_uri: request.redirect_uri,
        code: raw,
        ...(request.state === undefined ? {} : { state: request.state }),
        iss: configured().issuer,
      };
    },
    async exchangeOAuthToken(input) {
      oauthObject(input);
      const c = await client(input.client_id);
      target(input.resource);
      oauthCheck(
        input.grant_type === "authorization_code" || input.grant_type === "refresh_token",
        "unsupported_grant_type",
      );
      const isCode = input.grant_type === "authorization_code";
      const raw = isCode ? input.code : input.refresh_token;
      const parsed = parseToken(raw, isCode ? "pc1" : "pr1");
      oauthCheck(!!parsed, "invalid_grant");
      const w = parsed.workspace;
      const tokenHash = await hash(parsed.raw);
      const row = await one(isCode ? "oauthCode" : "oauthToken", [w, tokenHash]);
      oauthCheck(!!row, "invalid_grant");
      let f: Row;
      let id: string;
      let scope: string;
      let end: number;
      const calls: Statement[] = [];
      const guardId = ids.next();
      if (input.grant_type === "authorization_code") {
        oauthCheck(
          row.client_id === input.client_id &&
            row.redirect_uri === input.redirect_uri &&
            row.challenge === (await challenge(input.code_verifier)),
          "invalid_grant",
        );
        id = tokenHash;
        if (row.used === 1) {
          await revoke(w, id);
          throw new OAuthError("invalid_grant");
        }
        await active(w, row);
        scope = str(row, "scope");
        end = clock.now() + 2592000;
        f = row;
        calls.push(
          { name: "oauthConsumeCode", values: [w, tokenHash, clock.now()] },
          guard(w, guardId),
          {
            name: "oauthCreateFamily",
            values: [
              w,
              id,
              input.client_id,
              str(row, "principal_id"),
              num(row, "membership_version"),
              input.resource,
              scope,
              end,
            ],
          },
          familyEvent(w, id, "OAuthTokenIssued"),
        );
      } else {
        oauthCheck(row.kind === "refresh" && c.refresh_allowed === 1, "invalid_grant");
        id = str(row, "family_id");
        f = (await one("oauthFamily", [w, id])) ?? {};
        oauthCheck(
          f.client_id === input.client_id && f.resource === input.resource,
          "invalid_grant",
        );
        // A used token remains a tombstone even after expiry; never grant a grace replay.
        if (row.used === 1) {
          await revoke(w, id);
          throw new OAuthError("invalid_grant");
        }
        oauthCheck(num(row, "expires_at") > clock.now(), "invalid_grant");
        f = await family(w, id);
        scope = input.scope === undefined ? str(f, "scope") : scopes(input.scope);
        oauthCheck(
          scope === "read" || (row.scope === "read write" && f.scope === "read write"),
          "invalid_scope",
        );
        end = num(f, "expires_at");
        calls.push(
          { name: "oauthConsumeRefresh", values: [w, tokenHash, clock.now()] },
          guard(w, guardId),
          { name: "oauthAdvanceFamily", values: [scope, w, id, num(f, "version")] },
          guard(w, `${guardId}_family`),
          {
            name: "event",
            values: [
              w,
              w,
              ids.next(),
              id,
              num(f, "version") + 1,
              "OAuthTokenRotated",
              clock.now(),
              str(f, "principal_id"),
            ],
          },
          clear(w, `${guardId}_family`),
        );
      }
      const issued = await tokens(w, id, scope, end, c.refresh_allowed === 1);
      try {
        await store.batch([...calls, ...issued.calls, clear(w, guardId)]);
      } catch (error) {
        // Concurrent replay/lost response: no plaintext recovery; retire committed family.
        const latest = await one(isCode ? "oauthCode" : "oauthToken", [w, tokenHash]);
        if (latest?.used === 1) {
          await revoke(w, id);
          throw new OAuthError("invalid_grant");
        }
        if (error instanceof Error && /constraint failed/i.test(error.message))
          throw new OAuthError("invalid_grant");
        throw new OAuthError("temporarily_unavailable");
      }
      return issued.result;
    },
    async revokeOAuthToken(input) {
      oauthObject(input);
      await client(input.client_id);
      oauthCheck(bounded(input.token, 1024));
      // RFC 7009: hints are advisory, unknown/foreign/invalid tokens return success.
      const parsed = parseToken(input.token, "pa1") ?? parseToken(input.token, "pr1");
      if (!parsed) return;
      const t = await one("oauthToken", [parsed.workspace, await hash(parsed.raw)]);
      if (!t) return;
      const f = await one("oauthFamily", [parsed.workspace, str(t, "family_id")]);
      if (f?.client_id === input.client_id) await revoke(parsed.workspace, str(t, "family_id"));
    },
    async getOAuthClient(scope, clientId) {
      const s = await deps.manager(scope);
      identifier(clientId);
      const row = await one("oauthWorkspaceClient", [s.workspaceId, clientId]);
      if (!row) throw new PlatformError("not_found", "Client not found");
      return { id: clientId, version: num(row, "version"), revoked: row.revoked === 1 };
    },
    async revokeOAuthClient(scope, input) {
      const s = await deps.manager(scope);
      inputObject(input);
      identifier(input.clientId);
      identifier(input.operationId);
      version(input.expectedVersion);
      const fp = await hash(
        JSON.stringify(["oauthRevokeClient", input.clientId, input.expectedVersion]),
      );
      const saved = await deps.replay(s.workspaceId, s.principalId, input.operationId, fp);
      if (saved) return saved;
      if (!(await one("oauthWorkspaceClient", [s.workspaceId, input.clientId])))
        throw new PlatformError("not_found", "Client not found");
      return deps.commit(
        s.workspaceId,
        s.principalId,
        input.operationId,
        fp,
        { id: input.clientId, version: input.expectedVersion + 1 },
        "OAuthClientRevoked",
        [
          {
            name: "oauthRevokeClient",
            values: [s.workspaceId, input.clientId, input.expectedVersion],
          },
        ],
      );
    },
  };
  return {
    api,
    authenticate,
    async live(p) {
      if (!p.workspaceId || !p.tokenHash) deny();
      const t = await one("oauthToken", [p.workspaceId, p.tokenHash]);
      if (t?.kind !== "access" || num(t, "expires_at") <= clock.now()) deny();
      try {
        const f = await family(p.workspaceId, str(t, "family_id"));
        if (
          f.principal_id !== p.id ||
          f.client_id !== p.clientId ||
          (p.oauthScope === "write" && f.scope !== "read write")
        )
          deny();
      } catch (error) {
        if (error instanceof OAuthError) deny();
        throw error;
      }
    },
  };
}
