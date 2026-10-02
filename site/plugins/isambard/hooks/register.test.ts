import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { collapse, parseRows, seconds, span, taskCount } from './register.tsx'

const QUEUE = [
  '7023772|292-328|7023772_[292-328]|celeba128_e43|PENDING|0:00|4:00:00|(QOSMaxJobsPerUserLimit)',
  '7023772|291|7023772_291|celeba128_e43|RUNNING|0:03|3:59:57|nid010439',
  '7023772|290|7023772_290|celeba128_e43|RUNNING|0:07|3:59:53|nid011305',
  '7013694|N/A|7013694|code_tunnel|RUNNING|5:13:54|17:46:06|nid010228',
].join('\n')

const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// the machine beneath the plugin: whether squeue exists, and what it prints
function world(on: On, machine: { hasSqueue: boolean; queue: () => string }) {
  const calls: string[] = []
  mock.clock(on, { now: 1_000_000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('process.run', (_$, e) => {
    const cmd = e.argv[0]!
    calls.push(cmd)
    if (cmd === 'sh') return answer(machine.hasSqueue ? '/usr/bin/squeue\n' : '', machine.hasSqueue ? 0 : 1)
    if (cmd === 'id') return answer('alice\n')
    if (cmd === 'squeue') return answer(machine.queue())
    if (cmd === 'scontrol') return answer('JobId=7023772 StdOut=/work/logs/291.out\n')
    if (cmd === 'tail') return answer('celeba_000 psnr 30.55 lpips 0.151\n\n')
    if (cmd === 'sacct') return answer('7023772_1|COMPLETED\n7023772_2|COMPLETED\n7023772_3|FAILED\n')
    return answer('', 127)
  })
  return calls
}

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
  const polled = await $.command.run({ command: 'slurm', args: 'refresh' })
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
  await $.command.run({ command: 'slurm', args: 'refresh' })
  expect((await $.prompt.submit({ text: 'a' })).context ?? []).toEqual([])
  queue = QUEUE
  await $.command.run({ command: 'slurm', args: 'refresh' })
  expect(((await $.prompt.submit({ text: 'b' })).context ?? []).join()).toContain('celeba128_e43')
  queue = ''
  await $.command.run({ command: 'slurm', args: 'refresh' })
  expect(((await $.prompt.submit({ text: 'c' })).context ?? []).join()).toContain('empty')
  expect((await $.prompt.submit({ text: 'd' })).context ?? []).toEqual([])
})
