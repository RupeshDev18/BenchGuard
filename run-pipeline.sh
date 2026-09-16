#!/usr/bin/env bash
# ===================================================================
# run-pipeline.sh - Bash Runner for k6 & Allure Performance Suite
# ===================================================================

set -euo pipefail

CONFIG="${1:-config.json}"
echo "Starting performance pipeline with config: $CONFIG"
node run-pipeline.js --config "$CONFIG"
