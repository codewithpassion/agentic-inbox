// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { fetchApi } from "./helpers";

describe("GET /api/v1/openapi.json", () => {
	it("serves a valid OpenAPI 3.1 document covering the API surface", async () => {
		const response = await fetchApi("/api/v1/openapi.json");
		expect(response.status).toBe(200);
		const doc = (await response.json()) as {
			openapi: string;
			paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
		};
		expect(doc.openapi).toMatch(/^3\.1\./);

		const paths = Object.keys(doc.paths);
		for (const path of [
			"/api/v1/config",
			"/api/v1/mailboxes",
			"/api/v1/mailboxes/{mailboxId}/emails",
			"/api/v1/mailboxes/{mailboxId}/drafts",
			"/api/v1/mailboxes/{mailboxId}/threads/{threadId}",
			"/api/v1/mailboxes/{mailboxId}/folders",
			"/api/v1/mailboxes/{mailboxId}/search",
			"/api/v1/mailboxes/{mailboxId}/emails/{emailId}/attachments/{attachmentId}",
			"/api/v1/api-keys",
			"/api/v1/me",
		]) {
			expect(paths).toContain(path);
		}

		// Every documented operation declares at least one response schema.
		for (const [path, operations] of Object.entries(doc.paths)) {
			for (const [method, operation] of Object.entries(operations)) {
				if (method === "parameters") continue;
				expect(operation.responses, `${method} ${path}`).toBeDefined();
			}
		}
	});
});
