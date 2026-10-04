import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// import { collapse, expandLogPattern, parseRows, seconds, span, taskCount } from './register.tsx'
// import { collapse, expandLogPattern, parseGpuMinutes, parseRows, seconds, span, taskCount, usageText } from './register.tsx'
import {
  collapse, defaultPartition, expandLogPattern, fillBar, fitBand, gpuBar, parseCluster, parseGpuMinutes, parseQuota,
  parseRows, projectName, seconds, span, taskCount, tib, usageText,
} from './register.tsx'

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
// function world(on: On, machine: { hasSqueue: boolean; queue: () => string; refuseCommand?: boolean; sacct?: string; planFolder?: string; toolResult?: () => object }, seen?: Seen) {
// function world(on: On, machine: { hasSqueue: boolean; queue: () => string; refuseCommand?: boolean; sacct?: string; planFolder?: string; toolResult?: () => object; assoc?: string }, seen?: Seen) {
function world(on: On, machine: { hasSqueue: boolean; queue: () => string; refuseCommand?: boolean; sacct?: string; planFolder?: string; toolResult?: () => object; assoc?: string; partitions?: string; sinfo?: string; lfsProject?: string; quota?: string }, seen?: Seen) {
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
    if (cmd === 'scontrol' && e.argv[2] === 'assoc_mgr') return answer(machine.assoc ?? '')
    // sinfo: the default partition (-o %P) or the per-node GPU and state table; lfs: the folder's project id, then its quota
    if (cmd === 'sinfo') return e.argv.includes('%P') ? answer(machine.partitions ?? '', machine.partitions ? 0 : 1) : answer(machine.sinfo ?? '', machine.sinfo ? 0 : 1)
    if (cmd === 'lfs') return e.argv[1] === 'project' ? answer(machine.lfsProject ?? '', machine.lfsProject ? 0 : 1) : answer(machine.quota ?? '', machine.quota ? 0 : 1)
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

// `scontrol show assoc_mgr users=alice flags=assoc` as Isambard-AI printed it on 2026-10-03 (lines shortened)
const ASSOC = [
  'Current Association Manager state',
  '',
  'Association Records',
  '',
  'ClusterName=gracehopper Account=brics.b5ak UserName=alice(1000) Partition= Priority=0 ID=1613',
  '    GrpTRESMins=cpu=N(2124414),mem=N(3391090161),node=N(29505),billing=N(2124414),gres/gpu=N(29505),gres/gpumem=N(0)',
  '    GrpTRESRunMins=cpu=N(51124),gres/gpu=N(710)',
].join('\n')

test('this month\'s GPU node hours from the association usage counter', () => {
  expect(parseGpuMinutes(ASSOC)).toEqual(new Map([['brics.b5ak', 29505]]))
  // a record with a limit set still gives its usage; the running-job counter is not usage
  const limited = 'ClusterName=gracehopper Account=brics.x12 UserName=alice(1000)\n    GrpTRESMins=gres/gpu=240000(480)\n    GrpTRESRunMins=gres/gpu=N(9999)'
  expect(parseGpuMinutes(`${ASSOC}\n${limited}`)).toEqual(new Map([['brics.b5ak', 29505], ['brics.x12', 480]]))
  expect(parseGpuMinutes('JobId=7023772 StdOut=/work/logs/291.out')).toEqual(new Map())
  expect(usageText(new Map())).toBe('')
  expect(usageText(new Map([['brics.b5ak', 29505]]))).toBe('122.9 NHR this month')
  expect(usageText(new Map([['brics.b5ak', 29505], ['brics.x12', 480]]))).toBe('b5ak 122.9 · x12 2.0 NHR this month')
})

test('the usage counter is read at most every five minutes and shown by /queue refresh; an unreadable one shows nothing', async ($, on) => {
  const seen: Seen = { prompts: [], argv: [] }
  world(on, { hasSqueue: true, queue: () => QUEUE, assoc: ASSOC }, seen)
  await $.session.start(START)
  await seen.clock!.settle()
  const reads = () => seen.argv.filter(argv => argv[0] === 'scontrol' && argv[2] === 'assoc_mgr').length
  expect(reads()).toBe(1)
  expect((await $.command.run({ command: 'queue', args: 'refresh' })).text).toContain('122.9 NHR this month')
  expect(reads()).toBe(1)
  await seen.clock!.advance(300_000)
  await seen.clock!.settle()
  expect(reads()).toBe(2)
})

test('no usage line when the counter answers nothing', async ($, on) => {
  world(on, { hasSqueue: true, queue: () => QUEUE })
  await $.session.start(START)
  expect((await $.command.run({ command: 'queue', args: 'refresh' })).text).not.toContain('NHR')
})

// `sinfo -h -N -p workq -O Gres:40,GresUsed:60,StateCompact:16`, one node per state (a GH200 node has 4 GPUs)
const SINFO = [
  'gpu:4(S:0-3)   gpu:gh200:4(IDX:0-3)    alloc',
  'gpu:4(S:0-3)   gpu:gh200:2(IDX:0-1)    mix',
  'gpu:4(S:0-3)   gpu:(null):0(IDX:N/A)   idle',
  'gpu:4(S:0-3)   gpu:(null):0(IDX:N/A)   resv',
  'gpu:4(S:0-3)   gpu:(null):0(IDX:N/A)   drain*',
  'gpu:4(S:0-3)   gpu:(null):0(IDX:N/A)   down*',
  'gpu:4(S:0-3)   gpu:gh200:4(IDX:0-3)    comp',
].join('\n')
// `lfs quota -p 1483801647 /lus/lfs1aip2/projects/b5ak` as Isambard-AI printed it on 2026-10-03: kbytes and files
const QUOTA = [
  'Disk quotas for prj 1483801647 (pid 1483801647):',
  '     Filesystem  kbytes   quota   limit   grace   files   quota   limit   grace',
  '/lus/lfs1aip2/projects/b5ak',
  '                78173842908       0 214748364800       - 4044325       0 51200000       -',
].join('\n')

test('the cluster from sinfo: nodes by state, and the GPUs free on idle and partly used nodes', () => {
  expect(defaultPartition('workq*\ninteractive\n')).toBe('workq')
  expect(defaultPartition('interactive\n')).toBe('interactive')
  expect(parseCluster(SINFO, 'workq')).toEqual({ partition: 'workq', nodes: 7, gpus: 28, free: 6, full: 2, partly: 1, idle: 1, reserved: 1, down: 2 })
  expect(parseCluster('', 'workq').nodes).toBe(0)
})

test('the project quota from lfs quota, in TB and millions of files', () => {
  expect(parseQuota(QUOTA)).toEqual({ usedKB: 78173842908, limitKB: 214748364800, files: 4044325, filesLimit: 51200000 })
  expect(parseQuota('lfs: no such project')).toBeUndefined()
  expect(tib(78173842908)).toBe('72.8')
  expect(tib(214748364800)).toBe('200')
  expect(projectName('/lus/lfs1aip2/projects/b5ak/kc25870.b5ak/workspace', '1483801647')).toBe('b5ak')
  expect(projectName('/work', '1483801647')).toBe('project 1483801647')
})

test('bars fill their width exactly, with an eighth block at the edge of the fill', () => {
  const width = (spans: { text: string }[]) => spans.map(s => s.text).join('').length
  const filled = fillBar(0.364, 20, '#7DC4FF')
  expect(width(filled)).toBe(20)
  expect(filled[0]!.text).toBe('███████')
  expect(filled[1]!.text).toBe('▎')
  expect(width(fillBar(1.2, 10, '#7DC4FF'))).toBe(10)
  expect(width(fillBar(0, 10, '#7DC4FF'))).toBe(10)
})

test('the band drops its least important items first and never the tunnel', () => {
  const items = [{ id: 'tunnel', width: 14, keep: true }, { id: 'job1', width: 30, keep: true }, { id: 'nhr', width: 9 }, { id: 'job2', width: 25 }, { id: 'cluster', width: 18 }]
  expect(fitBand(items, 200)).toEqual(['tunnel', 'job1', 'nhr', 'job2', 'cluster'])
  expect(fitBand(items, 90)).toEqual(['tunnel', 'job1', 'nhr', 'job2'])
  expect(fitBand(items, 80)).toEqual(['tunnel', 'job1', 'nhr'])
  expect(fitBand(items, 40)).toEqual(['tunnel', 'job1'])
})

const RICH = { hasSqueue: true, queue: () => QUEUE, assoc: ASSOC, partitions: 'workq*\ninteractive\n', sinfo: SINFO, lfsProject: '1483801647 P /work', quota: QUOTA }

test('/queue refresh tells the cluster and the project storage', async ($, on) => {
  world(on, RICH)
  await $.session.start(START)
  const text = (await $.command.run({ command: 'queue', args: 'refresh' })).text ?? ''
  expect(text).toContain('workq: 6 of 28 GPUs free')
  expect(text).toContain('project 1483801647: 72.8 / 200 TB (36%), files 4.0 / 51.2 M')
  expect(text).toContain('122.9 NHR this month')
})

for (const bodyColumns of [160, 90, 60]) {
  test(`the pane draws at ${bodyColumns} columns: one row of meters (load, disk, use, tunnel) over the queue`, async ($, on) => {
    const seen: Seen = { prompts: [], argv: [] }
    world(on, RICH, seen)
    await $.session.start(START)
    await seen.clock!.settle()
    const pane = await $.ui.mount({
      plugin: 'isambard', surface: 'terminal', component: 'Pane', requestId: 'slurm',
      props: { title: 'Isambard', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never,
    })
    const drawn = (await pane.find({ type: 'Box' }))?.text ?? ''
    for (const shown of ['6 free', 'disk', '36%', '122.9 NHR', 'tunnel', '17h46m', 'celeba128_e43']) expect(drawn).toContain(shown)
    // minimal: no legend, no trend, no storage detail
    for (const hidden of ['reserved', 'last 24 h', 'files']) expect(drawn).not.toContain(hidden)
  })
}

for (const bodyColumns of [180, 60]) {
  test(`the band at ${bodyColumns} columns keeps the tunnel's time`, async ($, on) => {
    const seen: Seen = { prompts: [], argv: [] }
    world(on, RICH, seen)
    await $.session.start(START)
    await seen.clock!.settle()
    const band = await $.ui.mount({
      plugin: 'isambard', surface: 'terminal', component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns, scroll: { offset: 0, bodyRows: 1 }, view: {} } as never,
    })
    const drawn = (await band.find({ type: 'Box' }))?.text ?? ''
    expect(drawn).toContain('tunnel 17h46m left')
    if (bodyColumns >= 180) for (const shown of ['6 free', '36%', '122.9 NHR']) expect(drawn).toContain(shown)
    else expect(drawn).not.toContain('NHR') // 60 columns: the job and the tunnel, the meters dropped
  })
}

test('the band counts the jobs it left out', async ($, on) => {
  const many = [1, 2, 3, 4].map(n => `70300${n}|N/A|70300${n}|sweep_${n}|RUNNING|1:00:00|3:00:00|nid01000${n}`).concat(TUNNEL_ONLY).join('\n')
  const seen: Seen = { prompts: [], argv: [] }
  world(on, { ...RICH, queue: () => many }, seen)
  await $.session.start(START)
  await seen.clock!.settle()
  const drawnAt = async (bodyColumns: number) => (await (await $.ui.mount({
    plugin: 'isambard', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns, scroll: { offset: 0, bodyRows: 1 }, view: {} } as never,
  })).find({ type: 'Box' }))?.text ?? ''
  const narrow = await drawnAt(80)
  for (const shown of ['sweep_1', '+3 more', 'tunnel 17h46m left']) expect(narrow).toContain(shown)
  expect(narrow).not.toContain('sweep_2')
  const wide = await drawnAt(180)
  for (const shown of ['sweep_3', '+1 more', '6 free', '122.9 NHR']) expect(wide).toContain(shown)
})

