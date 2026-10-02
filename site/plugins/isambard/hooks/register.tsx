// Slurm queue on Isambard: one line above the prompt while jobs are queued,
// /slurm for the full table, a toast when a job starts or leaves the queue,
// and a few lines of queue state beside each prompt for the model.
// Replaces squeue_context.sh (UserPromptSubmit), which put the whole queue into
// every message: 18-32 KB per prompt on a 328-task array (2026-10-02).
// Inert where squeue is missing: no timer, no command, no band, no context.
import type { EngineInterface, Register, Timer } from 'claude-code'

const FIELDS = '%F|%K|%i|%j|%T|%M|%L|%R'
const BUSY_MS = 60_000 // the cluster's minimum interval between scripted polls
const IDLE_MS = 300_000 // empty queue, or Slurm not answering
const MIN_GAP_MS = 15_000 // a poke after sbatch never polls closer than this
const LOG_GROUPS = 4 // groups whose newest log line is read on each poll
const TUNNEL_WARN_S = 30 * 60
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
      const tail = await run($, ['tail', '-n', '50', path], 10_000)
      const line = tail.stdout.split('\n').map(s => s.trim()).filter(Boolean).pop()
      if (line) g.log = line.slice(0, 200)
    } catch {
      // a log that cannot be read leaves the group without one
    }
  }
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
  if (!gone.length) return
  const states = new Map<string, Map<string, number>>()
  try {
    const acct = await run($, ['sacct', '-n', '-P', '-X', '-j', gone.map(g => g.key).join(','), '-o', 'JobID,State'], 20_000)
    for (const line of acct.stdout.split('\n')) {
      const [id, state] = line.trim().split('|')
      if (!id || !state) continue
      const key = id.split('_')[0]!
      const word = state.split(' ')[0]!.toLowerCase()
      const counts = states.get(key) ?? new Map<string, number>()
      counts.set(word, (counts.get(word) ?? 0) + 1)
      states.set(key, counts)
    }
  } catch {
    // no sacct: the toast says only that the job left the queue
  }
  for (const g of gone) {
    const counts = states.get(g.key)
    const how = counts ? [...counts].map(([w, n]) => (g.isArray ? `${n} ${w}` : w)).join(', ') : 'left the queue'
    $.ui.toast(`slurm: ${g.name} ${g.isArray ? `finished: ${how}` : how}`, { timeoutMs: 8000 })
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

  on('session.start', async ($, e, next) => {
    if (await probe($)) {
      await $.command.register({ name: 'slurm', description: 'Show the Slurm queue in a pane; /slurm refresh polls now' })
      void poll($)
    }
    return next(e)
  })

  on('command.run', { command: 'slurm' }, async ($, e, next) => {
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
    if (hasSlurm && SUBMITS.test(String(e.command ?? ''))) {
      const now = await $.clock.now()
      schedule($, Math.max(3000, MIN_GAP_MS - (now - triedAt)))
    }
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (!contextOn || !hasSlurm) return next(e)
    const text = contextText(await $.clock.now())
    return text ? next({ ...e, context: [...(e.context ?? []), text] }) : next(e)
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
        {jobs.length > shown.length && <Text dimColor>+{jobs.length - shown.length} more · /slurm</Text>}
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
        <Text dimColor>as of {age(now)} ago · next look in {groups.length && !failures ? '1 min' : '5 min'} · /slurm refresh</Text>
      </Box>
    )
  })
}
