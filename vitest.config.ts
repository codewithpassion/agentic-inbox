// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async (ctx) => ({
			// Test the API sub-app exported from workers/index.ts, not workers/app.ts:
			// the entry imports virtual:react-router/server-build, which this pool
			// cannot resolve.
			main: "./workers/index.ts",
			miniflare: {
				compatibilityDate: "2025-11-28",
				compatibilityFlags: ["nodejs_compat"],
				bindings: {
					DOMAINS: "mail.example.com",
					EMAIL_ADDRESSES: [],
					// Access JWT test setup from vitest.global-setup.ts
					TEST_JWKS_ORIGIN: ctx.inject("jwksOrigin"),
					TEST_PRIVATE_JWK: ctx.inject("privateJwk"),
				},
				r2Buckets: ["BUCKET"],
				durableObjects: {
					MAILBOX: { className: "MailboxDO", useSQLite: true },
					API_KEYS: { className: "ApiKeyStore", useSQLite: true },
				},
			},
		})),
	],
	test: {
		globalSetup: ["./vitest.global-setup.ts"],
		include: ["workers/tests/**/*.test.ts"],
	},
});
