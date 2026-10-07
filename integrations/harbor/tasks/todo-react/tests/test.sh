#!/bin/bash
# Runs the app in Sandburg (packages installed in the browser) with the task's checks.
mkdir -p /logs/verifier
sandburg run . --install-in browser --checks /tests/checks.ts --out /logs/verifier/sandburg --json \
  > /logs/verifier/sandburg-result.json 2> /logs/verifier/sandburg.log
node /tests/reward.mjs /logs/verifier/sandburg-result.json /logs/verifier/reward.json
