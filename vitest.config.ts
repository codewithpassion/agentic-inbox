// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
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
				},
				r2Buckets: ["BUCKET"],
				durableObjects: {
					MAILBOX: { className: "MailboxDO", useSQLite: true },
					API_KEYS: { className: "ApiKeyStore", useSQLite: true },
					EMAIL_MCP: { className: "EmailMCP", useSQLite: true },
					EMAIL_AGENT: { className: "EmailAgent", useSQLite: true },
				},
			},
		})),
	],
	test: {
		include: ["workers/tests/**/*.test.ts"],
	},
});
