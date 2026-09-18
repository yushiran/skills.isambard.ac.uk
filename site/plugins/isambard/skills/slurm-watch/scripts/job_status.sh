#!/bin/bash
# One line of Slurm state for a job, the latest record of its jsonl log, and optionally a windowed ratio of two
# fields summed over the last N steps. Exits 0 while the job runs, 10 when it has ended (so a wake loop can stop).
#
#   job_status.sh <jobid> [--log <train_log.jsonl>] [--ratio <numerator> <denominator>] [--window <steps>]
#
# The ratio is sum(num)/sum(den) over records within --window steps of the latest, which is the statistic that
# stays comparable when a run logs means over several sub-batches per record; a median of per-record ratios is not.
set -u
ID=${1:?job id}; shift
LOG=""; NUM=""; DEN=""; WIN=2000
while [ $# -gt 0 ]; do
  case "$1" in
    --log) LOG=$2; shift 2;;
    --ratio) NUM=$2; DEN=$3; shift 3;;
    --window) WIN=$2; shift 2;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
ST=$(squeue -h -j "$ID" -o '%T|%M' 2>/dev/null | head -1)
if [ -z "$ST" ]; then
  FINAL=$(sacct -j "$ID" -X --format=State,Elapsed -n 2>/dev/null | head -1 | tr -s ' ')
  echo "job $ID ENDED: ${FINAL:-unknown}"
  OUT=$(sacct -j "$ID" -X --format=StdOut -n 2>/dev/null | tr -d ' ' | head -1)
  [ -n "$OUT" ] && [ -f "$OUT" ] && grep -E 'Traceback|Error|Killed|OutOfMemory|TIMEOUT|CANCELLED' "$OUT" | tail -3
  CODE=10
else
  echo "job $ID $ST"
  CODE=0
fi
if [ -n "$LOG" ] && [ -f "$LOG" ]; then
  python3 - "$LOG" "$NUM" "$DEN" "$WIN" <<'PY'
import sys, json
log, num, den, win = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
rows = [json.loads(l) for l in open(log) if l.strip()]
if not rows:
    print("log is empty"); sys.exit(0)
last = rows[-1]
print("latest:", json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in last.items() if k != "val_psnr"}))
if num and den:
    step = max(r.get("step", 0) for r in rows)
    w = [r for r in rows if num in r and r.get(den) and r.get("step", 0) > step - win]
    if w:
        print(f"window sum({num})/sum({den}) over last {win} steps ({len(w)} records): "
              f"{sum(r[num] for r in w) / sum(r[den] for r in w):.3f}")
PY
fi
exit $CODE
