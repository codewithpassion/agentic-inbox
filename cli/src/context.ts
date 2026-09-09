// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Command } from "commander";
import {
	configPath,
	listProfiles,
	type ProfileConfig,
	type RawConfigFile,
	readConfigFile,
	resolveSettings,
} from "./config";
import { usageError } from "./errors";
import { type OutputFormat, resolveFormat } from "./output";

/** Everything a command needs: resolved settings plus the output mode. */
export interface Context {
	/** Resolved profile name, "default" unless --profile or INBOX_PROFILE said otherwise. */
	profile: string;
	settings: ProfileConfig;
	format: OutputFormat;
	json: boolean;
	stdoutIsTTY: boolean;
	/** Global --yes (for destructive commands in scripts). */
	yes: boolean;
}

/** The mailbox a command should operate on, or a usage error. */
export function requireMailbox(ctx: Context): string {
	const mailbox = ctx.settings.mailbox?.trim();
	if (!mailbox) {
		throw usageError(
			"No mailbox given: pass --mailbox, set INBOX_MAILBOX, or set a default mailbox in the config file",
		);
	}
	return mailbox;
}

/**
 * Reject a --profile that names nothing, so a typo reads as a typo instead of
 * surfacing later as "No API key configured".
 */
function requireKnownProfile(profile: string, file: RawConfigFile): void {
	if (profile === "default") return;
	const known = listProfiles(file);
	if (known.includes(profile)) return;
	throw usageError(
		known.length > 0
			? `Unknown profile "${profile}". Configured profiles: ${known.join(", ")}`
			: `Unknown profile "${profile}": no profiles are configured. Run: inbox --profile ${profile} auth login`,
	);
}

/** Build the per-invocation context from global flags + env + config file. */
export function makeContext(cmd: Command): Context {
	const opts = cmd.optsWithGlobals() as Record<string, string | boolean | undefined>;
	const flags: ProfileConfig = {};
	if (typeof opts.url === "string") flags.url = opts.url;
	if (typeof opts.apiKey === "string") flags.api_key = opts.apiKey;
	if (typeof opts.mailbox === "string") flags.mailbox = opts.mailbox;
	if (typeof opts.format === "string") flags.format = opts.format as ProfileConfig["format"];

	const stdoutIsTTY = process.stdout.isTTY ?? false;
	const file = readConfigFile(configPath(process.env.XDG_CONFIG_HOME));
	const profile = typeof opts.profile === "string" ? opts.profile : (process.env.INBOX_PROFILE ?? "default");
	requireKnownProfile(profile, file);
	const settings = resolveSettings({ profile, flags, file });

	return {
		profile,
		settings,
		format: resolveFormat({
			jsonFlag: opts.json === true,
			formatFlag: typeof opts.format === "string" ? opts.format : undefined,
			configFormat: settings.format,
			stdoutIsTTY,
		}),
		json: opts.json === true,
		stdoutIsTTY,
		yes: opts.yes === true,
	};
}
