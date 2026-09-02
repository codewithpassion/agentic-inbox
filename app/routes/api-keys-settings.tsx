// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Badge,
	Button,
	Checkbox,
	Dialog,
	Empty,
	Input,
	Loader,
	Table,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	KeyIcon,
	PencilSimpleIcon,
	PlusIcon,
	ProhibitIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import { CopyButton } from "~/components/CopyButton";
import {
	useApiKeys,
	useCreateApiKey,
	useDeleteApiKey,
	useRevokeApiKey,
	useUpdateApiKey,
} from "~/queries/api-keys";
import { useMailboxes } from "~/queries/mailboxes";
import type { ApiKey } from "~/services/api";
import { formatListDate } from "shared/dates";

export function meta() {
	return [{ title: "API keys | Agentic Inbox" }];
}

type KeyStatus = "active" | "expired" | "revoked";

function keyStatus(key: ApiKey): KeyStatus {
	if (key.revoked_at) return "revoked";
	if (key.expires_at && key.expires_at <= new Date().toISOString()) return "expired";
	return "active";
}

const STATUS_BADGE: Record<KeyStatus, { label: string; variant: "success" | "secondary" | "destructive" }> = {
	active: { label: "Active", variant: "success" },
	expired: { label: "Expired", variant: "destructive" },
	revoked: { label: "Revoked", variant: "secondary" },
};

/** End of the picked day, UTC, as an ISO timestamp for expires_at. */
function expiryDateToIso(value: string): string {
	return new Date(`${value}T23:59:59Z`).toISOString();
}

export default function ApiKeysSettingsRoute() {
	const toastManager = useKumoToastManager();
	const { data: keys, isLoading } = useApiKeys();

	const [createOpen, setCreateOpen] = useState(false);
	const [renameTarget, setRenameTarget] = useState<ApiKey | null>(null);
	const [confirmTarget, setConfirmTarget] = useState<{ key: ApiKey; action: "revoke" | "delete" } | null>(null);

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
				<div className="flex items-center justify-between mb-6">
					<div>
						<h1 className="text-lg font-semibold text-kumo-default">API keys</h1>
						<p className="text-xs text-kumo-subtle mt-0.5">
							Keys authenticate REST API and CLI clients. Anyone with a key can
							access this deployment, so only create them for people and agents
							you trust.{" "}
							<RouterLink
								to="/"
								className="text-kumo-brand hover:underline"
							>
								Back to inbox
							</RouterLink>
						</p>
					</div>
					<Button variant="primary" icon={<PlusIcon size={14} />} onClick={() => setCreateOpen(true)}>
						Create key
					</Button>
				</div>

				{isLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : !keys || keys.keys.length === 0 ? (
					<div className="rounded-lg border border-kumo-line bg-kumo-base">
						<Empty
							title="No API keys"
							description="Create a key to let scripts, agents, or the inbox CLI call the API."
							icon={<KeyIcon size={24} />}
							contents={
								<Button variant="primary" icon={<PlusIcon size={14} />} onClick={() => setCreateOpen(true)}>
									Create key
								</Button>
							}
						/>
					</div>
				) : (
					<ApiKeysTable
						keys={keys.keys}
						onRename={setRenameTarget}
						onConfirm={setConfirmTarget}
					/>
				)}
			</div>

			<CreateKeyDialog
				open={createOpen}
				onOpenChange={(open) => {
					setCreateOpen(open);
				}}
				onCreated={(name) => toastManager.add({ title: `API key "${name}" created` })}
			/>

			<RenameKeyDialog
				target={renameTarget}
				onClose={() => setRenameTarget(null)}
				onRenamed={() => toastManager.add({ title: "API key renamed" })}
			/>

			<ConfirmActionDialog
				target={confirmTarget}
				onClose={() => setConfirmTarget(null)}
				onDone={(action) =>
					toastManager.add({
						title: action === "revoke" ? "API key revoked" : "API key deleted",
					})
				}
				onError={() =>
					toastManager.add({ title: "Action failed", variant: "error" })
				}
			/>
		</div>
	);
}

