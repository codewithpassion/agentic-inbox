// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "../apiKeys/store";
import { fetchApi, getApiKeyStore } from "./helpers";

const getStore = getApiKeyStore;

const JSON_HEADERS = {
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
};

/** Minimal MCP streamable-http client: initialize, then call one tool. */
async function mcpToolCall(
	secret: string,
	tool: string,
	args: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const auth = { Authorization: `Bearer ${secret}` };

	const init = await fetchApi("/mcp", {
		method: "POST",
		headers: { ...JSON_HEADERS, ...auth },
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
	expect(init.status).toBe(200);
	const sessionId = init.headers.get("mcp-session-id");
	expect(sessionId).toBeTruthy();

	// The streamable-http transport answers with an SSE stream; pull the
	// JSON-RPC payload out of the data lines.
	const initBody = await init.text();
	expect(initBody).toContain('"serverInfo"');

	await fetchApi("/mcp", {
		method: "POST",
		headers: { ...JSON_HEADERS, ...auth, "mcp-session-id": sessionId! },
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
	});

	const call = await fetchApi("/mcp", {
		method: "POST",
		headers: { ...JSON_HEADERS, ...auth, "mcp-session-id": sessionId! },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: tool, arguments: args },
		}),
	});
	const callBody = await call.text();
	const dataLine = callBody.split("\n").find((l) => l.startsWith("data: "));
	return { status: call.status, body: JSON.parse(dataLine?.slice(5).trim() ?? callBody) };
}

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

describe("scoped keys over /mcp (D4)", () => {
	const DEMO = "mcp-demo@example.com";
	const OTHER = "mcp-other@example.com";

	async function seedMailbox(mailbox: string, subject: string) {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
		await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({ fromName: mailbox }));
		await stub.getFolders(); // ensures the DO exists with default folders
		const id = crypto.randomUUID();
		await stub.createEmail("inbox", {
			id,
			subject,
			sender: "writer@example.com",
			recipient: mailbox,
			date: new Date().toISOString(),
			body: "secret body",
			thread_id: `thread-${id}`,
		}, []);
		return id;
	}

	it("list_mailboxes only returns mailboxes inside the key's scope", async () => {
		await seedMailbox(DEMO, "demo mail");
		await seedMailbox(OTHER, "other mail");
		const secret = generateApiKey();
		await getStore().create({
			name: "scoped-mcp",
			keyHash: await hashApiKey(secret),
			keyPrefix: secret.slice(0, 12),
			mailboxes: [DEMO],
		});

		const { body } = await mcpToolCall(secret, "list_mailboxes", {});
		const text = (body as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? "";
		const listed = JSON.parse(text) as { id: string }[];
		expect(listed.map((m) => m.id)).toContain(DEMO);
		expect(listed.map((m) => m.id)).not.toContain(OTHER);
	});

	it("a tool call against an out-of-scope mailbox is refused with not-found", async () => {
		const secret = generateApiKey();
		await getStore().create({
			name: "scoped-mcp",
			keyHash: await hashApiKey(secret),
			keyPrefix: secret.slice(0, 12),
			mailboxes: [DEMO],
		});

		const { body } = await mcpToolCall(secret, "list_emails", { mailboxId: OTHER, folder: "inbox" });
		const content = (body as { result?: { content?: { text?: string }[]; isError?: boolean } }).result;
		expect(content?.isError).toBe(true);
		expect(content?.content?.[0]?.text).toContain("not found");
		expect(content?.content?.[0]?.text).not.toContain("other mail");
	});

	it("an unscoped key still reads its mailboxes", async () => {
		const emailId = await seedMailbox(OTHER, "readable mail");
		const secret = generateApiKey();
		await getStore().create({
			name: "open-mcp",
			keyHash: await hashApiKey(secret),
			keyPrefix: secret.slice(0, 12),
		});

		const { body } = await mcpToolCall(secret, "get_email", { mailboxId: OTHER, emailId });
		const text = (body as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? "";
		expect(text).toContain("readable mail");
	});
});
