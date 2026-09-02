// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Command } from "commander";
import { getClient, unwrap } from "../client";
import { makeContext, requireMailbox } from "../context";
import { emitDetail, emitList } from "../render";

type EmailSummary = {
	id: string;
	subject?: string | null;
	sender?: string | null;
	recipient?: string | null;
	date?: string | null;
	read?: boolean;
	starred?: boolean;
	thread_id?: string | null;
};

type EmailFull = EmailSummary & {
	body?: string | null;
	raw_headers?: string | null;
	attachments?: { id: string; filename: string; mimetype: string; size: number }[];
};

function flags(email: { read?: boolean; starred?: boolean }): string {
	const parts: string[] = [];
	if (email.starred) parts.push("*");
	if (!email.read) parts.push("unread");
	return parts.join(" ");
}

/** `inbox emails list|get|search`. Write commands live in their own phase. */
export function registerEmails(program: Command): void {
	const emails = program.command("emails").description("Read and manage emails");

	emails
		.command("list")
		.description("List emails in a folder")
		.option("--folder <name>", "Folder name or id (default: inbox)")
		.option("--page <n>", "1-based page number", parseInt)
		.option("--limit <n>", "Page size, 1-100", parseInt)
		.option("--threaded", "Group by conversation")
		.action(async function (
			this: Command,
			opts: { folder?: string; page?: number; limit?: number; threaded?: boolean },
		) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const result = unwrap(
				await client.GET("/api/v1/mailboxes/{mailboxId}/emails", {
					params: {
						path: { mailboxId: mailbox },
						query: {
							folder: opts.folder ?? "inbox",
							...(opts.page !== undefined ? { page: opts.page } : {}),
							...(opts.limit !== undefined ? { limit: opts.limit } : {}),
							...(opts.threaded ? { threaded: "true" } : {}),
						},
					},
				}),
			);
			const emails = (result as { emails: EmailSummary[] }).emails;
			emitList(ctx, emails, [
				{ header: "ID", cell: (m) => m.id },
				{ header: "DATE", cell: (m) => m.date ?? "" },
				{ header: "FROM", cell: (m) => m.sender ?? "" },
				{ header: "SUBJECT", cell: (m) => m.subject ?? "" },
				{ header: "FLAGS", cell: (m) => flags(m) },
			]);
		});

	emails
		.command("get <emailId>")
		.description("Show one email with its body")
		.option("--raw-headers", "Print the stored raw headers instead of the summary")
		.option("--body-only", "Print only the body")
		.action(async function (this: Command, emailId: string, opts: { rawHeaders?: boolean; bodyOnly?: boolean }) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const email = unwrap(
				await client.GET("/api/v1/mailboxes/{mailboxId}/emails/{id}", {
					params: { path: { mailboxId: mailbox, id: emailId } },
				}),
			) as EmailFull;

			if (opts.rawHeaders) {
				process.stdout.write(`${email.raw_headers ?? ""}\n`);
				return;
			}
			if (opts.bodyOnly) {
				process.stdout.write(`${email.body ?? ""}\n`);
				return;
			}
			emitDetail(ctx, email, [
				["id", (m) => m.id],
				["subject", (m) => m.subject ?? ""],
				["from", (m) => m.sender ?? ""],
				["to", (m) => m.recipient ?? ""],
				["date", (m) => m.date ?? ""],
				["thread_id", (m) => m.thread_id ?? ""],
				["flags", (m) => flags(m)],
				["attachments", (m) => (m.attachments ?? []).map((a) => a.filename).join(", ")],
				[
					"body",
					(m) =>
						(m.body ?? "")
							.replace(/<[^>]+>/g, " ")
							.replace(/\s+/g, " ")
							.trim()
							.slice(0, 400),
				],
			]);
		});

	emails
		.command("search <query>")
		.description("Search emails")
		.option("--folder <name>", "Restrict to a folder")
		.option("--from <addr>", "Filter by sender substring")
		.option("--to <addr>", "Filter by recipient substring")
		.option("--subject <text>", "Filter by subject substring")
		.option("--after <date>", "ISO date lower bound (inclusive)")
		.option("--before <date>", "ISO date upper bound (inclusive)")
		.option("--unread", "Only unread")
		.option("--starred", "Only starred")
		.option("--has-attachment", "Only emails with attachments")
		.option("--page <n>", "1-based page number", parseInt)
		.option("--limit <n>", "Page size, 1-100", parseInt)
		.action(async function (
			this: Command,
			query: string,
			opts: {
				folder?: string;
				from?: string;
				to?: string;
				subject?: string;
				after?: string;
				before?: string;
				unread?: boolean;
				starred?: boolean;
				hasAttachment?: boolean;
				page?: number;
				limit?: number;
			},
		) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const result = unwrap(
				await client.GET("/api/v1/mailboxes/{mailboxId}/search", {
					params: {
						path: { mailboxId: mailbox },
						query: {
							query,
							...(opts.folder ? { folder: opts.folder } : {}),
							...(opts.from ? { from: opts.from } : {}),
							...(opts.to ? { to: opts.to } : {}),
							...(opts.subject ? { subject: opts.subject } : {}),
							...(opts.after ? { date_start: opts.after } : {}),
							...(opts.before ? { date_end: opts.before } : {}),
							...(opts.unread ? { is_read: "false" } : {}),
							...(opts.starred ? { is_starred: "true" } : {}),
							...(opts.hasAttachment ? { has_attachment: "true" } : {}),
							...(opts.page !== undefined ? { page: opts.page } : {}),
							...(opts.limit !== undefined ? { limit: opts.limit } : {}),
						},
					},
				}),
			);
			const found = (result as { emails: EmailSummary[] }).emails;
			emitList(ctx, found, [
				{ header: "ID", cell: (m) => m.id },
				{ header: "DATE", cell: (m) => m.date ?? "" },
				{ header: "FROM", cell: (m) => m.sender ?? "" },
				{ header: "SUBJECT", cell: (m) => m.subject ?? "" },
				{ header: "FLAGS", cell: (m) => flags(m) },
			]);
		});
}
