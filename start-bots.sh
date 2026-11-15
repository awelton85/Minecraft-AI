#!/usr/bin/env bash
# Runs the bots; restarts after 5 s if they crash (non-zero exit). Ctrl+C to stop.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install version 20 or newer from https://nodejs.org/" >&2
  exit 1
fi
NODE_MAJOR=$(node -p "parseInt(process.versions.node)")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js $NODE_MAJOR is too old - version 20 or newer is required (https://nodejs.org/)." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "node_modules not found - running npm install ..."
  npm install || { echo "npm install failed" >&2; exit 1; }
fi

trap 'echo; echo "Stopped."; exit 130' INT TERM
while true; do
  node src/index.js
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "Bots exited normally."
    exit 0
  fi
  echo "[$(date '+%F %T')] Bots stopped with exit code $code. Restarting in 5 seconds ... (Ctrl+C to stop)"
  sleep 5
done
