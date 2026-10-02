// Slurm queue on Isambard: one line above the prompt while jobs are queued,
// /queue for the full table, a toast when a job starts or leaves the queue,
// and a few lines of queue state beside each prompt for the model.
// Replaces squeue_context.sh (UserPromptSubmit), which put the whole queue into
// every message: 18-32 KB per prompt on a 328-task array (2026-10-02).
// A group that leaves the queue is told to the model once, on its next prompt: counts, last error line, experiment-loop hint.
// Option wake=on: a job this session submitted wakes the model with that line instead (one prompt per ended job).
// Inert where squeue is missing: no timer, no command, no band, no context.
import type { EngineInterface, Register, Timer } from 'claude-code'

const FIELDS = '%F|%K|%i|%j|%T|%M|%L|%R'
const BUSY_MS = 60_000 // the cluster's minimum interval between scripted polls
const IDLE_MS = 300_000 // empty queue, or Slurm not answering
const MIN_GAP_MS = 15_000 // a poke after sbatch never polls closer than this
const FIRST_POLL_WAIT_MS = 3000 // how long the first prompt of a session waits for the first poll
const LOG_GROUPS = 4 // groups whose newest log line is read on each poll
const TUNNEL_WARN_S = 30 * 60
const ERROR_LINE = /Traceback|Error|Killed|OutOfMemory|TIMEOUT|CANCELLED/ // same pattern as slurm-watch/scripts/job_status.sh
const FAILED_STATE = /^(failed|timeout|out_of_memory|node_fail|boot_fail|deadline)$/
const ENDED_MAX = 8 // ended lines one prompt carries
const PANE = 'slurm'
const SUBMITS = /\b(sbatch|scancel|srun|salloc)\b|\bscontrol\s+(hold|release|requeue)\b/

export type Row = { arrayId: string; task: string; id: string; name: string; state: string; elapsed: string; left: string; where: string }

export type Group = {
  key: string // the array job id, or the job id
  name: string
  isArray: boolean
  running: number
  pending: number // tasks, with pending ranges counted out
  other: number // completing, suspended, configuring
  reason: string // why the first pending task waits
  where: string // the node of a lone running job
  elapsed: string // of a lone job
  leftS: number // least time left among running tasks; -1 unknown
  runningIds: string[]
  logId?: string // the running task whose log stands for the group
  log?: string
}

/** Rows of `squeue -h -o FIELDS`; lines that do not split into eight fields are dropped. */
export function parseRows(stdout: string): Row[] {
  const rows: Row[] = []
  for (const line of stdout.split('\n')) {
    const f = line.trim().split('|')
    if (f.length !== 8) continue
    const [arrayId, task, id, name, state, elapsed, left, where] = f as [string, string, string, string, string, string, string, string]
    rows.push({ arrayId, task, id, name, state, elapsed, left, where })
  }
  return rows
}

/** Tasks in an array index expression: `292-328`, `[1-5,7,10-20:2]%4`; 1 for a plain job. */
export function taskCount(task: string): number {
  const body = task.replace(/^\[|\]?(%\d+)?$/g, '').replace(/\]$/, '')
  if (!body || body === 'N/A') return 1
  let n = 0
  for (const part of body.split(',')) {
    const m = /^(\d+)(?:-(\d+)(?::(\d+))?)?$/.exec(part.trim())
    if (!m) { n += 1; continue }
    const [, a, b, step] = m
    n += b === undefined ? 1 : Math.floor((Number(b) - Number(a)) / Number(step ?? 1)) + 1
  }
  return Math.max(1, n)
}

/** Seconds in a Slurm duration (`1-02:03:04`, `4:00:00`, `0:07`); -1 for UNLIMITED and the like. */
export function seconds(t: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t.trim())
  if (!m) return -1
  const [, d, h, mi, s] = m
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(s)
}

