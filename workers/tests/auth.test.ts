// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "../apiKeys/store";
import { canonicalRedirectUrl, resolvePrincipal } from "../lib/auth";
import type { Env } from "../types";
import { fetchApi, fetchThroughAuthGate, getApiKeyStore } from "./helpers";

const ISSUER = "https://clerk.example.com";
const ORIGIN = "https://mail.example.com";
const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });

/** Env with Clerk configured, as it looks in production. The JWT key avoids a JWKS fetch. */
const prodEnv = {
	...env,
	CLERK_PUBLISHABLE_KEY: `pk_live_${btoa("clerk.example.com$")}`,
	CLERK_SECRET_KEY: "sk_live_test",
	CLERK_SIGN_IN_URL: "https://accounts.example.com/sign-in",
	CLERK_JWT_KEY: await exportSPKI(publicKey),
	ALLOWED_EMAILS: "human@example.com,@team.example.com",
} as unknown as Env;

function sessionToken(email: string | null, azp = ORIGIN, key: CryptoKey = privateKey) {
	return new SignJWT({ ...(email ? { email } : {}), azp, sid: "sess_test" })
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.setIssuer(ISSUER)
		.setSubject("user_test")
		.setIssuedAt()
		.setNotBefore("-5s")
		.setExpirationTime("1m")
		.sign(key);
}

function sessionRequest(token: string) {
	return new Request(`${ORIGIN}/api/v1/config`, { headers: { Authorization: `Bearer ${token}` } });
}

const getStore = getApiKeyStore;

describe("resolvePrincipal: API key branch", () => {
	it("resolves a valid key to an api_key principal (also in production mode)", async () => {
		const key = generateApiKey();
		await getStore().create({
			name: "cli",
			keyHash: await hashApiKey(key),
			keyPrefix: key.slice(0, 12),
			mailboxes: ["a@example.com"],
		});
		const result = await resolvePrincipal(
			new Request("https://x/api/v1/mailboxes", {
				headers: { Authorization: `Bearer ${key}` },
			}),
			prodEnv,
			{ isDev: false },
		);
		expect(result).toEqual({
			ok: true,
			principal: {
				kind: "api_key",
				keyId: expect.any(String),
				name: "cli",
				mailboxes: ["a@example.com"],
				keyPrefix: key.slice(0, 12),
			},
		});
	});

	it("rejects an unknown key", async () => {
		const result = await resolvePrincipal(
			new Request("https://x/", { headers: { Authorization: `Bearer ${generateApiKey()}` } }),
			prodEnv,
			{ isDev: false },
		);
		expect(result).toEqual({ ok: false, reason: "invalid_key" });
	});

	it("rejects a revoked key", async () => {
		const key = generateApiKey();
		const record = await getStore().create({
			name: "revoked",
			keyHash: await hashApiKey(key),
			keyPrefix: key.slice(0, 12),
		});
		await getStore().revoke(record.id);
		const result = await resolvePrincipal(
			new Request("https://x/", { headers: { Authorization: `Bearer ${key}` } }),
			prodEnv,
			{ isDev: false },
		);
		expect(result).toEqual({ ok: false, reason: "invalid_key" });
	});
});

describe("resolvePrincipal: dev and misconfigured branches", () => {
	it("returns a dev principal in dev mode without credentials", async () => {
		const result = await resolvePrincipal(new Request("https://x/"), prodEnv, { isDev: true });
		expect(result).toEqual({ ok: true, principal: { kind: "dev" } });
	});

	it("fails closed without Clerk config in production", async () => {
		const result = await resolvePrincipal(new Request("https://x/"), env as unknown as Env, {
			isDev: false,
		});
		expect(result).toEqual({ ok: false, reason: "misconfigured" });
	});
});

