#!/usr/bin/env bash
# Copyright (c) 2026 Cloudflare, Inc.
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
#     https://opensource.org/licenses/Apache-2.0
#
# Install the `inbox` CLI from a GitHub Release.
#
#   curl -fsSL <repo-url>/install.sh | bash -s -- [version]
#
# With no arguments the latest release is used. The binary is dropped in
# ~/.local/bin (override with INBOX_INSTALL_DIR).

set -euo pipefail

REPO="${INBOX_REPO:-cloudflare/agentic-inbox}"
VERSION="${1:-latest}"
INSTALL_DIR="${INBOX_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)-$(uname -m)" in
	Linux-x86_64) ASSET="inbox-linux-x64" ;;
	Linux-aarch64 | Linux-arm64) ASSET="inbox-linux-arm64" ;;
	Darwin-arm64) ASSET="inbox-darwin-arm64" ;;
	Darwin-x86_64) ASSET="inbox-darwin-x64" ;;
	*)
		echo "error: unsupported platform $(uname -s)-$(uname -m)." >&2
		echo "On Windows, download inbox-windows-x64.exe from the release page." >&2
		exit 1
		;;
esac

if [ "$VERSION" = "latest" ]; then
	URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
	URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
fi

mkdir -p "$INSTALL_DIR"
echo "downloading ${URL}"
curl -fsSL "$URL" -o "$INSTALL_DIR/inbox"
chmod +x "$INSTALL_DIR/inbox"

echo "installed: $INSTALL_DIR/inbox"
echo "make sure $INSTALL_DIR is on your PATH, then run: inbox auth login"
