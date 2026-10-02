import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { collapse, expandLogPattern, parseRows, seconds, span, taskCount } from './register.tsx'

const QUEUE = [
  '7023772|292-328|7023772_[292-328]|celeba128_e43|PENDING|0:00|4:00:00|(QOSMaxJobsPerUserLimit)',
  '7023772|291|7023772_291|celeba128_e43|RUNNING|0:03|3:59:57|nid010439',
  '7023772|290|7023772_290|celeba128_e43|RUNNING|0:07|3:59:53|nid011305',
  '7013694|N/A|7013694|code_tunnel|RUNNING|5:13:54|17:46:06|nid010228',
].join('\n')

const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// the failed task's log as sacct prints its pattern, and the same path with %x %A %a expanded
const PATTERN = '/work/logs/%x-%A_%a.out'
const FAILED_LOG = '/work/logs/celeba128_e43-7023772_291.out'
const TUNNEL_ONLY = '7013694|N/A|7013694|code_tunnel|RUNNING|5:13:54|17:46:06|nid010228'
// sacct rows of the e43 array: JobID|State|StdOut|JobName|JobIDRaw|User|WorkDir|Comment
const ARRAY_ROWS = [
  ...Array.from({ length: 324 }, (_, i) => `7023772_${i}|COMPLETED|${PATTERN}|celeba128_e43|${7023773 + i}|alice|/work|`),
  ...Array.from({ length: 5 }, (_, i) => `7023772_${291 + i}|FAILED|${PATTERN}|celeba128_e43|${7024100 + i}|alice|/work|`),
].join('\n')

// what the test watches: the plugin's own prompts, the clock, and every argv the plugin ran
type Seen = { prompts: string[]; argv: string[][]; clock?: ReturnType<typeof mock.clock> }

