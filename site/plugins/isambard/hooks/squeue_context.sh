#!/bin/bash
# UserPromptSubmit hook: the user's Slurm queue and each running job's latest log line, once per message.
# Stdout becomes context for the assistant. Silent when there is nothing queued, so idle sessions pay nothing.
# One squeue per user message is far inside the cluster's polling etiquette (minimum 60 s between polls from scripts).
command -v squeue >/dev/null 2>&1 || exit 0
Q=$(squeue --me -h -o "%i|%j|%T|%M|%l|%R" 2>/dev/null) || exit 0
[ -z "$Q" ] && exit 0
echo "<slurm-queue>"
echo "job|name|state|elapsed|limit|node_or_reason"
echo "$Q"
while IFS='|' read -r id name state _rest; do
  [ "$state" = "RUNNING" ] || continue
  out=$(scontrol show job "$id" 2>/dev/null | sed -n 's/.*StdOut=\([^ ]*\).*/\1/p' | head -1)
  if [ -n "$out" ] && [ -f "$out" ]; then
    last=$(grep -v '^\s*$' "$out" | tail -n 1 | cut -c1-200)
    printf '%s last: %s\n' "$id" "$last"
  fi
done <<< "$Q"
echo "</slurm-queue>"
