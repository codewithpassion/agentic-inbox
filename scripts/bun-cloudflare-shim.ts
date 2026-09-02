// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Bun preload plugin that stubs the `cloudflare:workers` module so scripts
 * like export-openapi.ts can import workers/index.ts outside workerd.
 * The Durable Object base classes are never instantiated here; only the
 * Hono app is exercised.
 */
import { plugin } from "bun";

class DurableObjectStubBase {
	env: unknown;
	ctx: unknown;
	constructor(state?: unknown, env?: unknown) {
		this.ctx = state;
		this.env = env;
	}
}

plugin({
	name: "cloudflare-workers-shim",
	setup(build) {
		build.module("cloudflare:workers", () => ({
			exports: { DurableObject: DurableObjectStubBase },
			loader: "object",
		}));
	},
});