function ApiKeysTable({
	keys,
	onRename,
	onConfirm,
}: {
	keys: ApiKey[];
	onRename: (key: ApiKey) => void;
	onConfirm: (target: { key: ApiKey; action: "revoke" | "delete" }) => void;
}) {
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base overflow-hidden">
			<Table>
				<Table.Header>
					<Table.Row>
						<Table.Head>Name</Table.Head>
						<Table.Head>Key</Table.Head>
						<Table.Head>Created</Table.Head>
						<Table.Head>Last used</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head aria-label="Actions" />
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{keys.map((key) => {
						const status = keyStatus(key);
						return (
							<Table.Row key={key.id}>
								<Table.Cell>
									<div className="font-medium text-kumo-default">{key.name}</div>
									{key.mailboxes && (
										<div className="text-[11px] text-kumo-subtle mt-0.5">
											{key.mailboxes.length} mailbox{key.mailboxes.length === 1 ? "" : "es"}
										</div>
									)}
								</Table.Cell>
								<Table.Cell>
									<code className="text-xs font-mono text-kumo-subtle">{key.key_prefix}…</code>
								</Table.Cell>
								<Table.Cell>
									<span className="text-xs text-kumo-subtle">{formatListDate(key.created_at)}</span>
								</Table.Cell>
								<Table.Cell>
									<span className="text-xs text-kumo-subtle">
										{key.last_used_at ? formatListDate(key.last_used_at) : "Never"}
									</span>
								</Table.Cell>
								<Table.Cell>
									<Badge variant={STATUS_BADGE[status].variant}>{STATUS_BADGE[status].label}</Badge>
								</Table.Cell>
								<Table.Cell>
									<div className="flex items-center gap-1 justify-end">
										<Button
											variant="ghost"
											shape="square"
											size="sm"
											icon={<PencilSimpleIcon size={14} />}
											onClick={() => onRename(key)}
											aria-label={`Rename ${key.name}`}
										/>
										{status === "active" && (
											<Button
												variant="ghost"
												shape="square"
												size="sm"
												icon={<ProhibitIcon size={14} />}
												onClick={() => onConfirm({ key, action: "revoke" })}
												aria-label={`Revoke ${key.name}`}
											/>
										)}
										<Button
											variant="ghost"
											shape="square"
											size="sm"
											icon={<TrashIcon size={14} />}
											onClick={() => onConfirm({ key, action: "delete" })}
											aria-label={`Delete ${key.name}`}
										/>
									</div>
								</Table.Cell>
							</Table.Row>
						);
					})}
				</Table.Body>
			</Table>
		</div>
	);
}

const SECRET_WARNING =
	"Copy this key now. It is stored hashed and cannot be shown again.";

function CreateKeyDialog({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (name: string) => void;
}) {
	const { data: mailboxes } = useMailboxes();
	const createMutation = useCreateApiKey();

	const [name, setName] = useState("");
	const [expires, setExpires] = useState("");
	const [scope, setScope] = useState<string[]>([]);
	const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);

	const reset = () => {
		setName("");
		setExpires("");
		setScope([]);
		setCreated(null);
	};

	const handleCreate = async () => {
		if (!name.trim()) return;
		try {
			const result = await createMutation.mutateAsync({
				name: name.trim(),
				expires_at: expires ? expiryDateToIso(expires) : null,
				mailboxes: scope.length > 0 ? scope : null,
			});
			setCreated({ name: name.trim(), secret: result.secret });
			onCreated(name.trim());
		} catch {
			// Error handled by the global mutation fallback; keep the dialog open.
		}
	};

	const toggleMailbox = (id: string, checked: boolean) => {
		setScope((prev) => (checked ? [...prev, id] : prev.filter((m) => m !== id)));
	};

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(o) => {
				if (!o) reset();
				onOpenChange(o);
			}}
		>
			<Dialog size="base">
				{created ? (
					<>
						<Dialog.Title>{`Key "${created.name}" created`}</Dialog.Title>
						<Dialog.Description>{SECRET_WARNING}</Dialog.Description>
						<div className="my-4 flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2.5">
							<code className="flex-1 font-mono text-xs text-kumo-default break-all">
								{created.secret}
							</code>
							<CopyButton text={created.secret} />
						</div>
						<div className="flex justify-end">
							<Dialog.Close>
								<Button variant="primary" onClick={reset}>
									Done
								</Button>
							</Dialog.Close>
						</div>
					</>
				) : (
					<>
						<Dialog.Title>Create API key</Dialog.Title>
						<Dialog.Description>
							Keys work on every mailbox unless you restrict them below.
						</Dialog.Description>
						<div className="my-4 space-y-4">
							<Input
								label="Name"
								placeholder="e.g. deploy-agent"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
							<Input
								label="Expires"
								type="date"
								value={expires}
								onChange={(e) => setExpires(e.target.value)}
							/>
							{mailboxes && mailboxes.length > 0 && (
								<div>
									<p className="text-xs font-medium text-kumo-default mb-1.5">
										Restrict to mailboxes (optional)
									</p>
									<div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-kumo-line p-2">
										{mailboxes.map((mailbox) => (
											<Checkbox
												key={mailbox.id}
												label={mailbox.email}
												checked={scope.includes(mailbox.id)}
												onCheckedChange={(checked) => toggleMailbox(mailbox.id, checked)}
											/>
										))}
									</div>
									<p className="text-xs text-kumo-subtle mt-1">
										{scope.length === 0
											? "Leave empty to allow all mailboxes."
											: `The key will only access ${scope.length} selected mailbox${scope.length === 1 ? "" : "es"}.`}
									</p>
								</div>
							)}
						</div>
						<div className="flex justify-end gap-2">
							<Dialog.Close>
								<Button variant="secondary" onClick={reset}>
									Cancel
								</Button>
							</Dialog.Close>
							<Button
								variant="primary"
								loading={createMutation.isPending}
								disabled={!name.trim()}
								onClick={handleCreate}
							>
								Create key
							</Button>
						</div>
					</>
				)}
			</Dialog>
		</Dialog.Root>
	);
}

