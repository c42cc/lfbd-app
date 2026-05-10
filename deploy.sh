#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Deploying LFBD to Fly.io..."
flyctl deploy -a lfbd-app --remote-only

echo ""
echo "Deploy complete. Verifying health..."
sleep 5
if curl -sf https://lfbd.org/health; then
  echo " OK"
else
  echo " FAILED — check 'flyctl logs -a lfbd-app'"
  exit 1
fi
