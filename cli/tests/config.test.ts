// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, test } from "bun:test";
import { clearApiKey, configPath, readConfigFile, resolveSettings, saveProfile } from "../src/config";

describe("resolveSettings precedence", () => {
	test("config file alone is used when nothing else is set", () => {
		const settings = resolveSettings({
			file: { url: "https://file.example.com", api_key: "aik_file" },
			env: {},
			flags: {},
		});
		expect(settings).toEqual({ url: "https://file.example.com", api_key: "aik_file" });
	});

	test("environment overrides the config file", () => {
		const settings = resolveSettings({
			file: { url: "https://file.example.com", api_key: "aik_file" },
			env: { INBOX_URL: "https://env.example.com", INBOX_API_KEY: "aik_env" },
			flags: {},
		});
		expect(settings).toEqual({ url: "https://env.example.com", api_key: "aik_env" });
	});

	test("flags override environment and file", () => {
		const settings = resolveSettings({
			file: { url: "https://file.example.com", mailbox: "file@example.com" },
			env: { INBOX_URL: "https://env.example.com", INBOX_MAILBOX: "env@example.com" },
			flags: { url: "https://flag.example.com" },
		});
		expect(settings.url).toBe("https://flag.example.com");
		expect(settings.mailbox).toBe("env@example.com");
	});

	test("named profiles layer over the top-level config", () => {
		const settings = resolveSettings({
			profile: "work",
			file: {
				url: "https://home.example.com",
				api_key: "aik_home",
				profiles: { work: { url: "https://work.example.com", api_key: "aik_work" } },
			},
			env: {},
			flags: {},
		});
		expect(settings).toEqual({ url: "https://work.example.com", api_key: "aik_work" });
	});

	test("unknown profiles resolve to empty settings, never another profile's credentials", () => {
		const settings = resolveSettings({
			profile: "missing",
			file: { url: "https://home.example.com", api_key: "aik_home" },
			env: {},
			flags: {},
		});
		expect(settings.url).toBeUndefined();
		expect(settings.api_key).toBeUndefined();
	});

	test("INBOX_PROFILE selects a profile", () => {
		const settings = resolveSettings({
			file: { profiles: { work: { url: "https://work.example.com" } } },
			env: { INBOX_PROFILE: "work" },
			flags: {},
		});
		expect(settings.url).toBe("https://work.example.com");
	});

	test("invalid INBOX_FORMAT from the environment is ignored", () => {
		const settings = resolveSettings({
			file: { format: "table" },
			env: { INBOX_FORMAT: "bogus" },
			flags: {},
		});
		expect(settings.format).toBe("table");
	});
});

describe("config file handling", () => {
	test("configPath honours XDG_CONFIG_HOME", () => {
		expect(configPath("/tmp/xdg")).toBe("/tmp/xdg/inbox/config.json");
	});

	test("missing files read as empty", () => {
		expect(readConfigFile("/nonexistent/inbox/config.json")).toEqual({});
	});

	test("saveProfile creates the file with restricted permissions and clearApiKey removes the key", () => {
		const filePath = `/tmp/inbox-test-${crypto.randomUUID()}.json`;
		saveProfile("default", { url: "https://x.example.com", api_key: "aik_secret" }, filePath);
		const stat = require("node:fs").statSync(filePath);
		expect(stat.mode & 0o777).toBe(0o600);

		expect(readConfigFile(filePath).api_key).toBe("aik_secret");
		clearApiKey("default", filePath);
		expect(readConfigFile(filePath).api_key).toBeUndefined();
		expect(readConfigFile(filePath).url).toBe("https://x.example.com");

		require("node:fs").unlinkSync(filePath);
	});

	test("the default profile does not leak other profiles' credentials", () => {
		const settings = resolveSettings({
			file: {
				url: "https://root.example.com",
				api_key: "aik_root",
				profiles: { hei: { url: "https://hei.example.com", api_key: "aik_hei" } },
			},
			env: {},
			flags: {},
		});
		expect(settings).toEqual({ url: "https://root.example.com", api_key: "aik_root" });
		expect(settings).not.toHaveProperty("profiles");
	});

	test("saveProfile for named profiles writes into the profiles map", () => {
		const filePath = `/tmp/inbox-test-${crypto.randomUUID()}.json`;
		saveProfile("work", { url: "https://work.example.com", api_key: "aik_w" }, filePath);
		const file = readConfigFile(filePath);
		expect(file.profiles?.work).toEqual({ url: "https://work.example.com", api_key: "aik_w" });
		require("node:fs").unlinkSync(filePath);
	});
});
