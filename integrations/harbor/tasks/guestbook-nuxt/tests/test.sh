#!/bin/bash
# Runs the app in Sandburg (packages installed in the browser) with the task's checks, and keeps the
# database they leave behind in the project for the next step. Sandburg itself, not the agent's
# fenced `sandburg`: the task's checks run on this machine, as in the eval.
mkdir -p /logs/verifier
node "$SANDBURG_HOME/bin/sandburg.js" run . --install-in browser --cache "$SANDBURG_HARBOR_CACHE" \
  --checks /tests/checks.ts --out /logs/verifier/sandburg --json \
  --save-files '(^|/)[^/]+\.(db|sqlite3?)(-wal|-shm|-journal)?$' \
  > /logs/verifier/sandburg-result.json 2> /logs/verifier/sandburg.log
node /tests/reward.mjs /logs/verifier/sandburg-result.json /logs/verifier/reward.json