/** A duration for a narrow line: 2d4h, 16h29m, 29m, 40s. */
export function span(s: number): string {
  if (s < 0) return '?'
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d${h}h`
  if (h) return `${h}h${String(m).padStart(2, '0')}m`
  return m ? `${m}m` : `${s}s`
}

/** One group per job or job array, running ones first. */
export function collapse(rows: Row[]): Group[] {
  const byKey = new Map<string, Group>()
  for (const r of rows) {
    const key = r.arrayId || r.id
    let g = byKey.get(key)
    if (!g) {
      g = { key, name: r.name, isArray: false, running: 0, pending: 0, other: 0, reason: '', where: '', elapsed: '', leftS: -1, runningIds: [] }
      byKey.set(key, g)
    }
    if (r.task && r.task !== 'N/A') g.isArray = true
    if (r.state === 'RUNNING') {
      g.running += 1
      g.runningIds.push(r.id)
      g.where = r.where
      g.elapsed = r.elapsed
      const left = seconds(r.left)
      if (left >= 0 && (g.leftS < 0 || left < g.leftS)) g.leftS = left
    } else if (r.state === 'PENDING') {
      g.pending += taskCount(r.task)
      if (!g.reason) g.reason = r.where.replace(/^\(|\)$/g, '')
    } else {
      g.other += 1
    }
  }
  return [...byKey.values()].sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || a.key.localeCompare(b.key))
}

/** One group in words, for the model and the pane. */
export function describe(g: Group): string {
  const reason = g.reason ? ` (${g.reason})` : ''
  if (g.isArray) {
    const parts = [g.running && `${g.running} running`, g.pending && `${g.pending} pending${reason}`, g.other && `${g.other} other`].filter(Boolean)
    return `${g.name} (array ${g.key}): ${parts.join(', ')}${g.running ? `, ${span(g.leftS)} left at least` : ''}`
  }
  if (g.running) return `${g.name} (${g.key}): running ${g.elapsed}, ${span(g.leftS)} left, ${g.where}`
  if (g.pending) return `${g.name} (${g.key}): pending${reason}`
  return `${g.name} (${g.key}): ${g.other ? 'completing' : 'unknown state'}`
}

// module state; a reload starts it over and the first poll fills it again
let tunnelName = 'code_tunnel'
let contextOn = true
let user = ''
let hasSlurm: boolean | undefined
let groups: Group[] = []
let polledAt = 0 // last poll that answered
let triedAt = 0 // last poll attempted
let failures = 0
let lastError = ''
let primed = false // no toast before the first answer sets the baseline
let modelSawJobs = false
let inflight: Promise<void> | undefined
let timer: Timer | undefined
let tunnelWarned = ''
const logPath = new Map<string, string>()
const groupLog = new Map<string, string>() // group key -> a running task's log path, kept until the group's end is told
let wakeOn = false
const ownJobs = new Map<string, { at: number; seen: boolean }>() // job ids this session's main loop submitted (wake only)
let endedLines: string[] = [] // told to the model on its next prompt, then forgotten

type AcctRow = { id: string; state: string; out: string; name: string; raw: string; user: string; workDir: string; comment: string }
type EndedInfo = { counts: Map<string, number>; first?: AcctRow; failed?: AcctRow; isArray: boolean }

async function run($: EngineInterface, argv: string[], timeoutMs = 30_000) {
  return $.process.run(argv, { timeoutMs })
}

async function probe($: EngineInterface) {
  if (hasSlurm !== undefined) return hasSlurm
  try {
    const found = await run($, ['sh', '-c', 'command -v squeue'], 5000)
    const me = await run($, ['id', '-un'], 5000)
    user = me.stdout.trim()
    hasSlurm = found.exitCode === 0 && found.stdout.trim() !== '' && user !== ''
  } catch {
    hasSlurm = false
  }
  return hasSlurm
}

function schedule($: EngineInterface, ms: number) {
  timer?.cancel()
  timer = $.clock.after(ms, () => { void poll($) })
}

/** The newest non-empty line of each running group's log, a few groups per poll. */
async function readLogs($: EngineInterface, next: Group[], before: Group[]) {
  const live = new Set(next.flatMap(g => g.runningIds))
  for (const id of logPath.keys()) if (!live.has(id)) logPath.delete(id)
  for (const g of next.filter(x => x.running && x.name !== tunnelName).slice(0, LOG_GROUPS)) {
    const prev = before.find(x => x.key === g.key)
    g.logId = prev?.logId && g.runningIds.includes(prev.logId) ? prev.logId : g.runningIds[0]
    if (!g.logId) continue
    try {
      let path = logPath.get(g.logId)
      if (!path) {
        const shown = await run($, ['scontrol', 'show', 'job', g.logId], 10_000)
        path = /StdOut=(\S+)/.exec(shown.stdout)?.[1] ?? ''
        if (path) logPath.set(g.logId, path)
      }
      if (!path) continue
      groupLog.set(g.key, path) // announce needs it after the task is gone from logPath
      const tail = await run($, ['tail', '-n', '50', path], 10_000)
      const line = tail.stdout.split('\n').map(s => s.trim()).filter(Boolean).pop()
      if (line) g.log = line.slice(0, 200)
    } catch {
      // a log that cannot be read leaves the group without one
    }
  }
}

function blankGroup(key: string): Group {
  return { key, name: '', isArray: false, running: 0, pending: 0, other: 0, reason: '', where: '', elapsed: '', leftS: -1, runningIds: [] }
}

/** A StdOut pattern as sacct prints it, with %A %a %j %x %u %% expanded as job_status.sh does; a relative path starts at WorkDir. */
export function expandLogPattern(pattern: string, row: { id: string; name: string; raw: string; user: string; workDir: string }): string {
  const [master = '', task = ''] = row.id.split('_')
  const out = pattern
    .replace(/%%/g, () => '\u0001')
    .replace(/%A/g, () => master)
    .replace(/%a/g, () => task)
    .replace(/%j/g, () => row.raw)
    .replace(/%x/g, () => row.name)
    .replace(/%u/g, () => row.user)
    .replace(/\u0001/g, () => '%')
  return out && !out.startsWith('/') && row.workDir ? `${row.workDir}/${out}` : out
}

/** The last error-looking line among the final 200 of a log; never reads the whole file. */
async function lastErrorLine($: EngineInterface, path: string) {
  const tail = await run($, ['tail', '-n', '200', path], 10_000)
  if (tail.exitCode !== 0) return ''
  return (tail.stdout.split('\n').map(s => s.trim()).filter(s => ERROR_LINE.test(s)).pop() ?? '').slice(0, 160)
}

/** The nearest folder, at or above a candidate, whose PLAN.md opens with a YAML frontmatter (experiment-loop); '' if none. */
async function planFolder($: EngineInterface, candidates: string[]) {
  const script = 'd="$1"; for i in 1 2 3 4 5; do [ "$(head -c 3 "$d/PLAN.md" 2>/dev/null)" = --- ] && { echo "$d"; exit 0; }; d=$(dirname "$d"); done; exit 1'
  for (const dir of candidates) {
    if (!dir.startsWith('/')) continue
    const found = await run($, ['sh', '-c', script, 'plan-folder', dir], 5000)
    if (found.exitCode === 0 && found.stdout.trim()) return found.stdout.trim()
  }
  return ''
}

/** "ended: name (array 123): 324 completed, 5 failed; last error: ...; experiment-loop: ..." for one group that left the queue. */
async function endedLine($: EngineInterface, g: Group, how: string, inf: EndedInfo | undefined) {
  let line = `ended: ${g.name || g.key} (${g.isArray ? 'array ' : ''}${g.key}): ${how}`
  try {
    const failed = inf?.failed
    if (failed) {
      const path = failed.out ? expandLogPattern(failed.out, failed) : groupLog.get(g.key) ?? ''
      const error = path ? await lastErrorLine($, path) : ''
      if (error) line += `; last error: ${error}`
    }
    const row = failed ?? inf?.first
    if (row) {
      const path = row.out ? expandLogPattern(row.out, row) : groupLog.get(g.key) ?? ''
      const candidates = [path.slice(0, path.lastIndexOf('/')), row.workDir]
      if (row.comment) candidates.unshift(row.comment.startsWith('/') ? row.comment : `${row.workDir}/${row.comment}`)
      const folder = await planFolder($, candidates)
      if (folder) line += `; experiment-loop: verify, write result.json, run aggregate_runs.py for ${folder}`
    }
  } catch {
    // a log or folder that cannot be read leaves the plain line
  }
  return line
}

/** Tell the model an own job ended, as a prompt of its own once the session is idle; falls back to the next prompt. */
function wake($: EngineInterface, line: string) {
  const later = () => { if (contextOn) endedLines.push(line) }
  void $.prompt.submit({ text: `${line}\nThis is a job you submitted; read its result and carry on.` }).then(sent => { if (sent.drop !== undefined) later() }, later)
}

/** What the model reads beside the next prompt about groups that ended since the last one, then they are forgotten. */
export function endedText(): string {
  if (!endedLines.length) return ''
  const all = endedLines
  endedLines = []
  const more = all.length > ENDED_MAX ? `\n(+${all.length - ENDED_MAX} more ended)` : ''
  return `<slurm-ended>\n${all.slice(0, ENDED_MAX).join('\n')}${more}\n</slurm-ended>`
}

/** Toasts for what changed between two answers: a start, an end, a tunnel running out. */
async function announce($: EngineInterface, before: Group[], after: Group[]) {
  for (const g of after) {
    const prev = before.find(x => x.key === g.key)
    if (g.running && (!prev || !prev.running) && g.name !== tunnelName) {
      $.ui.toast(`slurm: ${g.name} started${g.isArray ? `, ${g.running} running` : ''}`)
    }
    if (g.name === tunnelName && g.running && g.leftS >= 0 && g.leftS <= TUNNEL_WARN_S && tunnelWarned !== g.key) {
      tunnelWarned = g.key
      $.ui.toast(`slurm: ${tunnelName} has ${span(g.leftS)} left`, { timeoutMs: 10_000 })
    }
  }
  const gone = before.filter(g => !after.some(x => x.key === g.key))
  // wake: an own job that ended before any poll saw it (a crash seconds after sbatch) is gone too
  for (const g of after) {
    const own = ownJobs.get(g.key)
    if (own) own.seen = true
  }
  for (const [id, own] of ownJobs) {
    if (!own.seen && own.at < triedAt && !after.some(x => x.key === id) && !gone.some(x => x.key === id)) gone.push(blankGroup(id))
  }
  if (!gone.length) return
  // const states = new Map<string, Map<string, number>>()  (counts only; the log path, name and folder are needed now)
  const info = new Map<string, EndedInfo>()
  try {
    // const acct = await run($, ['sacct', '-n', '-P', '-X', '-j', gone.map(g => g.key).join(','), '-o', 'JobID,State'], 20_000)
    const acct = await run($, ['sacct', '-n', '-P', '-X', '-j', gone.map(g => g.key).join(','), '-o', 'JobID,State,StdOut,JobName,JobIDRaw,User,WorkDir,Comment'], 20_000)
    for (const line of acct.stdout.split('\n')) {
      const [id, state, out = '', name = '', raw = '', who = '', workDir = '', comment = ''] = line.trim().split('|')
      if (!id || !state) continue
      const key = id.split('_')[0]!
      const word = state.split(' ')[0]!.toLowerCase()
      const row: AcctRow = { id, state: word, out, name, raw, user: who, workDir, comment }
      const entry = info.get(key) ?? { counts: new Map<string, number>(), isArray: false }
      entry.counts.set(word, (entry.counts.get(word) ?? 0) + 1)
      entry.first ??= row
      if (!entry.failed && FAILED_STATE.test(word)) entry.failed = row
      if (id.includes('_')) entry.isArray = true
      info.set(key, entry)
    }
  } catch {
    // no sacct: the toast says only that the job left the queue
  }
  for (const g of gone) {
    const inf = info.get(g.key)
    if (inf?.isArray) g.isArray = true
    if (!g.name && inf?.first) g.name = inf.first.name
    const counts = inf?.counts
    const how = counts ? [...counts].map(([w, n]) => (g.isArray ? `${n} ${w}` : w)).join(', ') : 'left the queue'
    // $.ui.toast(`slurm: ${g.name} ${g.isArray ? `finished: ${how}` : how}`, { timeoutMs: 8000 })  (a job gone before any poll has no name yet)
    $.ui.toast(`slurm: ${g.name || g.key} ${g.isArray ? `finished: ${how}` : how}`, { timeoutMs: 8000 })
    if (g.name === tunnelName) continue // the tunnel has its toast; the model has no use for it
    const line = await endedLine($, g, how, inf)
    if (wakeOn && ownJobs.has(g.key)) {
      ownJobs.delete(g.key) // at most one wake per ended job
      wake($, line)
    } else if (contextOn) {
      endedLines.push(line)
    }
    groupLog.delete(g.key)
  }
}

/** One poll at a time: a call while one runs waits for that one's answer. */
function poll($: EngineInterface): Promise<void> {
  inflight ??= pollOnce($).finally(() => { inflight = undefined })
  return inflight
}

async function pollOnce($: EngineInterface) {
  if (!(await probe($))) return
  triedAt = await $.clock.now()
  try {
    const r = await run($, ['squeue', '-h', '-u', user, '-o', FIELDS])
    if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `squeue exited ${r.exitCode}`)
    const next = collapse(parseRows(r.stdout))
    await readLogs($, next, groups)
    if (primed) await announce($, groups, next)
    groups = next
    polledAt = triedAt
    failures = 0
    primed = true
  } catch (err) {
    failures += 1
    lastError = err instanceof Error ? err.message : String(err)
  } finally {
    $.ui.invalidate('ui.render')
    schedule($, !failures && groups.length ? BUSY_MS : IDLE_MS)
  }
}

function age(now: number) {
  return span(Math.max(0, Math.round((now - polledAt) / 1000)))
}

/** What the model reads beside a prompt: the queue in a few lines, once "empty" after it drains, else nothing. */
export function contextText(now: number): string {
  if (!primed) return ''
  if (!groups.length) {
    if (!modelSawJobs) return ''
    modelSawJobs = false
    return `<slurm-queue>empty as of ${age(now)} ago</slurm-queue>`
  }
  modelSawJobs = true
  const stale = failures ? ` stale="squeue failing: ${lastError.slice(0, 80)}"` : ''
  const lines = groups.map(g => describe(g) + (g.log ? `\n  last log line: ${g.log}` : ''))
  return `<slurm-queue as-of="${age(now)} ago"${stale}>\n${lines.join('\n')}\n</slurm-queue>`
}

export const register: Register = (on, options) => {
  tunnelName = String(options.tunnelName ?? 'code_tunnel').trim() || 'code_tunnel'
  contextOn = String(options.context ?? 'on') !== 'off'
  wakeOn = String(options.wake ?? 'off') === 'on'

  on('session.start', async ($, e, next) => {
    if (await probe($)) {
      void poll($) // first, so a refused command name cannot stop the polling
      try {
        // not /slurm: the plugin's own slurm skill owns that name and the engine refuses it
        await $.command.register({ name: 'queue', description: 'Show the Slurm queue in a pane; /queue refresh polls now and prints it' })
      } catch {
        // the band and the context work without the command
      }
    }
    return next(e)
  })

  on('command.run', { command: 'queue' }, async ($, e, next) => {
    if (!(await probe($))) return next(e)
    const now = await $.clock.now()
    if (e.args.trim() === 'refresh' || now - triedAt > MIN_GAP_MS) await poll($)
    if (e.args.trim() === 'refresh') {
      return { text: groups.length ? groups.map(describe).join('\n') : failures ? `squeue failing: ${lastError}` : 'No jobs in the queue.' }
    }
    await $.ui.open({ id: PANE, title: 'Slurm queue' })
    return { text: 'Slurm queue pane opened.' }
  })

  // the model's sbatch or scancel: look again soon instead of in a minute
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    // if (hasSlurm && SUBMITS.test(String(e.command ?? ''))) {  (also fired after a denied or errored call)
    if (hasSlurm && ran.deny === undefined && !ran.isError && SUBMITS.test(String(e.command ?? ''))) {
      const now = await $.clock.now()
      // wake: remember jobs the main loop submitted; a subagent's jobs are left to its own report
      if (wakeOn && !e.agentId) {
        const out = String((ran.result as { stdout?: unknown } | undefined)?.stdout ?? ran.text ?? '')
        for (const m of out.matchAll(/Submitted batch job (\d+)/g)) ownJobs.set(m[1]!, { at: now, seen: false })
      }
      schedule($, Math.max(3000, MIN_GAP_MS - (now - triedAt)))
    }
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (!contextOn || !hasSlurm) return next(e)
    // a prompt typed right after start waits briefly for the first answer
    if (!primed && inflight) await Promise.race([inflight, $.clock.sleep(FIRST_POLL_WAIT_MS)])
    // the mod's own wake prompt already carries its ended line
    if (e.origin?.kind === 'plugin' && e.origin.name === $.plugin.name) return next(e)
    // const text = contextText(await $.clock.now())
    // return text ? next({ ...e, context: [...(e.context ?? []), text] }) : next(e)
    const added = [contextText(await $.clock.now()), endedText()].filter(Boolean)
    return added.length ? next({ ...e, context: [...(e.context ?? []), ...added] }) : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const jobs = groups.filter(g => g.name !== tunnelName)
    const tunnel = groups.find(g => g.name === tunnelName && g.running)
    if (!hasSlurm || e.props.hasSurvey || e.props.maxRows < 1 || (!jobs.length && !tunnel)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const shown = jobs.slice(0, 3)
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="#7DC4FF" bold>slurm</Text>
        {shown.map(g => (
          <Text>
            <Text color={g.running ? '#5FD17A' : '#E0B050'}>{g.name}</Text>
            {g.isArray
              ? ` ${g.running ? `${g.running} run` : ''}${g.running && g.pending ? ' · ' : ''}${g.pending ? `${g.pending} wait` : ''}`
              : g.running ? ` ${span(seconds(g.elapsed))} · ${span(g.leftS)} left` : ` wait${g.reason ? ` (${g.reason})` : ''}`}
          </Text>
        ))}
        {jobs.length > shown.length && <Text dimColor>+{jobs.length - shown.length} more · /queue</Text>}
        {tunnel && <Text color={tunnel.leftS >= 0 && tunnel.leftS <= TUNNEL_WARN_S ? '#FFD34E' : '#8A94AB'}>│ tunnel {span(tunnel.leftS)} left</Text>}
        {failures > 0 && <Text dimColor>· as of {age(now)} ago, squeue failing</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    return (
      <Box flexDirection="column">
        {!groups.length && <Text dimColor>{failures ? `squeue failing: ${lastError}` : 'No jobs in the queue.'}</Text>}
        {groups.map(g => (
          <Box flexDirection="column">
            <Text color={g.running ? '#5FD17A' : '#E0B050'}>{describe(g)}</Text>
            {g.log && <Text dimColor>  {g.log}</Text>}
          </Box>
        ))}
        <Text dimColor>as of {age(now)} ago · next look in {groups.length && !failures ? '1 min' : '5 min'} · /queue refresh</Text>
      </Box>
    )
  })
}
