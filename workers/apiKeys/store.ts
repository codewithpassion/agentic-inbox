// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * ApiKeyStore - singleton Durable Object holding every API key.
 *
 * One instance (id from name "global") backs the `API_KEYS` binding. Keys are
 * stored as SHA-256 hashes; the plaintext is returned exactly once at creation.
 * A revoked or expired key stops working immediately because every request
 * verifies against this DO.
 */
import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { and, desc, eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import { applyMigrations, apiKeysMigrations } from "../durableObject/migrations";
import type { Env } from "../types";

/** Plaintext keys start with this prefix so they are greppable in leaked logs. */
export const API_KEY_PREFIX = "aik_";

/** Key material is 32 random bytes, base64url-encoded after the prefix. */
const API_KEY_BYTES = 32;

/** `last_used_at` is updated at most once per this interval per key. */
const LAST_USED_THROTTLE_MS = 60_000;

/** Length of the display prefix (`aik_` plus 8 characters). */
const KEY_PREFIX_LENGTH = 12;

export type ApiKeyRecord = Omit<typeof schema.apiKeys.$inferSelect, "mailboxes"> & {
	mailboxes: string[] | null;
};

export interface CreateApiKeyInput {
	name: string;
	keyHash: string;
	keyPrefix: string;
	/** Mailbox ids the key may access; null means all mailboxes. */
	mailboxes?: string[] | null;
	createdBy?: string | null;
	expiresAt?: string | null;
}

/** Generate a new plaintext API key (`aik_` + 32 random bytes, base64url). */
export function generateApiKey(): string {
	const bytes = new Uint8Array(API_KEY_BYTES);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const base64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${API_KEY_PREFIX}${base64url}`;
}

/** SHA-256 hex digest of a plaintext key. */
export async function hashApiKey(key: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Display prefix shown in the UI and CLI (never the full key). */
export function apiKeyDisplayPrefix(key: string): string {
	return key.slice(0, KEY_PREFIX_LENGTH);
}

function parseMailboxes(raw: string | null): string[] | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.map(String) : null;
	} catch {
		return null;
	}
}

export class ApiKeyStore extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, apiKeysMigrations, this.ctx.storage);
	}

	async create(input: CreateApiKeyInput): Promise<ApiKeyRecord> {
		const record = {
			id: crypto.randomUUID(),
			name: input.name,
			key_prefix: input.keyPrefix,
			key_hash: input.keyHash,
			mailboxes: input.mailboxes ? JSON.stringify(input.mailboxes) : null,
			created_at: new Date().toISOString(),
			created_by: input.createdBy ?? null,
			expires_at: input.expiresAt ?? null,
			last_used_at: null,
			revoked_at: null,
		};
		this.db.insert(schema.apiKeys).values(record).run();
		return { ...record, mailboxes: input.mailboxes ?? null };
	}

	async list(): Promise<ApiKeyRecord[]> {
		const rows = this.db
			.select()
			.from(schema.apiKeys)
			.orderBy(desc(schema.apiKeys.created_at))
			.all();
		return rows.map((row) => ({ ...row, mailboxes: parseMailboxes(row.mailboxes) }));
	}

	async get(id: string): Promise<ApiKeyRecord | null> {
		const row = this.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
		return row ? { ...row, mailboxes: parseMailboxes(row.mailboxes) } : null;
	}

	/**
	 * Update the editable fields of a key. Null resets an optional field
	 * (clears an expiry, or lifts the mailbox restriction).
	 */
	async update(
		id: string,
		patch: { name?: string; expiresAt?: string | null; mailboxes?: string[] | null },
	): Promise<ApiKeyRecord | null> {
		const data: {
			name?: string;
			expires_at?: string | null;
			mailboxes?: string | null;
		} = {};
		if (patch.name !== undefined) data.name = patch.name;
		if (patch.expiresAt !== undefined) data.expires_at = patch.expiresAt;
		if (patch.mailboxes !== undefined) {
			data.mailboxes = patch.mailboxes ? JSON.stringify(patch.mailboxes) : null;
		}
		if (Object.keys(data).length === 0) return this.get(id);

		const updated = this.db
			.update(schema.apiKeys)
			.set(data)
			.where(eq(schema.apiKeys.id, id))
			.returning()
			.get();
		return updated ? { ...updated, mailboxes: parseMailboxes(updated.mailboxes) } : null;
	}

	async revoke(id: string): Promise<ApiKeyRecord | null> {
		const row = await this.get(id);
		if (!row || row.revoked_at) return row;
		const revokedAt = new Date().toISOString();
		this.db.update(schema.apiKeys).set({ revoked_at: revokedAt }).where(eq(schema.apiKeys.id, id)).run();
		return { ...row, revoked_at: revokedAt };
	}

	async delete(id: string): Promise<boolean> {
		const deleted = this.db
			.delete(schema.apiKeys)
			.where(eq(schema.apiKeys.id, id))
			.returning({ id: schema.apiKeys.id })
			.all();
		return deleted.length > 0;
	}

	/**
	 * Verify a key hash and return the record if it is active.
	 * Returns null for unknown, revoked, or expired keys. Refreshes
	 * `last_used_at` at most once per minute to avoid a write per request.
	 */
	async verify(keyHash: string): Promise<ApiKeyRecord | null> {
		const row = this.db
			.select()
			.from(schema.apiKeys)
			.where(and(eq(schema.apiKeys.key_hash, keyHash), isNull(schema.apiKeys.revoked_at)))
			.get();
		if (!row) return null;

		const now = new Date();
		if (row.expires_at && row.expires_at <= now.toISOString()) return null;

		const lastUsed = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
		if (now.getTime() - lastUsed > LAST_USED_THROTTLE_MS) {
			const iso = now.toISOString();
			this.db
				.update(schema.apiKeys)
				.set({ last_used_at: iso })
				.where(eq(schema.apiKeys.id, row.id))
				.run();
			row.last_used_at = iso;
		}
		return { ...row, mailboxes: parseMailboxes(row.mailboxes) };
	}
}
