// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver } from "hono-openapi/zod";
import { z } from "zod";
import type { MailboxContext } from "../lib/mailbox";

export const configRoutes = new Hono<MailboxContext>().get(
	"/api/v1/config",
	describeRoute({
		description: "Deployment configuration: allowed domains and pre-provisioned mailbox addresses.",
		responses: {
			200: {
				description: "Configuration",
				content: {
					"application/json": {
						schema: resolver(
							z.object({
								domains: z.array(z.string()),
								emailAddresses: z.array(z.string()),
							}),
						),
					},
				},
			},
		},
	}),
	(c) => {
		const domainsRaw = c.env.DOMAINS || "";
		const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
		const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
		return c.json({ domains, emailAddresses });
	},
);
