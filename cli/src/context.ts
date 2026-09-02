// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Command } from "commander";
import { type ProfileConfig, resolveSettings } from "./config";
import { type OutputFormat, resolveFormat } from "./output";

/** Everything a command needs: resolved settings plus the output mode. */
export interface Context {
	settings: ProfileConfig;
	format: OutputFormat;
	json: boolean;
	stdoutIsTTY: boolean;
	/** Global --yes (for destructive commands in scripts). */
	yes: boolean;
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
	const settings = resolveSettings({
		profile: typeof opts.profile === "string" ? opts.profile : undefined,
		flags,
	});

	return {
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