test('the gpu bar is shaded by position, its edge the brightest cell, and a glint lifts the edge toward white', () => {
  const rest = gpuBar(0.84, 8, 0)
  expect(rest.map(s => s.text).join('')).toBe('██████▊░')
  expect(rest[0]!.color).toBe('#4C7BD9')
  expect(rest[6]!.color).toBe('#76BAFA') // 6/7 of the way to #7DC4FF
  expect(rest[7]!.color).toBe('#2E3440')
  expect(gpuBar(0.84, 8, 1)[6]!.color).toBe('#BBDDFD') // half way to white
  expect(gpuBar(1, 8, 0).at(-1)!.color).toBe('#7DC4FF')
})

// n idle nodes and the rest allocated, 4 GPUs each
const NODES = (idle: number, total = 100) =>
  Array.from({ length: total }, (_, i) => (i < idle ? 'gpu:4(S:0-3)   gpu:(null):0(IDX:N/A)   idle' : 'gpu:4(S:0-3)   gpu:gh200:4(IDX:0-3)    alloc')).join('\n')

test('sinfo rides the 60 s poll; a changed reading rolls the free count over 0.8 s and the meter then holds still', async ($, on) => {
  const machine = { ...RICH, sinfo: NODES(10) }
  const seen: Seen = { prompts: [], argv: [] }
  world(on, machine, seen)
  await $.session.start(START)
  await seen.clock!.settle()
  const band = await $.ui.mount({
    plugin: 'isambard', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 180, scroll: { offset: 0, bodyRows: 1 }, view: {} } as never,
  })
  const shown = async () => (await band.find({ type: 'Box' }))?.text ?? ''
  const reads = () => seen.argv.filter(argv => argv[0] === 'sinfo' && !argv.includes('%P')).length
  expect(await shown()).toMatch(/ 40 free/)
  machine.sinfo = NODES(50)
  await seen.clock!.advance(60_000)
  expect(reads()).toBe(2)
  expect(await shown()).toMatch(/ 40 free/) // the first frame starts from what was shown
  await seen.clock!.advance(400)
  expect(await shown()).toMatch(/ 180 free/) // ease-out: 87.5 % of the way after half the time
  await seen.clock!.advance(800)
  expect(await shown()).toMatch(/ 200 free/)
  await seen.clock!.advance(30_000)
  expect(await shown()).toMatch(/ 200 free/)
})
