// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	CLERK_SECRET_KEY: string;
	/** PEM public key that verifies session tokens without a JWKS fetch. Optional. */
	CLERK_JWT_KEY?: string;
	/** Comma-separated: full addresses, or `@domain` for a whole domain. */
	ALLOWED_EMAILS: string;
	/** Optional at runtime. Lets forward rules register destinations and show whether they're verified. */
	EMAIL_ROUTING_API_TOKEN: string;
}
