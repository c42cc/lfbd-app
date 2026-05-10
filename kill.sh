#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "Killing LFBD processes..."

pids=$(pgrep -f "node server.js" 2>/dev/null || true)

if [ -z "$pids" ]; then
  echo "No running LFBD server found."
else
  echo "$pids" | xargs kill 2>/dev/null
  echo "Stopped LFBD server (PID: $pids)."
fi
