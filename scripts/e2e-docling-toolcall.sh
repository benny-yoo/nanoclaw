#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${ROOT_DIR}/.host.log"

PROMPT=${1:-"Analyze this PDF and reply with one-sentence summary: https://arxiv.org/pdf/1706.03762.pdf"}

cd "${ROOT_DIR}"

if [[ ! -f "${LOG_FILE}" ]]; then
  echo "missing ${LOG_FILE}"
  exit 1
fi

BEFORE_LINES=$(wc -l < "${LOG_FILE}" | tr -d ' ')

echo "[e2e] sending prompt via CLI channel..."
pnpm run chat "${PROMPT}" >/tmp/nanoclaw-e2e-docling.out 2>/tmp/nanoclaw-e2e-docling.err || {
  echo "chat command failed"
  cat /tmp/nanoclaw-e2e-docling.err || true
  exit 1
}

echo "[e2e] waiting for provider/tool logs..."
sleep 3

after_lines=$(wc -l < "${LOG_FILE}" | tr -d ' ')
if [[ "${after_lines}" -lt "${BEFORE_LINES}" ]]; then
  BEFORE_LINES=0
fi

TAIL_LOG=$(tail -n "$((after_lines - BEFORE_LINES + 200))" "${LOG_FILE}")

echo "[e2e] checking docling tool-call logs..."
if echo "${TAIL_LOG}" | rg -q "openai-provider.*Tool call requested: docling:"; then
  echo "PASS: docling tool call log detected"
  exit 0
fi

echo "FAIL: docling tool call log not detected"
echo "----- recent .host.log -----"
echo "${TAIL_LOG}" | tail -n 120
exit 2