function RenameKeyDialog({
	target,
	onClose,
	onRenamed,
}: {
	target: ApiKey | null;
	onClose: () => void;
	onRenamed: () => void;
}) {
	const updateMutation = useUpdateApiKey();
	const [name, setName] = useState("");

	const value = target ? (name || target.name) : "";

	const handleRename = async () => {
		if (!target || !value.trim()) return;
		try {
			await updateMutation.mutateAsync({ id: target.id, patchBody: { name: value.trim() } });
			onRenamed();
			setName("");
			onClose();
		} catch {
			// Error handled by the global mutation fallback.
		}
	};

	return (
		<Dialog.Root
			open={target !== null}
			onOpenChange={(o) => {
				if (!o) {
					setName("");
					onClose();
				}
			}}
		>
			<Dialog size="sm">
				<Dialog.Title>Rename API key</Dialog.Title>
				<div className="my-4">
					<Input
						label="Name"
						value={value}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && handleRename()}
					/>
				</div>
				<div className="flex justify-end gap-2">
					<Dialog.Close>
						<Button variant="secondary" onClick={() => setName("")}>
							Cancel
						</Button>
					</Dialog.Close>
					<Button variant="primary" loading={updateMutation.isPending} onClick={handleRename}>
						Save
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

function ConfirmActionDialog({
	target,
	onClose,
	onDone,
	onError,
}: {
	target: { key: ApiKey; action: "revoke" | "delete" } | null;
	onClose: () => void;
	onDone: (action: "revoke" | "delete") => void;
	onError: () => void;
}) {
	const revokeMutation = useRevokeApiKey();
	const deleteMutation = useDeleteApiKey();

	const pending = revokeMutation.isPending || deleteMutation.isPending;

	const isRevoke = target?.action === "revoke";

	const handleConfirm = async () => {
		if (!target) return;
		try {
			if (isRevoke) {
				await revokeMutation.mutateAsync(target.key.id);
			} else {
				await deleteMutation.mutateAsync(target.key.id);
			}
			onDone(target.action);
			onClose();
		} catch {
			onError();
		}
	};

	return (
		<Dialog.Root open={target !== null} onOpenChange={(o) => !o && onClose()} role="alertdialog">
			<Dialog size="sm">
				{target && (
					<>
						<Dialog.Title>
							{isRevoke ? `Revoke "${target.key.name}"?` : `Delete "${target.key.name}"?`}
						</Dialog.Title>
						<Dialog.Description>
							{isRevoke
								? "Requests using this key will stop working immediately. The record stays so you can see why a client broke."
								: "This permanently removes the key record. Requests using it stop working immediately."}
						</Dialog.Description>
						<div className="my-4 flex justify-end gap-2">
							<Dialog.Close>
								<Button variant="secondary">Cancel</Button>
							</Dialog.Close>
							<Button variant="destructive" loading={pending} onClick={handleConfirm}>
								{isRevoke ? "Revoke key" : "Delete key"}
							</Button>
						</div>
					</>
				)}
			</Dialog>
		</Dialog.Root>
	);
}
