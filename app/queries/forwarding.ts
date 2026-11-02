// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useForwardRules() {
	return useQuery({
		queryKey: queryKeys.forwarding.all,
		queryFn: () => api.getForwardRules(),
	});
}

export function useCreateForwardRule() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { source: string; destination: string }) => api.createForwardRule(input),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.forwarding.all });
		},
	});
}

export function useDeleteForwardRule() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (source: string) => api.deleteForwardRule(source),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.forwarding.all });
		},
	});
}
