// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { download, getClient, unwrap } from "../client";
import { makeContext, requireMailbox } from "../context";
import { usageError } from "../errors";

type AttachmentInfo = { id: string; filename: string };

/** `inbox attachments download <emailId> <attachmentId>`. */
export function registerAttachments(program: Command): void {
	const attachments = program.command("attachments").description("Attachment files");

	attachments
		.command("download <emailId> <attachmentId>")
		.description("Download one attachment; defaults to the original filename in the current directory")
		.option("--out <path>", "Output path (default: original filename)")
		.action(async function (this: Command, emailId: string, attachmentId: string, opts: { out?: string }) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);

			// Resolve the original filename from the email's attachment metadata.
			const email = unwrap(
				await client.GET("/api/v1/mailboxes/{mailboxId}/emails/{id}", {
					params: { path: { mailboxId: mailbox, id: emailId } },
				}),
			) as { attachments?: AttachmentInfo[] };
			const info = (email.attachments ?? []).find((a) => a.id === attachmentId);
			const outPath = opts.out ?? info?.filename;
			if (!outPath) {
				throw usageError("Unknown attachment id and no --out path given");
			}

			const response = await download(
				ctx.settings,
				`/api/v1/mailboxes/${encodeURIComponent(mailbox)}/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
			);
			if (!response.ok) {
				throw usageError(`Attachment download failed: ${response.status}`);
			}
			await writeFile(outPath, await response.bytes());
			process.stderr.write(`Saved ${outPath}\n`);
		});
}
