// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cloudflare only delivers `message.forward()` to destination addresses verified
 * on the account. This client reads and registers them through the Email Routing
 * API. Without a token the feature still works, but destinations must be verified
 * in the Cloudflare dashboard and their status shows as unknown.
 */
export type DestinationStatus = "verified" | "pending" | "unknown";

export interface DestinationApiConfig {
	token?: string;
	accountId?: string;
	fetcher?: typeof fetch;
}

interface AddressPage {
	result?: { email: string; verified: string | null }[];
	result_info?: { total_count?: number };
}

/** The maximum the API accepts. */
const PER_PAGE = 50;

function addressesUrl(accountId: string): string {
	return `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/routing/addresses`;
}

/** Status of every destination on the account, or null when Cloudflare can't be asked. */
export async function getDestinationStatuses(
	config: DestinationApiConfig,
): Promise<Map<string, "verified" | "pending"> | null> {
	const { token, accountId, fetcher = fetch } = config;
	if (!token || !accountId) return null;

	const statuses = new Map<string, "verified" | "pending">();
	try {
		for (let page = 1; ; page++) {
			const response = await fetcher(`${addressesUrl(accountId)}?page=${page}&per_page=${PER_PAGE}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) {
				console.error(`Listing forwarding destinations failed: ${response.status}`);
				return null;
			}
			const { result = [], result_info } = (await response.json()) as AddressPage;
			for (const { email, verified } of result) {
				statuses.set(email.toLowerCase(), verified ? "verified" : "pending");
			}
			if (result.length === 0 || page * PER_PAGE >= (result_info?.total_count ?? 0)) return statuses;
		}
	} catch (e) {
		console.error("Listing forwarding destinations failed:", (e as Error).message);
		return null;
	}
}

/** Adds the destination to the account if it's new, which starts Cloudflare's verification. */
export async function registerDestination(config: DestinationApiConfig, email: string): Promise<DestinationStatus> {
	const statuses = await getDestinationStatuses(config);
	if (!statuses) return "unknown";

	const existing = statuses.get(email);
	if (existing) return existing;

	const { token, accountId, fetcher = fetch } = config;
	try {
		const response = await fetcher(addressesUrl(accountId as string), {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ email }),
		});
		if (!response.ok) {
			console.error(`Registering forwarding destination failed: ${response.status}`);
			return "unknown";
		}
		return "pending";
	} catch (e) {
		console.error("Registering forwarding destination failed:", (e as Error).message);
		return "unknown";
	}
}
