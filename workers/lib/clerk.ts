// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Clerk session handling. The `email` claim comes from the instance's session
 * token configuration: `session.claims.email = {{user.primary_email_address}}`.
 */
import { createClerkClient } from "@clerk/backend";
import type { Env } from "../types";

export type ClerkResult =
	| { status: "signed-in"; email: string; sessionId: string }
	/** Clerk needs the browser to complete a handshake before the session is readable. */
	| { status: "redirect"; response: Response }
	| { status: "signed-out" };

export function isClerkConfigured(env: Env): boolean {
	return Boolean(env.CLERK_PUBLISHABLE_KEY && env.CLERK_SECRET_KEY && env.CLERK_SIGN_IN_URL);
}

function clerkClient(env: Env) {
	return createClerkClient({
		secretKey: env.CLERK_SECRET_KEY,
		publishableKey: env.CLERK_PUBLISHABLE_KEY,
		jwtKey: env.CLERK_JWT_KEY,
	});
}

export async function authenticateClerk(request: Request, env: Env): Promise<ClerkResult> {
	const state = await clerkClient(env).authenticateRequest(request, {
		// A token minted for another site on this Clerk instance (hei.dev/admin) is not valid here.
		authorizedParties: [new URL(request.url).origin],
	});
	if (state.headers.get("location")) {
		return { status: "redirect", response: new Response(null, { status: 307, headers: state.headers }) };
	}
	if (state.status !== "signed-in") return { status: "signed-out" };

	const { sessionClaims, sessionId } = state.toAuth();
	const email = sessionClaims.email;
	return { status: "signed-in", email: typeof email === "string" ? email : "", sessionId };
}

export async function revokeClerkSession(sessionId: string, env: Env): Promise<void> {
	await clerkClient(env).sessions.revokeSession(sessionId);
}

/**
 * ALLOWED_EMAILS is comma-separated: full addresses, or `@domain` for a whole
 * domain. Empty or unset admits nobody.
 */
export function isEmailAllowed(email: string, allowedEmails: string | undefined): boolean {
	const address = email.trim().toLowerCase();
	if (!address.includes("@")) return false;
	const domain = address.slice(address.lastIndexOf("@"));
	return (allowedEmails ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.some((entry) => entry !== "" && (entry === address || entry === domain));
}

/** The Clerk Account Portal sign-in page, returning to `returnTo` afterwards. */
export function signInRedirectUrl(env: Env, returnTo: string): string {
	const url = new URL(env.CLERK_SIGN_IN_URL);
	url.searchParams.set("redirect_url", returnTo);
	return url.toString();
}
