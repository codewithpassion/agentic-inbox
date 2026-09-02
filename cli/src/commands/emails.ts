// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { readFile, stat } from "node:fs/promises";
import type { Command } from "commander";
import { resolveBodyInput } from "../body-input";
import { getClient, unwrap } from "../client";
import { type Context, makeContext, requireMailbox } from "../context";
import { usageError } from "../errors";
import { printJson } from "../output";
import { confirmOrFail } from "../prompt";
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

// ── Write commands ─────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
	txt: "text/plain",
	html: "text/html",
	css: "text/css",
	csv: "text/csv",
	json: "application/json",
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	svg: "image/svg+xml",
	webp: "image/webp",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	mp4: "video/mp4",
	zip: "application/zip",
	gz: "application/gzip",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function guessMime(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return MIME_TYPES[ext] ?? "application/octet-stream";
}

async function readAttachment(
	path: string,
): Promise<{ content: string; filename: string; type: string; disposition: "attachment" }> {
	const stats = await stat(path).catch(() => null);
	if (!stats) throw usageError(`Attachment not found: ${path}`);
	const content = await readFile(path);
	return {
		content: content.toString("base64"),
		filename: path.split("/").pop() ?? "attachment",
		type: guessMime(path),
		disposition: "attachment",
	};
}

/** Emit the ids a mutation created or changed (agents chain on these). */
async function outputMutations(ctx: Context, results: { id: string; status: string }[]): Promise<void> {
	if (ctx.format === "table") {
		process.stdout.write(`${results.map((r) => `${r.id}  ${r.status}`).join("\n")}\n`);
		return;
	}
	printJson(results);
}

interface SendOptions {
	to?: string;
	subject?: string;
	cc?: string;
	bcc?: string;
	body?: string;
	bodyFile?: string;
	html?: boolean;
	verify?: boolean;
	attach?: string[] | string;
}

function requireTo(opts: SendOptions, commandName: string): string {
	if (!opts.to) throw usageError(`${commandName}: --to is required`);
	return opts.to;
}

/** Shared payload builder for send / reply / forward. */
async function buildSendPayload(
	commandName: string,
	opts: SendOptions,
	overrides: { requireSubject: boolean },
): Promise<Record<string, unknown>> {
	if (overrides.requireSubject && opts.subject === undefined) {
		throw usageError(`${commandName}: --subject is required`);
	}
	const body = await resolveBodyInput({ body: opts.body, bodyFile: opts.bodyFile, commandName });
	const attachPaths = Array.isArray(opts.attach) ? opts.attach : opts.attach ? [opts.attach] : [];
	const attachments = await Promise.all(attachPaths.map(readAttachment));
	return {
		to: opts.to,
		...(opts.subject !== undefined ? { subject: opts.subject } : {}),
		...(opts.cc ? { cc: opts.cc } : {}),
		...(opts.bcc ? { bcc: opts.bcc } : {}),
		...(opts.html ? { html: body } : { text: body }),
		...(opts.verify ? { verify: true } : {}),
		...(attachments.length > 0 ? { attachments } : {}),
	};
}

