// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Command } from "commander";
import { resolveBodyInput } from "../body-input";
import { getClient, unwrap } from "../client";
import { makeContext, requireMailbox } from "../context";
import { usageError } from "../errors";
import { printJson } from "../output";
import { confirmOrFail } from "../prompt";

type DraftResult = { id: string; status: string };

function requireSubject(subject: string | undefined, commandName: string): string {
	if (subject === undefined) throw usageError(`${commandName}: --subject is required`);
	return subject;
}

/** `inbox drafts create|update|delete`. */
export function registerDrafts(program: Command): void {
	const drafts = program.command("drafts").description("Draft management");

	drafts
		.command("create")
		.description("Save a draft (not sent)")
		.option("--to <addr>", "Recipient address")
		.option("--subject <text>", "Subject line")
		.option("--body <text>", "Body text; '-' reads stdin")
		.option("--body-file <path>", "Read the body from a file")
		.option("--reply-to <emailId>", "Email this draft replies to (sets threading)")
		.option("--verify", "Run the AI draft verifier over the draft body")
		.action(async function (
			this: Command,
			opts: { to?: string; subject?: string; body?: string; bodyFile?: string; replyTo?: string; verify?: boolean },
		) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const subject = requireSubject(opts.subject, "drafts create");
			const body = await resolveBodyInput({ body: opts.body, bodyFile: opts.bodyFile, commandName: "drafts create" });
			const draft = unwrap(
				await client.POST("/api/v1/mailboxes/{mailboxId}/drafts", {
					params: { path: { mailboxId: mailbox } },
					body: {
						...(opts.to ? { to: opts.to } : {}),
						subject,
						body,
						...(opts.replyTo ? { in_reply_to: opts.replyTo } : {}),
						...(opts.verify ? { verify: true } : {}),
					},
				}),
			) as DraftResult;
			printJson([{ id: draft.id, status: "draft" }]);
		});

	drafts
		.command("update <draftId>")
		.description("Update a draft; it is recreated with a new id")
		.option("--to <addr>", "Recipient address")
		.option("--subject <text>", "Subject line")
		.option("--body <text>", "Body text; '-' reads stdin")
		.option("--body-file <path>", "Read the body from a file")
		.option("--verify", "Run the AI draft verifier over the updated body")
		.action(async function (
			this: Command,
			draftId: string,
			opts: { to?: string; subject?: string; body?: string; bodyFile?: string; verify?: boolean },
		) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const body = await resolveBodyInput({
				body: opts.body,
				bodyFile: opts.bodyFile,
				commandName: "drafts update",
			}).catch(() => undefined as unknown as string);
			const updated = unwrap(
				await client.PATCH("/api/v1/mailboxes/{mailboxId}/drafts/{draftId}", {
					params: { path: { mailboxId: mailbox, draftId } },
					body: {
						...(opts.to ? { to: opts.to } : {}),
						...(opts.subject ? { subject: opts.subject } : {}),
						...(body !== undefined ? { body } : {}),
						...(opts.verify ? { verify: true } : {}),
					},
				}),
			) as { id: string; status: string };
			printJson([{ id: updated.id, status: "draft_updated" }]);
		});

	drafts
		.command("delete <draftId>")
		.description("Discard a draft")
		.action(async function (this: Command, draftId: string) {
			const ctx = makeContext(this);
			await confirmOrFail({ yes: ctx.yes, stdoutIsTTY: ctx.stdoutIsTTY }, `Discard draft ${draftId}?`);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			await client.DELETE("/api/v1/mailboxes/{mailboxId}/drafts/{draftId}", {
				params: { path: { mailboxId: mailbox, draftId } },
			});
			printJson([{ id: draftId, status: "discarded" }]);
		});
}
