// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const ProfileSchema = z.object({
	url: z.string().optional(),
	api_key: z.string().optional(),
	mailbox: z.string().optional(),
	format: z.enum(["json", "table", "plain"]).optional(),
});

const ConfigFileSchema = ProfileSchema.extend({
	profiles: z.record(z.string(), ProfileSchema).optional(),
});

export type ProfileConfig = z.infer<typeof ProfileSchema>;
export type RawConfigFile = z.infer<typeof ConfigFileSchema>;

/** `$XDG_CONFIG_HOME/inbox/config.json`, falling back to `~/.config/inbox/config.json`. */
export function configPath(xdgConfigHome?: string): string {
	const base = xdgConfigHome?.trim() || path.join(homedir(), ".config");
	return path.join(base, "inbox", "config.json");
}

/** Read the raw config file; missing or invalid files read as empty. */
export function readConfigFile(filePath: string): RawConfigFile {
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		return ConfigFileSchema.parse(parsed);
	} catch (err) {
		if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		if (err instanceof z.ZodError || err instanceof SyntaxError) {
			// An unreadable config must not brick the CLI; treat it as empty.
			return {};
		}
		throw err;
	}
}

/**
 * Profile names the config file actually defines, for help text and error
 * messages. "default" counts only when the file root carries settings of its
 * own, so an empty file lists nothing.
 */
export function listProfiles(file: RawConfigFile): string[] {
	const named = Object.keys(file.profiles ?? {}).sort();
	const rootHasSettings = Object.keys(ProfileSchema.parse(file)).length > 0;
	return rootHasSettings ? ["default", ...named] : named;
}

/**
 * Effective settings for one profile, in precedence order:
 * flags, then environment, then config file.
 */
export function resolveSettings(options: {
	profile?: string;
	flags?: ProfileConfig;
	env?: Record<string, string | undefined>;
	file?: RawConfigFile;
}): ProfileConfig {
	const env = options.env ?? process.env;
	const file = options.file ?? readConfigFile(configPath(env.XDG_CONFIG_HOME));
	const profileName = options.profile ?? env.INBOX_PROFILE ?? "default";
	// The default profile lives at the file root; strip the `profiles` map so
	// other profiles' credentials never ride along in the resolved settings.
	const profileLayer = profileName === "default" ? ProfileSchema.parse(file) : (file.profiles?.[profileName] ?? {});

	const fromEnv: ProfileConfig = {};
	if (env.INBOX_URL) fromEnv.url = env.INBOX_URL;
	if (env.INBOX_API_KEY) fromEnv.api_key = env.INBOX_API_KEY;
	if (env.INBOX_MAILBOX) fromEnv.mailbox = env.INBOX_MAILBOX;
	if (env.INBOX_FORMAT) {
		const parsed = ProfileSchema.shape.format.safeParse(env.INBOX_FORMAT);
		if (parsed.success) fromEnv.format = parsed.data;
	}

	const flags = options.flags ?? {};
	const merged: ProfileConfig = { ...profileLayer, ...fromEnv };
	if (flags.url !== undefined) merged.url = flags.url;
	if (flags.api_key !== undefined) merged.api_key = flags.api_key;
	if (flags.mailbox !== undefined) merged.mailbox = flags.mailbox;
	if (flags.format !== undefined) merged.format = flags.format;
	return merged;
}

/** Persist settings for one profile, creating the file with mode 0600. */
export function saveProfile(profile: string, values: ProfileConfig, filePath: string): void {
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
	} catch (err) {
		if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
			if (err instanceof SyntaxError) {
				parsed = {};
			} else {
				throw err;
			}
		}
	}

	if (profile === "default") {
		Object.assign(parsed, values);
	} else {
		const profiles = (parsed.profiles as Record<string, ProfileConfig> | undefined) ?? {};
		profiles[profile] = { ...profiles[profile], ...values };
		parsed.profiles = profiles;
	}

	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
	// writeFileSync only applies mode on file creation; enforce it on updates too.
	chmodSync(filePath, 0o600);
}

/** Remove credentials for one profile (`auth logout`). */
export function clearApiKey(profile: string, filePath: string): void {
	const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
	if (profile === "default") {
		delete parsed.api_key;
	} else {
		const profiles = parsed.profiles as Record<string, ProfileConfig> | undefined;
		if (profiles?.[profile]) delete profiles[profile].api_key;
	}
	writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
	chmodSync(filePath, 0o600);
}
