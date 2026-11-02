// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Dialog, Empty, Input, Loader, Table, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowBendUpRightIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { BackButton } from "~/components/BackButton";
import { useCreateForwardRule, useDeleteForwardRule, useForwardRules } from "~/queries/forwarding";
import type { ForwardDestination, ForwardRule } from "~/services/api";

export function meta() {
	return [{ title: "Forwarding | Agentic Inbox" }];
}

const STATUS_BADGE: Record<ForwardRule["destination_status"], { label: string; variant: "success" | "secondary" | "destructive" }> = {
	verified: { label: "Verified", variant: "success" },
	pending: { label: "Waiting for verification", variant: "destructive" },
	unknown: { label: "Check in Cloudflare", variant: "secondary" },
};

export default function ForwardingSettingsRoute() {
	const { data, isLoading } = useForwardRules();
	const [deleteTarget, setDeleteTarget] = useState<ForwardRule | null>(null);

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
				<div className="mb-6 flex items-start gap-2">
					<BackButton />
					<div>
						<h1 className="text-lg font-semibold text-kumo-default">Forwarding</h1>
						<p className="text-xs text-kumo-subtle mt-0.5">
							Send mail for an address on your domains to another inbox. If the
							address also has a mailbox, it keeps a copy.
						</p>
					</div>
				</div>

				<AddRuleForm />

				{isLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : !data || data.rules.length === 0 ? (
					<div className="rounded-lg border border-kumo-line bg-kumo-base">
						<Empty
							title="No forward rules"
							description="Add a rule above to send an address's mail to another inbox."
							icon={<ArrowBendUpRightIcon size={24} />}
						/>
					</div>
				) : (
					<RulesTable rules={data.rules} onDelete={setDeleteTarget} />
				)}

				{data?.rules.some((rule) => rule.destination_status !== "verified") && (
					<p className="text-xs text-kumo-subtle mt-3">
						Cloudflare only delivers to verified destinations. Open the
						verification email it sends to the destination, or check{" "}
						<a
							href="https://dash.cloudflare.com/?to=/:account/email-service/routing"
							target="_blank"
							rel="noreferrer"
							className="text-kumo-brand hover:underline"
						>
							Destination Addresses
						</a>
						. Until then, forwarded mail bounces unless the address has a mailbox.
					</p>
				)}

				{data && data.destinations.length > 0 && <DestinationsTable destinations={data.destinations} />}
			</div>

			<DeleteRuleDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} />
		</div>
	);
}

function AddRuleForm() {
	const toastManager = useKumoToastManager();
	const createMutation = useCreateForwardRule();
	const [source, setSource] = useState("");
	const [destination, setDestination] = useState("");

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault();
		try {
			await createMutation.mutateAsync({ source: source.trim(), destination: destination.trim() });
			setSource("");
			setDestination("");
			toastManager.add({ title: "Forward rule added" });
		} catch (e) {
			toastManager.add({ title: (e as Error).message, variant: "error" });
		}
	};

	return (
		<form
			onSubmit={handleSubmit}
			className="mb-4 flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-base p-5 md:flex-row md:items-end"
		>
			<div className="flex-1">
				<Input
					label="Forward mail for"
					type="email"
					required
					placeholder="you@yourdomain.com"
					value={source}
					onChange={(e) => setSource(e.target.value)}
				/>
			</div>
			<div className="flex-1">
				<Input
					label="Send it to"
					type="email"
					required
					placeholder="you@gmail.com"
					value={destination}
					onChange={(e) => setDestination(e.target.value)}
				/>
			</div>
			<Button type="submit" variant="primary" icon={<PlusIcon size={14} />} loading={createMutation.isPending}>
				Add rule
			</Button>
		</form>
	);
}

function RulesTable({ rules, onDelete }: { rules: ForwardRule[]; onDelete: (rule: ForwardRule) => void }) {
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base overflow-hidden">
			<Table>
				<Table.Header>
					<Table.Row>
						<Table.Head>Forward mail for</Table.Head>
						<Table.Head>Send it to</Table.Head>
						<Table.Head>Destination</Table.Head>
						<Table.Head aria-label="Actions" />
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{rules.map((rule) => {
						const badge = STATUS_BADGE[rule.destination_status];
						return (
							<Table.Row key={rule.source}>
								<Table.Cell>
									<span className="font-medium text-kumo-default">{rule.source}</span>
								</Table.Cell>
								<Table.Cell>{rule.destination}</Table.Cell>
								<Table.Cell>
									<Badge variant={badge.variant}>{badge.label}</Badge>
								</Table.Cell>
								<Table.Cell>
									<div className="flex justify-end">
										<Button
											variant="ghost"
											shape="square"
											size="sm"
											icon={<TrashIcon size={14} />}
											aria-label={`Delete forward rule for ${rule.source}`}
											onClick={() => onDelete(rule)}
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

function DestinationsTable({ destinations }: { destinations: ForwardDestination[] }) {
	return (
		<div className="mt-6">
			<h2 className="text-sm font-semibold text-kumo-default">Destination addresses</h2>
			<p className="text-xs text-kumo-subtle mt-0.5 mb-3">Addresses on your Cloudflare account that can receive forwarded mail.</p>
			<div className="rounded-lg border border-kumo-line bg-kumo-base overflow-hidden">
				<Table>
					<Table.Header>
						<Table.Row>
							<Table.Head>Address</Table.Head>
							<Table.Head>Status</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{destinations.map((destination) => {
							const badge = STATUS_BADGE[destination.status];
							return (
								<Table.Row key={destination.email}>
									<Table.Cell>{destination.email}</Table.Cell>
									<Table.Cell>
										<Badge variant={badge.variant}>{badge.label}</Badge>
									</Table.Cell>
								</Table.Row>
							);
						})}
					</Table.Body>
				</Table>
			</div>
		</div>
	);
}

function DeleteRuleDialog({ target, onClose }: { target: ForwardRule | null; onClose: () => void }) {
	const toastManager = useKumoToastManager();
	const deleteMutation = useDeleteForwardRule();

	const handleConfirm = async () => {
		if (!target) return;
		try {
			await deleteMutation.mutateAsync(target.source);
			toastManager.add({ title: "Forward rule deleted" });
			onClose();
		} catch (e) {
			toastManager.add({ title: (e as Error).message, variant: "error" });
		}
	};

	return (
		<Dialog.Root open={target !== null} onOpenChange={(open) => !open && onClose()} role="alertdialog">
			<Dialog size="sm">
				{target && (
					<>
						<Dialog.Title>Delete the rule for {target.source}?</Dialog.Title>
						<Dialog.Description>
							Mail for this address will stop going to {target.destination}. Unless the
							address has a mailbox, new mail for it will be dropped.
						</Dialog.Description>
						<div className="my-4 flex justify-end gap-2">
							<Dialog.Close>
								<Button variant="secondary">Cancel</Button>
							</Dialog.Close>
							<Button variant="destructive" onClick={handleConfirm} loading={deleteMutation.isPending}>
								Delete rule
							</Button>
						</div>
					</>
				)}
			</Dialog>
		</Dialog.Root>
	);
}
