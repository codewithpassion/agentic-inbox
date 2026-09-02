// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "../apiKeys/store";
import { fetchApi, getApiKeyStore } from "./helpers";

const getStore = getApiKeyStore;

describe("API keys on /mcp (D5)", () => {
	it("lets an authenticated API key reach the MCP server", async () => {
		const secret = generateApiKey();
		await getStore().create({
			name: "mcp-client",
			keyHash: await hashApiKey(secret),
			keyPrefix: secret.slice(0, 12),
		});
		// A JSON-RPC initialize request. The MCP server answers it (or an
		// MCP-level error), but it must not be rejected by auth (401/403).
		const response = await fetchApi("/mcp", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${secret}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "1" },
				},
			}),
		});
		expect(response.status).not.toBe(401);
		expect(response.status).not.toBe(403);
	});
});
