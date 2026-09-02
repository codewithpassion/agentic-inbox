// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Command } from "commander";
import { getClient, unwrap } from "../client";
import { makeContext, requireMailbox } from "../context";
import { printJson } from "../output";
import { confirmOrFail } from "../prompt";
import { emitList } from "../render";

type Folder = {
	id: string;
	name: string;
	unreadCount: number;
};

/** `inbox folders list|create|rename|delete`. */
export function registerFolders(program: Command): void {
	const folders = program.command("folders").description("Mailbox folders");

	folders
		.command("list")
		.description("List folders with unread counts")
		.action(async function (this: Command) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const result = await client.GET("/api/v1/mailboxes/{mailboxId}/folders", {
				params: { path: { mailboxId: mailbox } },
			});
			const list = (unwrap(result) as Folder[] | undefined) ?? [];
			emitList(ctx, list, [
				{ header: "ID", cell: (f) => f.id },
				{ header: "NAME", cell: (f) => f.name },
				{ header: "UNREAD", cell: (f) => String(f.unreadCount) },
			]);
		});

	folders
		.command("create <name>")
		.description("Create a folder (the id is the slugified name)")
		.action(async function (this: Command, name: string) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const folder = unwrap(
				await client.POST("/api/v1/mailboxes/{mailboxId}/folders", {
					params: { path: { mailboxId: mailbox } },
					body: { name },
				}),
			) as Folder;
			printJson([{ id: folder.id, status: "created" }]);
		});

	folders
		.command("rename <folderId> <name>")
		.description("Rename a folder")
		.action(async function (this: Command, folderId: string, name: string) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			const folder = unwrap(
				await client.PUT("/api/v1/mailboxes/{mailboxId}/folders/{id}", {
					params: { path: { mailboxId: mailbox, id: folderId } },
					body: { name },
				}),
			) as Folder;
			printJson([{ id: folder.id, status: "renamed" }]);
		});

	folders
		.command("delete <folderId>")
		.description("Delete a folder (built-in folders are protected)")
		.action(async function (this: Command, folderId: string) {
			const ctx = makeContext(this);
			await confirmOrFail({ yes: ctx.yes, stdoutIsTTY: ctx.stdoutIsTTY }, `Delete folder ${folderId}?`);
			const client = getClient(ctx.settings);
			const mailbox = requireMailbox(ctx);
			await client.DELETE("/api/v1/mailboxes/{mailboxId}/folders/{id}", {
				params: { path: { mailboxId: mailbox, id: folderId } },
			});
			printJson([{ id: folderId, status: "deleted" }]);
		});
}
