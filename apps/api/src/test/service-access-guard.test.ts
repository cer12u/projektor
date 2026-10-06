import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAuthCachesForTests, verifyAccessJwtIdentity } from "../middleware/auth";

const audience = "a".repeat(64),
	issuer = "https://synthetic-team.example.invalid";
const target = {
	...env,
	CF_ACCESS_TEAM_DOMAIN: "synthetic-team.example.invalid",
	CF_ACCESS_AUDIENCE: audience,
};
let keys: CryptoKeyPair, attacker: CryptoKeyPair, jwk: JsonWebKey;
const b64 = (b: Uint8Array) =>
	btoa(String.fromCharCode(...b))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
const part = (v: unknown) => b64(new TextEncoder().encode(JSON.stringify(v)));
const base = () => ({
	type: "app",
	iss: issuer,
	aud: audience,
	exp: Math.floor(Date.now() / 1000) + 3600,
	sub: "",
	common_name: "synthetic-service.access",
});
async function token(claims: Record<string, unknown>, key?: CryptoKey, alg = "RS256") {
	const input = `${part({ alg })}.${part(claims)}`;
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key ?? keys.privateKey,
		new TextEncoder().encode(input)
	);
	return `${input}.${b64(new Uint8Array(sig))}`;
}
beforeAll(async () => {
	const opts = {
		name: "RSASSA-PKCS1-v1_5",
		modulusLength: 2048,
		publicExponent: new Uint8Array([1, 0, 1]),
		hash: "SHA-256",
	};
	keys = (await crypto.subtle.generateKey(opts, true, ["sign", "verify"])) as CryptoKeyPair;
	attacker = (await crypto.subtle.generateKey(opts, true, ["sign", "verify"])) as CryptoKeyPair;
	jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
});
beforeEach(async () => {
	resetAuthCachesForTests();
	await env.KV.put("cf-access-certs", JSON.stringify([jwk]));
	vi.spyOn(globalThis, "fetch").mockImplementation(
		async () =>
			new Response(JSON.stringify({ keys: [jwk] }), {
				headers: { "Content-Type": "application/json" },
			})
	);
});
afterEach(() => vi.restoreAllMocks());
describe("verified Access identity for deployment guard", () => {
	it.each([audience, [audience]])("accepts signed service audience %j", async (aud) =>
		expect(await verifyAccessJwtIdentity(await token({ ...base(), aud }), target)).toEqual({
			kind: "service",
			commonName: "synthetic-service.access",
		})
	);
	it("classifies signed human", async () =>
		expect(
			await verifyAccessJwtIdentity(
				await token({ ...base(), email: "human@example.invalid", sub: "synthetic-user" }),
				target
			)
		).toEqual({ kind: "human" }));
	it.each([
		{ aud: "other" },
		{ iss: "https://other.invalid" },
		{ exp: 0 },
		{ exp: "later" },
		{ exp: Math.floor(Date.now() / 1000) },
		{ nbf: 9999999999 },
		{ nbf: "later" },
		{ iat: 9999999999 },
		{ type: "org" },
		{ common_name: "" },
		{ common_name: null },
		{ sub: "nonempty" },
		{ email: "" },
		{ email: null },
	])("rejects invalid %j", async (override) =>
		expect(
			await verifyAccessJwtIdentity(await token({ ...base(), ...override }), target)
		).toBeNull()
	);
	it("rejects forged signature", async () =>
		expect(
			await verifyAccessJwtIdentity(await token(base(), attacker.privateKey), target)
		).toBeNull());
	it("rejects alternate algorithm", async () =>
		expect(
			await verifyAccessJwtIdentity(await token(base(), keys.privateKey, "HS256"), target)
		).toBeNull());
	it.each(["", "bad", "a.b.c.extra"])("rejects malformed %j", async (jwt) =>
		expect(await verifyAccessJwtIdentity(jwt, target)).toBeNull()
	);
	it("fails unavailable if trusted keys unavailable", async () => {
		await env.KV.delete("cf-access-certs");
		vi.mocked(fetch).mockResolvedValue(new Response("unavailable", { status: 503 }));
		await expect(verifyAccessJwtIdentity(await token(base()), target)).rejects.toThrow();
	});
});
