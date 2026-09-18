---
name: slurm-watch
description: Use when a Slurm job has just been submitted or is running for hours (training, evaluation arrays, sweeps) and its result decides what happens next — including when the user asks what a job is doing, whether it finished, or why nothing was reported after it ended.
---

# Watching a Slurm job to its read point

## Overview

A submitted job is a promise to read a result later, so the watch is armed **in the same turn as the
`sbatch`**, never left for the user to prompt. It reports at exactly two moments, the read point and the
job's end, and is silent otherwise.

## Core pattern

1. **Fix the read point first, in the job's own log, in the right unit.** A step count is comparable only
   if a step is the same amount of work as in the run it is compared with; when the recipe changed the
   samples per step, convert through samples. If the converted point falls between two logged records, take
   the **later** one: a kill rule must never fire before the job has had equal training.
2. **Fix the reference with the same statistic.** A median of per-record ratios and a ratio of window sums
   are different numbers from the same log. Name the statistic and compute both sides with the same code
   (`scripts/job_status.sh --ratio` prints the windowed ratio of sums).
3. **Pick the waiting tool by distance to the read point.** Under 30 minutes: `Monitor`, one line per new
   record, one line on any terminal state, then exit. Longer: `/loop` at an interval matched to the log's
   cadence, with a prompt that reports only at the read point or the job's end. Never a foreground `sleep`
   loop; never poll the scheduler more often than every 60 s.
4. **Cover every terminal state.** The wake command checks `squeue`; when the job is gone it prints
   `sacct`'s state and greps the stdout log for `Traceback|Error|Killed|OutOfMemory|TIMEOUT`. Silence must
   never look like "still running". **Save the stdout path when arming** — `scontrol show job` stops
   returning it once the job has left the queue.
5. **On the read, evaluate in the same turn:** compute the number, compare with the reference, apply the
   kill rule written down in advance, act. "It finished" without the number is not a read.

## Example

```
# read point step 3750 (= 120k samples = the old run's step 15000 at 8/step); the log moves every ~13 min
# and the read is ~8 h away -> /loop 15m. Reference: window sum/sum 0.83; kill if >= 0.80.
scontrol show job 6679374 | sed -n 's/.*StdOut=\([^ ]*\).*/\1/p' > .watch/6679374.stdout
scripts/job_status.sh 6679374 --log checkpoints/<tag>/train_log.jsonl --ratio loss base --window 2000
```

## Common mistakes

| Mistake | Cost |
| --- | --- |
| Submitting and moving on | the user finds the finished job hours later and asks what it was |
| Read point in steps after the samples per step changed | 15,000 of one thing against 15,000 of another |
| Reference a median, read a mean | a 0.72 that was really 0.83; the kill rule fires for the wrong reason |
| Grepping only for the success line | a crashloop looks like "still running" |
| Re-arming a 30-minute Monitor across an 8-hour wait | sixteen re-arms, one missed |
| Fetching the stdout path after the job is gone | nothing to grep on failure |

## Quick reference

`squeue -h -j <id> -o %T` — empty means gone; then `sacct -j <id> -X --format=State -n`.
`scripts/job_status.sh <id> [--log <jsonl>] [--ratio <num> <den>] [--window <steps>]` — state, latest record,
windowed ratio; exit 10 once the job has ended, so a wake loop can stop on it.