describe("resolvePrincipal: Clerk session branch", () => {
	it("resolves an allowed address to a signed-in principal", async () => {
		const result = await resolvePrincipal(sessionRequest(await sessionToken("human@example.com")), prodEnv, { isDev: false });
		expect(result).toEqual({ ok: true, principal: { kind: "access", email: "human@example.com" } });
	});

	it("resolves an address on an allowed domain, ignoring case", async () => {
		const result = await resolvePrincipal(sessionRequest(await sessionToken("Anyone@Team.Example.com")), prodEnv, { isDev: false });
		expect(result).toEqual({ ok: true, principal: { kind: "access", email: "Anyone@Team.Example.com" } });
	});

	it("refuses a valid session whose email is not allowed", async () => {
		const result = await resolvePrincipal(sessionRequest(await sessionToken("stranger@example.com")), prodEnv, { isDev: false });
		expect(result).toEqual({ ok: false, reason: "not_allowed" });
	});

	it("refuses a subdomain of an allowed domain and a lookalike address", async () => {
		for (const email of ["a@sub.team.example.com", "a@team.example.com.evil.test", "human@example.com.evil.test"]) {
			const result = await resolvePrincipal(sessionRequest(await sessionToken(email)), prodEnv, { isDev: false });
			expect(result).toEqual({ ok: false, reason: "not_allowed" });
		}
	});

	it("refuses a valid session without an email claim", async () => {
		const result = await resolvePrincipal(sessionRequest(await sessionToken(null)), prodEnv, { isDev: false });
		expect(result).toEqual({ ok: false, reason: "not_allowed" });
	});

	it("refuses everyone when the allowlist is empty", async () => {
		const result = await resolvePrincipal(
			sessionRequest(await sessionToken("human@example.com")),
			{ ...prodEnv, ALLOWED_EMAILS: "" } as Env,
			{ isDev: false },
		);
		expect(result).toEqual({ ok: false, reason: "not_allowed" });
	});

	it("rejects a token signed by the wrong key", async () => {
		const other = await generateKeyPair("RS256", { extractable: true });
		const token = await sessionToken("human@example.com", ORIGIN, other.privateKey);
		const result = await resolvePrincipal(sessionRequest(token), prodEnv, { isDev: false });
		expect(result).toEqual({ ok: false, reason: "missing" });
	});

	it("rejects a token minted for another site on the same instance", async () => {
		const token = await sessionToken("human@example.com", "https://hei.dev");
		const result = await resolvePrincipal(sessionRequest(token), prodEnv, { isDev: false });
		expect(result).toEqual({ ok: false, reason: "missing" });
	});

	it("prefers a valid session over the dev principal", async () => {
		const result = await resolvePrincipal(sessionRequest(await sessionToken("human@example.com")), prodEnv, { isDev: true });
		expect(result).toEqual({ ok: true, principal: { kind: "access", email: "human@example.com" } });
	});

	it("reports missing credentials when no token and not dev", async () => {
		const result = await resolvePrincipal(new Request(`${ORIGIN}/api/v1/config`), prodEnv, { isDev: false });
		expect(result).toEqual({ ok: false, reason: "missing" });
	});
});

describe("canonicalRedirectUrl", () => {
	const OLD = "https://mail.old.example";
	const CANONICAL = "mail.example.com";

	it("sends a browser on another host to the same path on the canonical host", () => {
		expect(canonicalRedirectUrl(new Request(`${OLD}/mailbox/a?x=1`), CANONICAL)).toBe(`https://${CANONICAL}/mailbox/a?x=1`);
	});

	it("leaves the canonical host alone", () => {
		expect(canonicalRedirectUrl(new Request(`https://${CANONICAL}/`), CANONICAL)).toBeNull();
	});

	it("leaves the REST API, MCP, agents and API keys on the old host", () => {
		for (const path of ["/api/v1/config", "/mcp", "/mcp/x", "/agents/a"]) {
			expect(canonicalRedirectUrl(new Request(`${OLD}${path}`), CANONICAL)).toBeNull();
		}
		const withKey = new Request(`${OLD}/`, { headers: { Authorization: "Bearer aik_x" } });
		expect(canonicalRedirectUrl(withKey, CANONICAL)).toBeNull();
	});
});

describe("authMiddleware over the mounted API app", () => {
	it("lets dev principals through without credentials", async () => {
		const response = await fetchApi("/api/v1/config");
		expect(response.status).toBe(200);
	});

	it("returns 401 JSON for a bogus Bearer key on API paths", async () => {
		const response = await fetchApi("/api/v1/config", {
			headers: { Authorization: `Bearer ${generateApiKey()}` },
		});
		expect(response.status).toBe(401);
		const body = await response.json();
		expect(body).toEqual({
			error: { code: "unauthorized", message: expect.any(String) },
		});
	});

	it("returns 401 JSON for a key that is valid but expired", async () => {
		const key = generateApiKey();
		await getStore().create({
			name: "expired",
			keyHash: await hashApiKey(key),
			keyPrefix: key.slice(0, 12),
			expiresAt: new Date(Date.now() - 1_000).toISOString(),
		});
		const response = await fetchApi("/api/v1/config", {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(response.status).toBe(401);
	});

	it("accepts a valid key on API paths", async () => {
		const key = generateApiKey();
		await getStore().create({
			name: "valid",
			keyHash: await hashApiKey(key),
			keyPrefix: key.slice(0, 12),
		});
		const response = await fetchApi("/api/v1/config", {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(response.status).toBe(200);
	});

	it("rejects API keys on the agent WebSocket routes", async () => {
		const key = generateApiKey();
		await getStore().create({
			name: "valid",
			keyHash: await hashApiKey(key),
			keyPrefix: key.slice(0, 12),
		});
		const response = await fetchThroughAuthGate("/agents/some-agent", {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(response.status).toBe(403);
	});
});
