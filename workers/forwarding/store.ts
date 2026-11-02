// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Forward rules live in R2 next to the mailbox settings, one object per source address. */
export interface ForwardRule {
	source: string;
	destination: string;
	created_at: string;
	created_by: string | null;
}

const PREFIX = "forwarding/";

function ruleKey(source: string): string {
	return `${PREFIX}${source}.json`;
}

export async function getForwardRule(bucket: R2Bucket, source: string): Promise<ForwardRule | null> {
	const object = await bucket.get(ruleKey(source));
	return object ? object.json<ForwardRule>() : null;
}

export async function listForwardRules(bucket: R2Bucket): Promise<ForwardRule[]> {
	const { objects } = await bucket.list({ prefix: PREFIX });
	const rules = await Promise.all(
		objects.map(async ({ key }) => (await bucket.get(key))?.json<ForwardRule>() ?? null),
	);
	return rules.filter((rule): rule is ForwardRule => rule !== null);
}

export async function putForwardRule(bucket: R2Bucket, rule: ForwardRule): Promise<void> {
	await bucket.put(ruleKey(rule.source), JSON.stringify(rule));
}

export async function deleteForwardRule(bucket: R2Bucket, source: string): Promise<void> {
	await bucket.delete(ruleKey(source));
}
