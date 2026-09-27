#!/usr/bin/env bash
# Installs oai-responses-bridge as a systemd --user service.
#
# Usage:
#   ORB_UPSTREAM_BASE_URL=https://litellm.example.com/v1 \
#   ORB_REASONING_MODELS=gpt-6-sol,gpt-5.6-terra \
#   ORB_API_KEY=sk-... \
#     ./install-systemd-user.sh
#
# This script does not print or log ORB_API_KEY; it writes it straight into a
# chmod-600 EnvironmentFile that only your user can read.
set -euo pipefail

: "${ORB_UPSTREAM_BASE_URL:?set ORB_UPSTREAM_BASE_URL}"
: "${ORB_REASONING_MODELS:?set ORB_REASONING_MODELS (comma-separated model ids)}"
: "${ORB_API_KEY:?set ORB_API_KEY (or edit the generated env file afterwards to use ORB_API_KEY_ENV instead)}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="$(command -v node)"
BRIDGE_ENTRY="${REPO_ROOT}/bin/oai-responses-bridge.js"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/oai-responses-bridge"
ENV_FILE="${CONFIG_DIR}/bridge.env"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="${UNIT_DIR}/oai-responses-bridge.service"

mkdir -p "$CONFIG_DIR" "$UNIT_DIR"

umask 077
cat > "$ENV_FILE" <<EOF
ORB_UPSTREAM_BASE_URL=${ORB_UPSTREAM_BASE_URL}
ORB_REASONING_MODELS=${ORB_REASONING_MODELS}
ORB_API_KEY=${ORB_API_KEY}
ORB_PORT=${ORB_PORT:-4801}
ORB_DEFAULT_REASONING_EFFORT=${ORB_DEFAULT_REASONING_EFFORT:-high}
ORB_LOG_LEVEL=${ORB_LOG_LEVEL:-info}
EOF
chmod 600 "$ENV_FILE"

sed \
  -e "s|@ENV_FILE@|${ENV_FILE}|" \
  -e "s|@NODE_BIN@|${NODE_BIN}|" \
  -e "s|@BRIDGE_ENTRY@|${BRIDGE_ENTRY}|" \
  "${REPO_ROOT}/deploy/systemd/oai-responses-bridge.service.template" > "$UNIT_FILE"

systemctl --user daemon-reload
systemctl --user enable --now oai-responses-bridge.service

echo "installed and started. manage it with:"
echo "  systemctl --user {start|stop|restart|status} oai-responses-bridge.service"
echo "  journalctl --user -u oai-responses-bridge.service -f"
