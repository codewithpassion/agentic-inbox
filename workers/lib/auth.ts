// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Principal resolution for every request.
 *
 * A request is authenticated by, in order:
 *  1. `Authorization: Bearer aik_...` — hashed and verified against the
 *     ApiKeyStore Durable Object. Runs in dev too so the CLI can be tested
 *     against localhost.
 *  2. The Cloudflare Access JWT from the `cf-access-jwt-assertion` header,
 *     falling back to the `CF_Authorization` cookie. The cookie fallback
 *     keeps the browser working once a path-scoped Access Bypass policy
 *     stops injecting the header on /api/v1/*.
 *  3. In local development, an unauthenticated "dev" principal.
 *
 * Authorization rules layered on top of this middleware live where they are
 * enforced (e.g. API-key management routes, mailbox scoping).
 */
import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { hashApiKey } from "../apiKeys/store";
import type { Env } from "../types";

export type Principal =
	| { kind: "access"; email: string }
	| { kind: "api_key"; keyId: string; name: string; mailboxes: string[] | null }
	| { kind: "dev" };

export type AppContext = {
	Bindings: Env;
	Variables: { principal: Principal };
};

export type AuthFailure = "invalid_key" | "invalid_access" | "missing" | "misconfigured";

export type AuthResult =
	| { ok: true; principal: Principal }
	| { ok: false; reason: AuthFailure };

const AUTH_ERRORS: Record<AuthFailure, { message: string; status: number }> = {
	invalid_key: { message: "Invalid or expired API key", status: 401 },
	invalid_access: { message: "Invalid or expired Access token", status: 401 },
	missing: { message: "Missing required CF Access JWT", status: 401 },
	misconfigured: {
		message: "Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
		status: 500,
	},
};

/** Messages kept identical to the pre-API-key middleware for the SPA paths. */
const ACCESS_TEXT_ERRORS: Record<AuthFailure, { message: string; status: number }> = {
	invalid_key: { message: "Invalid or expired API key", status: 403 },
	invalid_access: { message: "Invalid or expired Access token", status: 403 },
	missing: { message: "Missing required CF Access JWT", status: 403 },
	misconfigured: {
		message: "Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
		status: 500,
	},
};

function isDev(): boolean {
	return import.meta.env.DEV === true;
}

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

function readCookie(cookieHeader: string, name: string): string | null {
	for (const part of cookieHeader.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return null;
}

function getAccessJwt(request: Request): string | null {
	return (
		request.headers.get("cf-access-jwt-assertion") ??
		readCookie(request.headers.get("Cookie") ?? "", "CF_Authorization")
	);
}

async function verifyAccessJwt(request: Request, env: Env): Promise<string> {
	const token = getAccessJwt(request);
	if (!token) throw new Error("missing token");
	const { issuer, certsUrl } = getAccessUrls(env.TEAM_DOMAIN);
	const JWKS = createRemoteJWKSet(certsUrl);
	const { payload } = await jwtVerify(token, JWKS, {
		issuer,
		audience: env.POLICY_AUD,
	});
	return typeof payload.email === "string" ? payload.email : "";
}

/**
 * Resolve the principal for a request. `isDev` is injectable so tests can
 * exercise the production branches; it defaults to the bundler's DEV flag.
 */
export async function resolvePrincipal(
	request: Request,
	env: Env,
	options?: { isDev?: boolean },
): Promise<AuthResult> {
	// 1. API key. The aik_ prefix lets us skip Access-JWT handling entirely.
	const authorization = request.headers.get("Authorization");
	if (authorization?.startsWith(`Bearer aik_`)) {
		const stub = env.API_KEYS.get(env.API_KEYS.idFromName("global"));
		const key = authorization.slice("Bearer ".length);
		const record = await stub.verify(await hashApiKey(key));
		if (!record) return { ok: false, reason: "invalid_key" };
		return {
			ok: true,
			principal: {
				kind: "api_key",
				keyId: record.id,
				name: record.name,
				mailboxes: record.mailboxes,
			},
		};
	}

	// 2. Development bypass: every route is open on localhost without a key.
	if (options?.isDev ?? isDev()) {
		return { ok: true, principal: { kind: "dev" } };
	}

	// Fail closed in production if Access is not configured.
	if (!env.POLICY_AUD || !env.TEAM_DOMAIN) {
		return { ok: false, reason: "misconfigured" };
	}

	// 3. Cloudflare Access JWT, header first, then the CF_Authorization cookie.
	if (!getAccessJwt(request)) {
		return { ok: false, reason: "missing" };
	}

	try {
		const email = await verifyAccessJwt(request, env);
		return { ok: true, principal: { kind: "access", email } };
	} catch {
		return { ok: false, reason: "invalid_access" };
	}
}

/**
 * Mount on "*" in workers/app.ts before any route handlers. Stores the
 * resolved principal on the Hono context (`c.var.principal`).
 */
export const authMiddleware = createMiddleware<AppContext>(async (c, next) => {
	const result = await resolvePrincipal(c.req.raw, c.env);
	if (!result.ok) {
		if (new URL(c.req.raw.url).pathname.startsWith("/api/")) {
			const { message, status } = AUTH_ERRORS[result.reason];
			return c.json({ error: { code: "unauthorized", message } }, status as 401 | 500);
		}
		const { message, status } = ACCESS_TEXT_ERRORS[result.reason];
		return c.text(message, status as 403 | 500);
	}

	// The AI agent WebSocket is not part of the public API: Access identities only.
	if (
		result.principal.kind === "api_key" &&
		new URL(c.req.raw.url).pathname.startsWith("/agents/")
	) {
		return c.json(
			{ error: { code: "forbidden", message: "API keys cannot connect to the AI agent" } },
			403,
		);
	}

	c.set("principal", result.principal);
	return next();
});

/**
 * Guard for endpoints that an API key principal must never reach, currently
 * only the API key management routes. Mount after authMiddleware.
 */
export const requireAccessPrincipal = createMiddleware<AppContext>(async (c, next) => {
	const principal = c.get("principal");
	if (principal.kind === "api_key") {
		return c.json(
			{ error: { code: "forbidden", message: "API keys cannot manage API keys" } },
			403,
		);
	}
	return next();
});
