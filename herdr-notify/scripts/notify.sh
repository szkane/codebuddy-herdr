#!/bin/sh
# Thin wrapper so hooks do not depend on node being on the login shell's PATH.
set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
root=$(dirname "$here") || exit 0

node_bin=
if [ -n "${HERDR_NOTIFY_NODE:-}" ] && [ -f "${HERDR_NOTIFY_NODE}" ] && [ -x "${HERDR_NOTIFY_NODE}" ]; then
  node_bin=${HERDR_NOTIFY_NODE}
fi
if [ -z "$node_bin" ]; then
  node_bin=$(command -v node 2>/dev/null || true)
fi
if [ -z "$node_bin" ]; then
  for candidate in /usr/local/bin/node /usr/bin/node "${HOME:-/nonexistent}"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then
      node_bin=$candidate
      break
    fi
  done
fi

# No node, no notification. Never block CodeBuddy.
[ -n "$node_bin" ] || exit 0

# A hook must always exit 0, even when node itself fails.
"$node_bin" "$root/index.js" "$@" 2>/dev/null || exit 0
exit 0
