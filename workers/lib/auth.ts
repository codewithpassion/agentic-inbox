// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Principal resolution for every request.
 *
 * A request is authenticated by, in order:
 *  1. `Authorization: Bearer aik_...`: hashed and verified against the
 *     ApiKeyStore Durable Object. Runs in dev too so the CLI can be tested
 *     against localhost.
 *  2. A Clerk session (the `__session` cookie, or a session token in the
 *     Authorization header) whose email is on ALLOWED_EMAILS.
 *  3. In local development, an unauthenticated "dev" principal.
 *
 * Authorization rules layered on top of this middleware live where they are
 * enforced (e.g. API-key management routes, mailbox scoping).
 */
import { createMiddleware } from "hono/factory";
import { hashApiKey } from "../apiKeys/store";
import type { Env } from "../types";
import { authenticateClerk, isClerkConfigured, isEmailAllowed, signInRedirectUrl } from "./clerk";

export type Principal =
	/** A signed-in person. The name predates Clerk and is part of the CLI and OpenAPI contract. */
	| { kind: "access"; email: string }
	| {
			kind: "api_key";
			keyId: string;
			name: string;
			mailboxes: string[] | null;
			/** Display prefix (`aik_` + 8 chars) so clients can show which key is in use. */
			keyPrefix: string;
	  }
	| { kind: "dev" };

export type AppContext = {
	Bindings: Env;
	Variables: { principal: Principal };
};

export type AuthFailure = "invalid_key" | "not_allowed" | "missing" | "misconfigured";

export type AuthResult =
	| { ok: true; principal: Principal }
	| { ok: false; reason: "redirect"; response: Response }
	| { ok: false; reason: AuthFailure };

const AUTH_ERRORS: Record<AuthFailure, { message: string; status: 401 | 403 | 500 }> = {
	invalid_key: { message: "Invalid or expired API key", status: 401 },
	not_allowed: { message: "This account is not allowed to use this inbox", status: 403 },
	missing: { message: "Sign-in required", status: 401 },
	misconfigured: {
		message: "Clerk must be configured in production. Set CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY and CLERK_SIGN_IN_URL.",
		status: 500,
	},
};

function isDev(): boolean {
	return import.meta.env.DEV === true;
}

/** Paths that machines call: never redirected to a sign-in page or another host. */
function isMachinePath(pathname: string): boolean {
	return (
		pathname.startsWith("/api/") ||
		pathname.startsWith("/agents/") ||
		pathname === "/mcp" ||
		pathname.startsWith("/mcp/")
	);
}

function isApiKeyRequest(request: Request): boolean {
	return request.headers.get("Authorization")?.startsWith("Bearer aik_") === true;
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
	// 1. API key. The aik_ prefix lets us skip Clerk entirely.
	if (isApiKeyRequest(request)) {
		const stub = env.API_KEYS.get(env.API_KEYS.idFromName("global"));
		const key = (request.headers.get("Authorization") ?? "").slice("Bearer ".length);
		const record = await stub.verify(await hashApiKey(key));
		if (!record) return { ok: false, reason: "invalid_key" };
		return {
			ok: true,
			principal: {
				kind: "api_key",
				keyId: record.id,
				name: record.name,
				mailboxes: record.mailboxes,
				keyPrefix: record.key_prefix,
			},
		};
	}

	const dev = options?.isDev ?? isDev();

	// 2. Clerk session.
	if (isClerkConfigured(env)) {
		const clerk = await authenticateClerk(request, env);
		if (clerk.status === "redirect") return { ok: false, reason: "redirect", response: clerk.response };
		if (clerk.status === "signed-in") {
			if (!isEmailAllowed(clerk.email, env.ALLOWED_EMAILS)) return { ok: false, reason: "not_allowed" };
			return { ok: true, principal: { kind: "access", email: clerk.email } };
		}
	}

	// 3. Development bypass: every route is open on localhost without a key.
	if (dev) return { ok: true, principal: { kind: "dev" } };

	// Fail closed in production if Clerk is not configured.
	return { ok: false, reason: isClerkConfigured(env) ? "missing" : "misconfigured" };
}

/** The page a signed-in person sees when their email is not on ALLOWED_EMAILS. */
function notAllowedPage(): Response {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not allowed</title></head><body>
<p>${AUTH_ERRORS.not_allowed.message}.</p>
<form method="post" action="/auth/sign-out"><button type="submit">Sign out</button></form>
</body></html>`,
		{ status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } },
	);
}

/**
 * Mount on "*" in workers/app.ts before any route handlers. Stores the
 * resolved principal on the Hono context (`c.var.principal`).
 */
export const authMiddleware = createMiddleware<AppContext>(async (c, next) => {
	const result = await resolvePrincipal(c.req.raw, c.env);
	if (!result.ok) {
		if (result.reason === "redirect") return result.response;
		const url = new URL(c.req.raw.url);
		const { message, status } = AUTH_ERRORS[result.reason];
		if (url.pathname.startsWith("/api/")) {
			return c.json({ error: { code: "unauthorized", message } }, status);
		}
		if (!isMachinePath(url.pathname)) {
			if (result.reason === "missing" && c.req.method === "GET") {
				return c.redirect(signInRedirectUrl(c.env, url.toString()), 302);
			}
			if (result.reason === "not_allowed") return notAllowedPage();
		}
		return c.text(message, status);
	}

	// The AI agent WebSocket is not part of the public API: signed-in people only.
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
 * Guard for endpoints that an API key principal must never reach: the API key
 * management and forward rule routes. Mount after authMiddleware.
 */
export const requireAccessPrincipal = createMiddleware<AppContext>(async (c, next) => {
	const principal = c.get("principal");
	if (principal.kind === "api_key") {
		return c.json(
			{ error: { code: "forbidden", message: "API keys cannot use this endpoint" } },
			403,
		);
	}
	return next();
});

/**
 * Where to send a browser that is on a host other than `canonicalHost`, where
 * the Clerk session lives. Null for API keys, the REST API and MCP, which keep
 * working on every host.
 */
export function canonicalRedirectUrl(request: Request, canonicalHost: string): string | null {
	const url = new URL(request.url);
	if (url.hostname === canonicalHost) return null;
	if (isMachinePath(url.pathname) || isApiKeyRequest(request)) return null;
	url.hostname = canonicalHost;
	return url.toString();
}

export const canonicalHostMiddleware = createMiddleware<AppContext>(async (c, next) => {
	const target = isDev() ? null : canonicalRedirectUrl(c.req.raw, c.env.CANONICAL_HOST);
	return target ? c.redirect(target, 301) : next();
});
