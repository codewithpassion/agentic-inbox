// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Command } from "commander";
import { getClient, unwrap } from "../client";
import { type Context, makeContext } from "../context";
import { emitDetail, emitList } from "../render";

type Mailbox = {
	id: string;
	name?: string;
	email?: string;
};

function emitMailbox(ctx: Context, mailbox: Mailbox): void {
	emitDetail(ctx, mailbox, [
		["id", (m) => m.id],
		["email", (m) => m.email ?? m.id],
		["name", (m) => m.name ?? m.id],
	]);
}

/** `inbox mailboxes list|get`. */
export function registerMailboxes(program: Command): void {
	const mailboxes = program.command("mailboxes").description("Mailbox administration");

	mailboxes
		.command("list")
		.description("List every mailbox visible to the credentials")
		.action(async function (this: Command) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const list = unwrap(await client.GET("/api/v1/mailboxes"));
			emitList(ctx, list, [
				{ header: "ID", cell: (m) => m.id },
				{ header: "NAME", cell: (m) => m.name ?? m.id },
			]);
		});

	mailboxes
		.command("get <id>")
		.description("Show one mailbox with its settings")
		.action(async function (this: Command, id: string) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const mailbox = unwrap(
				await client.GET("/api/v1/mailboxes/{mailboxId}", {
					params: { path: { mailboxId: id } },
				}),
			);
			emitMailbox(ctx, mailbox);
		});
}
