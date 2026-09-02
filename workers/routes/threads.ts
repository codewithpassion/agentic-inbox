// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";
import { z } from "zod";
import { validationErrorHook } from "../lib/errors";
import { getMailboxStub, type MailboxThreadReaderStub } from "../lib/email-helpers";
import type { MailboxContext } from "../lib/mailbox";
import { EmailFullSchema, StatusResponseSchema } from "../lib/schemas";
import type { EmailFull } from "../lib/schemas";

const THREAD_ID_PARAM = z.object({ mailboxId: z.string(), threadId: z.string() });

export const threadRoutes = new Hono<MailboxContext>()
	.get(
		"/api/v1/mailboxes/:mailboxId/threads/:threadId",
		describeRoute({
			description: "Get every email in a conversation thread, oldest first, with attachments.",
			responses: {
				200: {
					description: "Thread messages",
					content: { "application/json": { schema: resolver(z.array(EmailFullSchema)) } },
				},
			},
		}),
		validator("param", THREAD_ID_PARAM, validationErrorHook),
		async (c) => {
			const stub = getMailboxStub(c.env, c.req.param("mailboxId")!) as unknown as MailboxThreadReaderStub;
			const emails = await stub.getThreadEmails(c.req.param("threadId")!);
			return c.json(emails);
		},
	)
	.post(
		"/api/v1/mailboxes/:mailboxId/threads/:threadId/read",
		describeRoute({
			description: "Mark every email in a thread as read.",
			responses: {
				200: {
					description: "Marked read",
					content: { "application/json": { schema: resolver(StatusResponseSchema) } },
				},
			},
		}),
		validator("param", THREAD_ID_PARAM, validationErrorHook),
		async (c) => {
			const stub = getMailboxStub(c.env, c.req.param("mailboxId")!);
			await stub.markThreadRead(c.req.param("threadId")!);
			return c.json({ status: "marked_read" });
		},
	);
