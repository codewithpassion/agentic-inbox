// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useApiKeys() {
	return useQuery({
		queryKey: queryKeys.apiKeys.all,
		queryFn: () => api.getApiKeys(),
	});
}

export function useCreateApiKey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { name: string; expires_at?: string | null; mailboxes?: string[] | null }) =>
			api.createApiKey(input),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
		},
	});
}

export function useUpdateApiKey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			patchBody,
		}: { id: string; patchBody: { name?: string; expires_at?: string | null; mailboxes?: string[] | null } }) =>
			api.updateApiKey(id, patchBody),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
		},
	});
}

export function useRevokeApiKey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.revokeApiKey(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
		},
	});
}

export function useDeleteApiKey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteApiKey(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
		},
	});
}
