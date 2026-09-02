// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { SignJWT, generateKeyPair, importJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "../apiKeys/store";
import { resolvePrincipal } from "../lib/auth";
import type { Env } from "../types";
import { fetchApi, fetchThroughAuthGate, getApiKeyStore } from "./helpers";

const bindings = env as unknown as Record<string, string>;
const TEAM_DOMAIN = bindings.TEST_JWKS_ORIGIN;
const POLICY_AUD = "test-audience";

/** Env with Access configured, as it looks in production. */
const prodEnv = { ...env, POLICY_AUD, TEAM_DOMAIN } as unknown as Env;

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

	it("fails closed without Access config in production", async () => {
		const result = await resolvePrincipal(new Request("https://x/"), env as unknown as Env, {
			isDev: false,
		});
		expect(result).toEqual({ ok: false, reason: "misconfigured" });
	});
});

describe("resolvePrincipal: Access JWT branch", () => {
	let privateKey: CryptoKey;

	beforeAll(async () => {
		privateKey = (await importJWK(JSON.parse(bindings.TEST_PRIVATE_JWK), "RS256")) as CryptoKey;
	});

	async function signedToken() {
		return new SignJWT({ email: "human@example.com" })
			.setProtectedHeader({ alg: "RS256", kid: "test-key" })
			.setIssuer(TEAM_DOMAIN)
			.setAudience(POLICY_AUD)
			.setExpirationTime("5m")
			.sign(privateKey);
	}

	it("resolves an Access JWT from the cf-access-jwt-assertion header", async () => {
		const result = await resolvePrincipal(
			new Request("https://x/", { headers: { "cf-access-jwt-assertion": await signedToken() } }),
			prodEnv,
			{ isDev: false },
		);
		expect(result).toEqual({ ok: true, principal: { kind: "access", email: "human@example.com" } });
	});

	it("falls back to the CF_Authorization cookie", async () => {
		const result = await resolvePrincipal(
			new Request("https://x/", {
				headers: { Cookie: `CF_Authorization=${await signedToken()}; other=1` },
			}),
			prodEnv,
			{ isDev: false },
		);
		expect(result).toEqual({ ok: true, principal: { kind: "access", email: "human@example.com" } });
	});

	it("rejects a JWT signed by the wrong key", async () => {
		const other = await generateKeyPair("RS256", { extractable: true });
		const token = await new SignJWT({ email: "attacker@example.com" })
			.setProtectedHeader({ alg: "RS256", kid: "test-key" })
			.setIssuer(TEAM_DOMAIN)
			.setAudience(POLICY_AUD)
			.setExpirationTime("5m")
			.sign(other.privateKey);
		const result = await resolvePrincipal(
			new Request("https://x/", { headers: { "cf-access-jwt-assertion": token } }),
			prodEnv,
			{ isDev: false },
		);
		expect(result).toEqual({ ok: false, reason: "invalid_access" });
	});

	it("rejects a JWT with the wrong audience", async () => {
		const token = await new SignJWT({ email: "human@example.com" })
			.setProtectedHeader({ alg: "RS256", kid: "test-key" })
			.setIssuer(TEAM_DOMAIN)
			.setAudience("other-audience")
			.setExpirationTime("5m")
			.sign(privateKey);
		const result = await resolvePrincipal(
			new Request("https://x/", { headers: { "cf-access-jwt-assertion": token } }),
			prodEnv,
			{ isDev: false },
		);
		expect(result).toEqual({ ok: false, reason: "invalid_access" });
	});

	it("reports missing credentials when no token and not dev", async () => {
		const result = await resolvePrincipal(new Request("https://x/"), prodEnv, { isDev: false });
		expect(result).toEqual({ ok: false, reason: "missing" });
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