// the machine beneath the plugin: whether squeue exists, and what it prints
function world(on: On, machine: { hasSqueue: boolean; queue: () => string; refuseCommand?: boolean; sacct?: string; planFolder?: string; toolResult?: () => object }, seen?: Seen) {
  const calls: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  if (seen) seen.clock = clock
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // the engine refuses a name another part of the plugin owns, as it refused /slurm on 2026-10-02
  on('command.register', (_$, e) => (machine.refuseCommand ? { deny: `"/${e.name}" refused: it is the plugin's /isambard:${e.name}` } : { value: { command: e.name } }))
  on('prompt.submit', (_$, e) => {
    if (e.origin?.kind === 'plugin') seen?.prompts.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('tool.call', (_$, e) => (machine.toolResult ? (machine.toolResult() as never) : { deny: `no bash in this test: ${String(e.tool)}` }))
  on('process.run', (_$, e) => {
    const cmd = e.argv[0]!
    calls.push(cmd)
    seen?.argv.push([...e.argv])
    // the PLAN.md walk is an sh call too; the probe is `sh -c 'command -v squeue'`
    if (cmd === 'sh' && String(e.argv[2]).includes('PLAN.md')) return machine.planFolder ? answer(`${machine.planFolder}\n`) : answer('', 1)
    if (cmd === 'sh') return answer(machine.hasSqueue ? '/usr/bin/squeue\n' : '', machine.hasSqueue ? 0 : 1)
    if (cmd === 'id') return answer('alice\n')
    if (cmd === 'squeue') return answer(machine.queue())
    if (cmd === 'scontrol') return answer('JobId=7023772 StdOut=/work/logs/291.out\n')
    if (cmd === 'tail' && e.argv[3] === FAILED_LOG) return answer('step 10 loss 0.3\nTraceback (most recent call last):\n  File "train.py", line 9\nValueError: bad shape (3, 5)\n')
    if (cmd === 'tail') return answer('celeba_000 psnr 30.55 lpips 0.151\n\n')
    if (cmd === 'sacct') return answer(machine.sacct ?? '7023772_1|COMPLETED\n7023772_2|COMPLETED\n7023772_3|FAILED\n')
    return answer('', 127)
  })
  return calls
}

const SUBMITTED = (id: string) => ({ result: { stdout: `Submitted batch job ${id}\n`, stderr: '' }, text: `Submitted batch job ${id}\n` })

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

test('array ranges, durations and the grouping', () => {
  expect(taskCount('292-328')).toBe(37)
  expect(taskCount('[1-5,7,10-20:2]%4')).toBe(12)
  expect(taskCount('N/A')).toBe(1)
  expect(seconds('1-02:03:04')).toBe(93_784)
  expect(seconds('4:00')).toBe(240)
  expect(seconds('UNLIMITED')).toBe(-1)
  expect(span(63_960)).toBe('17h46m')
  const groups = collapse(parseRows(QUEUE))
  const array = groups.find(g => g.key === '7023772')!
  expect(array.isArray).toBe(true)
  expect(array.running).toBe(2)
  expect(array.pending).toBe(37)
  expect(array.reason).toBe('QOSMaxJobsPerUserLimit')
})

test('no squeue on the machine: no command, no poll, nothing beside the prompt', async ($, on) => {
  const calls = world(on, { hasSqueue: false, queue: () => '' })
  await $.session.start(START)
  const sent = await $.prompt.submit({ text: 'hello' })
  expect(sent.context ?? []).toEqual([])
  expect(calls).not.toContain('squeue')
})

test('jobs in the queue: a few lines beside the prompt, the log line of a running task', async ($, on) => {
  world(on, { hasSqueue: true, queue: () => QUEUE })
  await $.session.start(START)
  const polled = await $.command.run({ command: 'queue', args: 'refresh' })
  expect(polled.text).toContain('37 pending (QOSMaxJobsPerUserLimit)')
  const sent = await $.prompt.submit({ text: 'how are the jobs' })
  const context = (sent.context ?? []).join('\n')
  expect(context).toContain('celeba128_e43 (array 7023772): 2 running, 37 pending')
  expect(context).toContain('psnr 30.55')
  expect(context.length).toBeLessThan(800)
})

test('an empty queue says nothing, and says "empty" once after jobs drain', async ($, on) => {
  let queue = ''
  world(on, { hasSqueue: true, queue: () => queue })
  await $.session.start(START)
  await $.command.run({ command: 'queue', args: 'refresh' })
  expect((await $.prompt.submit({ text: 'a' })).context ?? []).toEqual([])
  queue = QUEUE
  await $.command.run({ command: 'queue', args: 'refresh' })
  expect(((await $.prompt.submit({ text: 'b' })).context ?? []).join()).toContain('celeba128_e43')
  queue = ''
  await $.command.run({ command: 'queue', args: 'refresh' })
  expect(((await $.prompt.submit({ text: 'c' })).context ?? []).join()).toContain('empty')
  expect((await $.prompt.submit({ text: 'd' })).context ?? []).toEqual([])
})

test('a refused command name stops nothing: the first prompt still gets the queue', async ($, on) => {
  world(on, { hasSqueue: true, queue: () => QUEUE, refuseCommand: true })
  await $.session.start(START)
  const context = ((await $.prompt.submit({ text: 'first prompt of the session' })).context ?? []).join('\n')
  expect(context).toContain('celeba128_e43 (array 7023772): 2 running, 37 pending')
})

const SBATCH = { tool: 'Bash', command: 'sbatch run.sh' } as const
const refresh = ($: { command: { run: (i: { command: string; args: string }) => Promise<unknown> } }) => $.command.run({ command: 'queue', args: 'refresh' })

test('log patterns expand the way job_status.sh does', () => {
  const row = { id: '7023772_5', name: 'celeba', raw: '7023800', user: 'alice', workDir: '/work' }
  expect(expandLogPattern('logs/%x-%A_%a-%j-%u-100%%.out', row)).toBe('/work/logs/celeba-7023772_5-7023800-alice-100%.out')
  expect(expandLogPattern('/abs/%x.out', { ...row, id: '7023772' })).toBe('/abs/celeba.out')
  expect(expandLogPattern('', row)).toBe('')
})

test('an ended group is told once: counts and the last error line of the failed task, not the tunnel', async ($, on) => {
  let queue = QUEUE
  world(on, { hasSqueue: true, queue: () => queue, sacct: ARRAY_ROWS })
  await $.session.start(START)
  await refresh($)
  queue = TUNNEL_ONLY
  await refresh($)
  const told = ((await $.prompt.submit({ text: 'what happened' })).context ?? []).join('\n')
  expect(told).toContain('ended: celeba128_e43 (array 7023772): 324 completed, 5 failed; last error: ValueError: bad shape (3, 5)')
  expect(told).not.toContain('experiment-loop')
  expect(told).not.toContain('ended: code_tunnel')
  expect(((await $.prompt.submit({ text: 'again' })).context ?? []).join('\n')).not.toContain('ended:')
})

test('an ended group in an experiment-loop folder carries the step hint', async ($, on) => {
  let queue = QUEUE
  const seen: Seen = { prompts: [], argv: [] }
  world(on, { hasSqueue: true, queue: () => queue, sacct: ARRAY_ROWS, planFolder: '/work/exps/e43' }, seen)
  await $.session.start(START)
  await refresh($)
  queue = TUNNEL_ONLY
  await refresh($)
  const told = ((await $.prompt.submit({ text: 'what happened' })).context ?? []).join('\n')
  expect(told).toContain('; experiment-loop: verify, write result.json, run aggregate_runs.py for /work/exps/e43')
  // the walk starts at the folder of the expanded log
  expect(seen.argv.some(a => a[3] === 'plan-folder' && a[4] === '/work/logs')).toBe(true)
})

test('the quick re-poll after sbatch fires only when the Bash call ran', async ($, on) => {
  let outcome: object = { deny: 'blocked' }
  const seen: Seen = { prompts: [], argv: [] }
  const calls = world(on, { hasSqueue: true, queue: () => '', toolResult: () => outcome }, seen)
  await $.session.start(START)
  await seen.clock!.settle()
  const polls = () => calls.filter(c => c === 'squeue').length
  const base = polls()
  await $.tool.call(SBATCH)
  await seen.clock!.advance(20_000)
  expect(polls()).toBe(base)
  outcome = { isError: true, result: 'boom', text: 'boom' }
  await $.tool.call(SBATCH)
  await seen.clock!.advance(20_000)
  expect(polls()).toBe(base)
  outcome = SUBMITTED('7023999')
  await $.tool.call(SBATCH)
  await seen.clock!.advance(20_000)
  expect(polls()).toBe(base + 1)
})

test('wake off (the default): an own job that ends submits nothing and is told beside the next prompt', async ($, on) => {
  let queue = QUEUE
  const seen: Seen = { prompts: [], argv: [] }
  world(on, { hasSqueue: true, queue: () => queue, sacct: ARRAY_ROWS, toolResult: () => SUBMITTED('7023772') }, seen)
  await $.session.start(START)
  await seen.clock!.settle()
  await $.tool.call(SBATCH)
  queue = TUNNEL_ONLY
  await seen.clock!.advance(61_000) // the timer's poll, as in a session
  await seen.clock!.settle()
  expect(seen.prompts).toEqual([])
  expect(((await $.prompt.submit({ text: 'next' })).context ?? []).join('\n')).toContain('ended: celeba128_e43 (array 7023772)')
})

test('wake on: exactly one prompt for an own job, told once, and the next prompt does not repeat it', { options: { wake: 'on' } }, async ($, on) => {
  let queue = QUEUE
  const seen: Seen = { prompts: [], argv: [] }
  world(on, { hasSqueue: true, queue: () => queue, sacct: ARRAY_ROWS, toolResult: () => SUBMITTED('7023772') }, seen)
  await $.session.start(START)
  await seen.clock!.settle()
  await $.tool.call(SBATCH)
  queue = TUNNEL_ONLY
  await seen.clock!.advance(61_000) // the timer's poll, as in a session
  await seen.clock!.settle() // the wake is not awaited by the poll
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('ended: celeba128_e43 (array 7023772): 324 completed, 5 failed; last error: ValueError: bad shape (3, 5)')
  await seen.clock!.advance(61_000) // the timer's poll, as in a session
  await seen.clock!.settle()
  expect(seen.prompts.length).toBe(1)
  expect(((await $.prompt.submit({ text: 'next' })).context ?? []).join('\n')).not.toContain('ended:')
})

test('wake on: a job the session did not submit wakes nobody; a subagent\'s job is not the main loop\'s', { options: { wake: 'on' } }, async ($, on) => {
  let queue = QUEUE
  const seen: Seen = { prompts: [], argv: [] }
  world(on, { hasSqueue: true, queue: () => queue, sacct: ARRAY_ROWS, toolResult: () => SUBMITTED('7023772') }, seen)
  await $.session.start(START)
  await seen.clock!.settle()
  await $.tool.call({ ...SBATCH, agentId: 'sub1' } as never)
  queue = TUNNEL_ONLY
  await seen.clock!.advance(61_000) // the timer's poll, as in a session
  await seen.clock!.settle()
  expect(seen.prompts).toEqual([])
  expect(((await $.prompt.submit({ text: 'next' })).context ?? []).join('\n')).toContain('ended: celeba128_e43 (array 7023772)')
})

test('wake on: an own job that crashed before any poll saw it still wakes once', { options: { wake: 'on' } }, async ($, on) => {
  const seen: Seen = { prompts: [], argv: [] }
  const crashed = '7023999|FAILED|/work/logs/%x-%j.out|crash_job|7023999|alice|/work|'
  world(on, { hasSqueue: true, queue: () => TUNNEL_ONLY, sacct: crashed, toolResult: () => SUBMITTED('7023999') }, seen)
  await $.session.start(START)
  await seen.clock!.settle()
  await $.tool.call(SBATCH)
  await seen.clock!.advance(20_000)
  await seen.clock!.advance(61_000) // the timer's poll, as in a session
  await seen.clock!.settle()
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('ended: crash_job (7023999): failed')
})

test('wake on: a job submitted outside the session (no Bash call of its own) wakes nobody but is told beside the next prompt', { options: { wake: 'on' } }, async ($, on) => {
  let queue = QUEUE
  const seen: Seen = { prompts: [], argv: [] }
  world(on, { hasSqueue: true, queue: () => queue, sacct: ARRAY_ROWS }, seen)
  await $.session.start(START)
  await seen.clock!.settle()
  queue = TUNNEL_ONLY
  await seen.clock!.advance(61_000) // the timer's poll, as in a session
  await seen.clock!.settle()
  expect(seen.prompts).toEqual([])
  expect(((await $.prompt.submit({ text: 'next' })).context ?? []).join('\n')).toContain('ended: celeba128_e43 (array 7023772)')
})

test('wake on: a denied sbatch records no own job', { options: { wake: 'on' } }, async ($, on) => {
  const seen: Seen = { prompts: [], argv: [] }
  world(on, { hasSqueue: true, queue: () => TUNNEL_ONLY, sacct: '7023999|FAILED|/work/logs/%x-%j.out|crash_job|7023999|alice|/work|', toolResult: () => ({ deny: 'blocked' }) }, seen)
  await $.session.start(START)
  await seen.clock!.settle()
  await $.tool.call(SBATCH)
  await seen.clock!.advance(80_000)
  await seen.clock!.settle()
  expect(seen.prompts).toEqual([])
})
