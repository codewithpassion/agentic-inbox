// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Command } from "commander";
import { getClient, unwrap } from "../client";
import { clearApiKey, configPath, resolveSettings, saveProfile } from "../config";
import { makeContext } from "../context";
import { usageError } from "../errors";
import { type OutputFormat, printJson, renderKv } from "../output";
import { readHidden, readLine } from "../prompt";

interface PrincipalInfo {
	kind: "access" | "api_key" | "dev";
	email?: string;
	keyId?: string;
	name?: string;
	mailboxes?: string[] | null;
	keyPrefix?: string;
}

interface AuthOptions {
	url?: string;
	apiKey?: string;
	profile?: string;
}

function activeProfile(opts: AuthOptions): string {
	return opts.profile ?? process.env.INBOX_PROFILE ?? "default";
}

async function gatherCredentials(opts: AuthOptions): Promise<{ url: string; apiKey: string } | null> {
	const interactive = (process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false);
	let url = opts.url;
	let apiKey = opts.apiKey;

	if ((!url || !apiKey) && !interactive) return null;
	if (!url) {
		const current = resolveSettings({ profile: activeProfile(opts) }).url;
		url = (await readLine(`Base URL${current ? ` [${current}]` : ""}: `)).trim() || current;
	}
	if (!apiKey) {
		apiKey = await readHidden("API key (input hidden): ");
	}
	if (!url || !apiKey) return null;
	return { url, apiKey };
}

/** Render /me output as JSON or a key-value block. */
export function outputPrincipal(principal: PrincipalInfo, format: OutputFormat): void {
	if (format === "json") {
		printJson(principal);
		return;
	}
	if (principal.kind === "api_key") {
		process.stdout.write(
			`${renderKv([
				["principal", "api_key"],
				["name", principal.name ?? ""],
				["key", `${principal.keyPrefix ?? "aik_"}...`],
				["mailboxes", principal.mailboxes ? principal.mailboxes.join(", ") : "all"],
			])}\n`,
		);
		return;
	}
	if (principal.kind === "access") {
		process.stdout.write(
			`${renderKv([
				["principal", "access"],
				["email", principal.email ?? ""],
			])}\n`,
		);
		return;
	}
	process.stdout.write(`${renderKv([["principal", "dev (local development, unauthenticated)"]])}\n`);
}

/** `inbox auth login|status|logout`. */
export function registerAuth(program: Command): void {
	const auth = program.command("auth").description("Credentials and connection");

	auth
		.command("login")
		.description("Store the base URL and API key for a profile")
		.action(async function (this: Command) {
			const opts = this.optsWithGlobals() as AuthOptions;
			const credentials = await gatherCredentials(opts);
			if (!credentials) {
				throw usageError("auth login needs --url and --api-key when not attached to a terminal");
			}
			if (!/^aik_[A-Za-z0-9_-]+$/.test(credentials.apiKey)) {
				throw usageError('API keys start with "aik_"');
			}
			const filePath = configPath(process.env.XDG_CONFIG_HOME);
			saveProfile(activeProfile(opts), { url: credentials.url, api_key: credentials.apiKey }, filePath);
			process.stderr.write(`Credentials saved to ${filePath}\n`);
		});

	auth
		.command("status")
		.description("Show the principal the current credentials resolve to")
		.action(async function (this: Command) {
			const ctx = makeContext(this);
			const client = getClient(ctx.settings);
			const { principal } = unwrap(await client.GET("/api/v1/me")) as { principal: PrincipalInfo };
			outputPrincipal(principal, ctx.format);
		});

	auth
		.command("logout")
		.description("Remove the stored API key for a profile")
		.action(async function (this: Command) {
			const opts = this.optsWithGlobals() as AuthOptions;
			const profile = activeProfile(opts);
			clearApiKey(profile, configPath(process.env.XDG_CONFIG_HOME));
			process.stderr.write(`API key cleared for profile "${profile}"\n`);
		});
}