/** `inbox emails ...`: read commands from Phase 1, write commands here. */
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

	// ── send / reply / forward ─────────────────────────────────────────

	emails
		.command("send")
		.description("Send a new email")
		.option("--to <addr>", "Recipient address")
		.option("--subject <text>", "Subject line")
		.option("--cc <addr>", "Cc address")
		.option("--bcc <addr>", "Bcc address")
		.option("--body <text>", "Body text; '-' reads stdin")
		.option("--body-file <path>", "Read the body from a file")
		.option("--html", "Treat the body as HTML instead of plain text")
		.option("--verify", "Run the AI draft verifier over the outgoing body")
		.option("--attach <path>", "Attach a file (repeatable)")
		.action(async function (this: Command, opts: SendOptions) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const payload = await buildSendPayload(
				"emails send",
				{ ...opts, to: requireTo(opts, "emails send"), subject: opts.subject ?? "" },
				{ requireSubject: true },
			);
			const sent = unwrap(
				await client.POST("/api/v1/mailboxes/{mailboxId}/emails", {
					params: { path: { mailboxId: mailbox } },
					body: { ...payload, from: mailbox } as never,
				}),
			) as { id: string; status: string };
			await outputMutations(ctx, [{ id: sent.id, status: sent.status }]);
		});

	emails
		.command("reply <emailId>")
		.description("Send a reply to an email; threading headers come from the original")
		.option("--to <addr>", "Recipient (default: the original sender)")
		.option("--subject <text>", "Subject line (default: Re: <original>)")
		.option("--cc <addr>", "Cc address")
		.option("--bcc <addr>", "Bcc address")
		.option("--body <text>", "Body text; '-' reads stdin")
		.option("--body-file <path>", "Read the body from a file")
		.option("--html", "Treat the body as HTML instead of plain text")
		.option("--verify", "Run the AI draft verifier over the outgoing body")
		.action(async function (this: Command, emailId: string, opts: SendOptions) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const original = unwrap(
				await client.GET("/api/v1/mailboxes/{mailboxId}/emails/{id}", {
					params: { path: { mailboxId: mailbox, id: emailId } },
				}),
			) as EmailSummary & { body?: string | null };
			const to = opts.to ?? original.sender ?? undefined;
			if (!to) throw usageError("emails reply: --to is required and the original has no sender");
			const subject =
				opts.subject ?? (original.subject?.match(/^re:/i) ? original.subject : `Re: ${original.subject ?? ""}`);
			const payload = await buildSendPayload("emails reply", { ...opts, to, subject }, { requireSubject: false });
			const sent = unwrap(
				await client.POST("/api/v1/mailboxes/{mailboxId}/emails/{id}/reply", {
					params: { path: { mailboxId: mailbox, id: emailId } },
					body: { ...payload, from: mailbox } as never,
				}),
			) as { id: string; status: string };
			await outputMutations(ctx, [{ id: sent.id, status: sent.status }]);
		});

	emails
		.command("forward <emailId>")
		.description("Forward an email to a new recipient")
		.option("--to <addr>", "Recipient address")
		.option("--subject <text>", "Subject line (default: Fwd: <original>)")
		.option("--cc <addr>", "Cc address")
		.option("--bcc <addr>", "Bcc address")
		.option("--body <text>", "Cover note; '-' reads stdin")
		.option("--body-file <path>", "Read the cover note from a file")
		.option("--html", "Treat the body as HTML instead of plain text")
		.option("--verify", "Run the AI draft verifier over the outgoing body")
		.action(async function (this: Command, emailId: string, opts: SendOptions) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const to = requireTo(opts, "emails forward");
			const original = unwrap(
				await client.GET("/api/v1/mailboxes/{mailboxId}/emails/{id}", {
					params: { path: { mailboxId: mailbox, id: emailId } },
				}),
			) as EmailSummary;
			const subject = opts.subject ?? `Fwd: ${original.subject ?? ""}`;
			const payload = await buildSendPayload("emails forward", { ...opts, to, subject }, { requireSubject: false });
			const sent = unwrap(
				await client.POST("/api/v1/mailboxes/{mailboxId}/emails/{id}/forward", {
					params: { path: { mailboxId: mailbox, id: emailId } },
					body: { ...payload, from: mailbox } as never,
				}),
			) as { id: string; status: string };
			await outputMutations(ctx, [{ id: sent.id, status: sent.status }]);
		});

	// ── flag and folder mutations ──────────────────────────────────────

	emails
		.command("mark-read <emailId...>")
		.description("Mark one or more emails as read")
		.action(async function (this: Command, ids: string[]) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const results: { id: string; status: string }[] = [];
			for (const id of ids) {
				await unwrap(
					await client.PUT("/api/v1/mailboxes/{mailboxId}/emails/{id}", {
						params: { path: { mailboxId: mailbox, id } },
						body: { read: true },
					}),
				);
				results.push({ id, status: "read" });
			}
			await outputMutations(ctx, results);
		});

	emails
		.command("mark-unread <emailId...>")
		.description("Mark one or more emails as unread")
		.action(async function (this: Command, ids: string[]) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const results: { id: string; status: string }[] = [];
			for (const id of ids) {
				await unwrap(
					await client.PUT("/api/v1/mailboxes/{mailboxId}/emails/{id}", {
						params: { path: { mailboxId: mailbox, id } },
						body: { read: false },
					}),
				);
				results.push({ id, status: "unread" });
			}
			await outputMutations(ctx, results);
		});

	emails
		.command("star <emailId...>")
		.description("Star one or more emails")
		.action(async function (this: Command, ids: string[]) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const results: { id: string; status: string }[] = [];
			for (const id of ids) {
				await unwrap(
					await client.PUT("/api/v1/mailboxes/{mailboxId}/emails/{id}", {
						params: { path: { mailboxId: mailbox, id } },
						body: { starred: true },
					}),
				);
				results.push({ id, status: "starred" });
			}
			await outputMutations(ctx, results);
		});

	emails
		.command("unstar <emailId...>")
		.description("Remove the star from one or more emails")
		.action(async function (this: Command, ids: string[]) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const results: { id: string; status: string }[] = [];
			for (const id of ids) {
				await unwrap(
					await client.PUT("/api/v1/mailboxes/{mailboxId}/emails/{id}", {
						params: { path: { mailboxId: mailbox, id } },
						body: { starred: false },
					}),
				);
				results.push({ id, status: "unstarred" });
			}
			await outputMutations(ctx, results);
		});

	emails
		.command("move <emailId...>")
		.description("Move one or more emails to a folder")
		.requiredOption("--folder <id>", "Destination folder id or name")
		.action(async function (this: Command, ids: string[], opts: { folder: string }) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const results: { id: string; status: string }[] = [];
			for (const id of ids) {
				const moved = unwrap(
					await client.POST("/api/v1/mailboxes/{mailboxId}/emails/{id}/move", {
						params: { path: { mailboxId: mailbox, id } },
						body: { folderId: opts.folder },
					}),
				) as { status: string };
				results.push({ id, status: moved.status });
			}
			await outputMutations(ctx, results);
		});

	emails
		.command("delete <emailId...>")
		.description("Permanently delete one or more emails")
		.action(async function (this: Command, ids: string[]) {
			const ctx = makeContext(this);
			await confirmOrFail({ yes: ctx.yes, stdoutIsTTY: ctx.stdoutIsTTY }, `Delete ${ids.length} email(s) permanently?`);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const results: { id: string; status: string }[] = [];
			for (const id of ids) {
				await client.DELETE("/api/v1/mailboxes/{mailboxId}/emails/{id}", {
					params: { path: { mailboxId: mailbox, id } },
				});
				results.push({ id, status: "deleted" });
			}
			await outputMutations(ctx, results);
		});
}
