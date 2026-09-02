// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Minimal ambient declaration for the subset of node:async_hooks that the
 * MCP integration uses under nodejs_compat. The runtime (workerd) provides
 * the module; these declarations only cover the API surface we touch.
 */
declare module "node:async_hooks" {
	export class AsyncLocalStorage<T extends object> {
		constructor();
		run<R>(store: T, callback: () => R): R;
		getStore(): T | undefined;
	}
}
