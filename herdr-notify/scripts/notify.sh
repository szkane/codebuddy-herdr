#!/bin/sh
# Thin wrapper so hooks do not depend on node being on the login shell's PATH.
set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname "$here")

node_bin=${HERDR_NOTIFY_NODE:-}
if [ -z "$node_bin" ]; then
  node_bin=$(command -v node 2>/dev/null || true)
fi
if [ -z "$node_bin" ]; then
  for candidate in /usr/local/bin/node /usr/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then
      node_bin=$candidate
      break
    fi
  done
fi

# No node, no notification. Never block CodeBuddy.
[ -n "$node_bin" ] || exit 0

exec "$node_bin" "$root/index.js" "$@"
