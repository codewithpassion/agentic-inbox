// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { fetchApi } from "./helpers";

describe("GET /api/v1/config", () => {
	it("returns configured domains and allowed email addresses", async () => {
		const response = await fetchApi("/api/v1/config");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			domains: ["mail.example.com"],
			emailAddresses: [],
		});
	});
});
