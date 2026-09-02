// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Dump GET /api/v1/openapi.json from the API sub-app without a running
 * server. Used to check the spec and to refresh cli/openapi.json.
 *
 * Run with: bunx tsx scripts/export-openapi.ts [outfile]
 */
import { writeFileSync } from "node:fs";
import { app } from "../workers/index";

const response = await app.request("https://mail.example.com/api/v1/openapi.json");
if (!response.ok) {
	throw new Error(`openapi.json returned ${response.status}`);
}
const doc = await response.text();
JSON.parse(doc); // sanity: must be valid JSON

const outfile = process.argv[2];
if (outfile) {
	writeFileSync(outfile, doc + "\n");
	console.log(`wrote ${outfile}`);
} else {
	console.log(doc);
}
