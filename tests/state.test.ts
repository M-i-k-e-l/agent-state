import { expect, test } from 'claude-code/testing'

// Each write is one $.process.run of the emit script: argv[5] is the state,
// argv[7] the tty passed back from an earlier write, argv[8] the log line,
// argv[9] "1" when no person is at the prompt.
type Write = { line: string; state: string | undefined; tty: string | undefined }

const record = (argv: readonly string[]): Write => ({
  line: argv[8] ?? '',
  state: argv[5],
  tty: argv[7],
})

const RAN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

test('a turn shows working, and idle when it ends', async ($, on) => {
  const writes: Write[] = []
  on('process.run', (_$, e) => {
    writes.push(record(e.argv))
    return { value: RAN }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(writes.map(w => w.state)).toEqual(['⚙️ working', '💤 idle'])
})

test('an interrupted turn shows idle', async ($, on) => {
  const writes: Write[] = []
  on('process.run', (_$, e) => {
    writes.push(record(e.argv))
    return { value: RAN }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'hi', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't2', reason: 'aborted' })

  expect(writes.at(-1)?.state).toBe('💤 idle')
  expect(writes.at(-1)?.line).toContain('reason=aborted')
})

test('a subagent turn ending leaves the tab alone', async ($, on) => {
  const writes: Write[] = []
  on('process.run', (_$, e) => {
    writes.push(record(e.argv))
    return { value: RAN }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: 'x', durationMs: 5, isAborted: false, turnId: 't3', reason: 'answer', agentId: 'a1' })

  expect(writes).toEqual([])
})

test('a write passes back the tty the one before it reported', async ($, on) => {
  const writes: Write[] = []
  const reported = ['none', '', '/dev/ttys001', '']
  on('process.run', (_$, e) => {
    writes.push(record(e.argv))
    return { value: { ...RAN, stdout: reported[writes.length - 1] ?? '' } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  // Working and idle in turn, so each of the five is a write.
  await $.turn.start({ text: 'hi', turnId: 't4' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't4', reason: 'answer' })
  await $.turn.start({ text: 'hi', turnId: 't5' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't5', reason: 'answer' })
  await $.turn.start({ text: 'hi', turnId: 't6' })

  // A failed search ("none") and an empty answer are nothing to cache.
  expect(writes.map(w => w.tty)).toEqual(['', '', '', '/dev/ttys001', '/dev/ttys001'])
})

test("a subagent's permission dialog holds the tab until its turn ends", async ($, on) => {
  const writes: Write[] = []
  on('process.run', (_$, e) => {
    writes.push(record(e.argv))
    return { value: RAN }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.PermissionRequest', () => ({}))

  await $.turn.start({ text: 'hi', turnId: 't9' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, agent_id: 'a1' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't9', reason: 'answer' })
  await $.turn.complete({ answer: 'x', durationMs: 5, isAborted: false, turnId: 't10', reason: 'answer', agentId: 'a1' })

  // The main turn's end rests in permission, which the tab already shows.
  expect(writes.map(w => w.state)).toEqual(['⚙️ working', '🔐 permission', '💤 idle'])
})

test('a state the tab already shows is not written again, unless its write failed', async ($, on) => {
  const writes: Write[] = []
  const exits = [1, 0]
  on('process.run', (_$, e) => {
    writes.push(record(e.argv))
    return { value: { ...RAN, exitCode: exits[writes.length - 1] ?? 0 } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  for (const turnId of ['t11', 't12', 't13']) await $.turn.start({ text: 'hi', turnId })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't13', reason: 'answer' })

  expect(writes.map(w => w.state)).toEqual(['⚙️ working', '⚙️ working', '💤 idle'])
})

test('a session with no tab to write to is asked once', async ($, on) => {
  const writes: Write[] = []
  on('process.run', (_$, e) => {
    writes.push(record(e.argv))
    return { value: { ...RAN, exitCode: 2 } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'hi', turnId: 't14' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't14', reason: 'answer' })
  await $.turn.start({ text: 'hi', turnId: 't15' })

  expect(writes.map(w => w.state)).toEqual(['⚙️ working'])
})

test('the script is told when no person is at the prompt', async ($, on) => {
  const headless: (string | undefined)[] = []
  on('process.run', (_$, e) => {
    headless.push(e.argv[9])
    return { value: RAN }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't16' })
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't17' })

  expect(headless).toEqual(['1', '1', '0', '0'])
})

test("the person's accept ends the permission state, for the main agent and for a subagent", async ($, on) => {
  const writes: Write[] = []
  on('process.run', (_$, e) => {
    writes.push(record(e.argv))
    return { value: RAN }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('classic.PermissionRequest', () => ({}))
  on('telemetry.log', () => ({ value: undefined }))
  const finish: (() => void)[] = []
  on('tool.call', async () => {
    await new Promise<void>(resolve => {
      finish.push(resolve)
    })
    return { result: {} }
  })
  const decide = (id: string, decision: string, source = 'user_temporary') =>
    $.telemetry.log({
      to: 'collector',
      event: 'tool_decision',
      attributes: { decision, source, tool_name: 'Bash', tool_use_id: id },
      loggedAt: '2026-10-10T10:12:43.154Z',
    })

  await $.turn.start({ text: 'hi', turnId: 't19' })
  const main = $.tool.call({ tool: 'Bash', tool_use_id: 'u2', command: 'make' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  // A call that is not in flight, a refusal, and an accept no person gave leave the
  // dialog's state alone.
  await decide('u9', 'accept')
  await decide('u2', 'reject')
  await decide('u2', 'accept', 'config')
  await decide('u2', 'accept', 'hook')
  await decide('u2', 'accept')
  // The agent's id rides along as on a hook's own event; the call's type leaves it out.
  const asSubagent = { tool: 'Bash' as const, tool_use_id: 'u3', command: 'make', agentId: 'a1' }
  const sub = $.tool.call(asSubagent)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, agent_id: 'a1' })
  await decide('u3', 'accept', 'config')
  await decide('u3', 'accept', 'user_permanent')
  for (const done of finish) done()
  await Promise.all([main, sub])

  expect(writes.map(w => w.state)).toEqual(['⚙️ working', '🔐 permission', '⚙️ working', '🔐 permission', '⚙️ working'])
})
