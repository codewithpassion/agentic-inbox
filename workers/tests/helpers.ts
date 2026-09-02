// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createExecutionContext, env } from "cloudflare:test";
import { Hono } from "hono";
import { app as apiApp } from "../index";
import { authMiddleware } from "../lib/auth";
import type { MailboxContext } from "../lib/mailbox";
import { EmailMCP, mcpRequestWithPrincipal } from "../mcp";
import type { Env } from "../types";

/**
 * Mirror of the wiring in workers/app.ts, which cannot be imported by the
 * test pool because it pulls in the react-router virtual module: every
 * request passes through principal resolution, then the API sub-app
 * handles /api/*.
 */
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });

const authedApiApp = new Hono<MailboxContext>()
	.use("*", authMiddleware)
	.all("/mcp", (c) => mcpHandler.fetch(mcpRequestWithPrincipal(c.req.raw, c.var.principal), c.env, c.executionCtx as ExecutionContext))
	.all("/mcp/*", (c) => mcpHandler.fetch(mcpRequestWithPrincipal(c.req.raw, c.var.principal), c.env, c.executionCtx as ExecutionContext))
	.route("/", apiApp);

const testEnv = env as unknown as Env;
const testCtx = createExecutionContext();

/**
 * Fetch the authed API app with the test bindings from the vitest pool.
 * `waitUntil` callbacks (deferred email delivery) are collected but never
 * awaited.
 */
export async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
	const request = new Request(`https://mail.example.com${path}`, init);
	return await authedApiApp.fetch(request, testEnv, testCtx);
}

/**
 * Send a request through the auth middleware alone (no API routes), to test
 * the middleware's own gates such as API keys on /agents/*.
 */
export async function fetchThroughAuthGate(path: string, init?: RequestInit): Promise<Response> {
	const gated = new Hono<{ Bindings: Env }>()
		.use("*", authMiddleware)
		.all("*", (c) => c.text("ok"));
	const request = new Request(`https://mail.example.com${path}`, init);
	return await gated.fetch(request, testEnv, testCtx);
}

/** The singleton ApiKeyStore stub for the test bindings. */
export function getApiKeyStore() {
	const ns = env.API_KEYS;
	return ns.get(ns.idFromName("global"));
}
