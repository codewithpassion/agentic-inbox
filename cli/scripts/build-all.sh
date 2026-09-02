#!/usr/bin/env bash
# Copyright (c) 2026 Cloudflare, Inc.
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
#     https://opensource.org/licenses/Apache-2.0
#
# Compile the inbox CLI for every supported target into cli/bin/.
# Requires Bun 1.2+. Binaries land in cli/bin/ (gitignored).

set -euo pipefail

cd "$(dirname "$0")/.."

TARGETS=(
	bun-linux-x64
	bun-linux-arm64
	bun-darwin-arm64
	bun-darwin-x64
	bun-windows-x64
)

mkdir -p bin
for target in "${TARGETS[@]}"; do
	# bun appends .exe to the output name for windows targets, so the outfile
	# already includes it and the release workflow can mv the exact name.
	out="bin/inbox-${target}"
	if [ "$target" = "bun-windows-x64" ]; then out="bin/inbox-${target}.exe"; fi
	echo "building ${out}"
	bun build ./src/main.ts \
		--compile \
		--target="${target}" \
		--outfile "${out}"
done

echo "done:"
ls -la bin
