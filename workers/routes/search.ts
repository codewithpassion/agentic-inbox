// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { z } from "zod";
import { validationErrorHook } from "../lib/errors";
import type { MailboxContext } from "../lib/mailbox";
import { EmailListResponseSchema, boolParam, limitParam, pageParam } from "../lib/schemas";
import type { MailboxSearchStub } from "../lib/tools";

const SearchQuery = z.object({
	query: z.string().optional(),
	folder: z.string().optional(),
	from: z.string().optional(),
	to: z.string().optional(),
	subject: z.string().optional(),
	date_start: z.string().optional(),
	date_end: z.string().optional(),
	is_read: boolParam,
	is_starred: boolParam,
	has_attachment: boolParam,
	page: pageParam,
	limit: limitParam,
});

export const searchRoutes = new Hono<MailboxContext>().get(
	"/api/v1/mailboxes/:mailboxId/search",
	describeRoute({
		description:
			"Search emails with optional field filters. query matches subject, body, sender, and recipients; dates are inclusive ISO timestamps.",
		responses: {
			200: {
				description: "Paginated search results",
				content: { "application/json": { schema: resolver(EmailListResponseSchema) } },
			},
		},
	}),
	validator("query", SearchQuery, validationErrorHook),
	async (c) => {
		const {
			query, folder, from, to, subject, date_start, date_end,
			is_read, is_starred, has_attachment, page, limit,
		} = c.req.valid("query");
		const searchOpts = {
			query: query || "", folder, from, to, subject, date_start, date_end,
			is_read, is_starred, has_attachment,
		};
		const stub = c.var.mailboxStub as unknown as MailboxSearchStub;
		const emails = await stub.searchEmails({ ...searchOpts, page, limit });
		const totalCount = await stub.countSearchResults(searchOpts);
		return c.json({ emails, totalCount });
	},
);
