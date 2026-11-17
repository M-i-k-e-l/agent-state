import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const RAN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

const PANE = {
  plugin: 'agent-state',
  component: 'Pane',
  requestId: 'agent-state',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// Stands for what draws beneath the mod under the prompt: the engine's modes, or
// another mod's drawing.
const drawModes = (on: On): void => {
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.modes.join(' & ')}</Text>
  })
}

// Stands for the engine beneath the mod: a file system held in a map, the
// environment given, and no tab to write to. Each process run is kept in `ran`,
// and each path read in `read`.
const engine = (
  on: On,
  env: Record<string, string>,
  files: Map<string, string>,
  ran: (readonly string[])[] = [],
  read: string[] = [],
): void => {
  drawModes(on)
  on('process.run', (_$, e) => {
    ran.push(e.argv)
    return { value: { ...RAN, exitCode: 2 } }
  })
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.cwd', () => ({ value: '/Users/me/project' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    read.push(e.path)
    return { value: files.get(e.path) ?? '' }
  })
  on('fs.exists', (_$, e) => ({ value: [...files.keys()].some(path => path === e.path || path.startsWith(`${e.path}/`)) }))
  // The store sits in the map too. Most of these tests draw the projects; one that
  // wants the other view says so.
  on('store.get', (_$, e) => ({ value: JSON.parse(files.get(`store:${e.key}`) ?? 'false') as unknown }))
  on('store.set', (_$, e) => {
    files.set(`store:${e.key}`, JSON.stringify(e.value))
    return { value: undefined }
  })
  // A path deeper down lists as a folder. A file's size is its text's length, and its
  // time the map's `mtime:<path>`, or else one that changes with its text, as a
  // write changes it on disk.
  // A folder the map names as `fail:<path>` fails to list, and so does one that is
  // missing, as on disk.
  on('fs.list', (_$, e) => {
    if (files.has(`fail:${e.path}`)) throw new Error('EIO')
    if (![...files.keys()].some(path => path.startsWith(`${e.path}/`))) throw new Error('ENOENT')
    const children = new Map<string, 'file' | 'dir'>()
    for (const path of files.keys()) {
      if (!path.startsWith(`${e.path}/`)) continue
      const [name = '', ...deeper] = path.slice(e.path.length + 1).split('/')
      children.set(name, deeper.length > 0 ? 'dir' : 'file')
    }
    return {
      value: [...children].map(([name, kind]) => ({
        name,
        kind,
        size: (files.get(`${e.path}/${name}`) ?? '').length,
        mtimeMs: Number(files.get(`mtime:${e.path}/${name}`) ?? textTime(files.get(`${e.path}/${name}`) ?? '')),
        isLink: false,
      })),
    }
  })
}

// A time that differs for each text, standing for when a file was last written.
const textTime = (text: string): number => [...text].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7)

const stateIn = (files: Map<string, string>, path: string): unknown =>
  (JSON.parse(files.get(path) ?? '{}') as { state?: unknown }).state

test('a session the app hosts writes its state to a file named by the app id', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' }, files)
  const path = '/Users/me/.claude/agent-state/local_1.json'

  await $.session.start({ cwd: '/Users/me/project', surface: null, isInteractive: false })
  expect(stateIn(files, path)).toBe('💤 idle')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(stateIn(files, path)).toBe('⚙️ working')
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(stateIn(files, path)).toBe('💤 idle')
  await $.session.end({ reason: 'other', sessionId: 'own-id', resume: { id: 'own-id' } })
  expect(stateIn(files, path)).toBe('')
})

test('a session the app does not host writes no file: an iTerm2 tab, a -p run', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, { HOME: '/Users/me' }, files)

  await $.session.start({ cwd: '/Users/me/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await $.session.start({ cwd: '/Users/me/project', surface: null, isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't3' })

  expect([...files.keys()]).toEqual([])
})

// The environment a session started by the app's session takes: the app's id for
// that session, and the engine's marks of what a session starts, both for a tool's
// command and one alone for an MCP server.
const STARTERS = [
  ['a tool', { CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1' }],
  ['an MCP server', { CLAUDECODE: '1' }],
] as const

for (const [starter, marks] of STARTERS) {
  test(`a session started by ${starter} of the app's session leaves that session's file and record alone`, async ($, on) => {
    const path = '/Users/me/.claude/agent-state/local_1.json'
    const working = JSON.stringify({ state: '⚙️ working', note: '', since: 1, cwd: '/x', updated: 1, prompted: 1 })
    const record = '/Users/me/Library/Application Support/Claude/claude-code-sessions/acct/org/local_1.json'
    const asking = JSON.stringify({ turnWrapUp: { needsUser: 'Which one?' } })
    const files = new Map([
      [path, working],
      [record, asking],
    ])
    const read: string[] = []
    engine(on, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1', ...marks }, files, [], read)

    await $.session.start({ cwd: '/Users/me/project', surface: null, isInteractive: false })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.session.end({ reason: 'other', sessionId: 'own-id', resume: { id: 'own-id' } })

    expect([...files]).toEqual([
      [path, working],
      [record, asking],
    ])
    expect(read).toEqual([])
  })
}

test("a mark switched off leaves the app's session filing its state", async ($, on) => {
  const files = new Map<string, string>()
  engine(on, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1', CLAUDE_CODE_CHILD_SESSION: '0', CLAUDECODE: '' }, files)

  await $.session.start({ cwd: '/Users/me/project', surface: null, isInteractive: false })

  expect(stateIn(files, '/Users/me/.claude/agent-state/local_1.json')).toBe('💤 idle')
})

test("the pane lists the sessions the app lists, by the app's titles, what waits on the person first", async ($, on) => {
  const now = Date.now()
  const filed = (state: string, title: string, minutesAgo: number): string =>
    JSON.stringify({ state, note: '', since: now - minutesAgo * 60_000, title, cwd: '/x', updated: now })
  const files = new Map([
    ['/Users/me/.claude/agent-state/local_a.json', filed('💤 idle', 'Reported title', 30)],
    ['/Users/me/.claude/agent-state/local_b.json', filed('🔐 permission', 'Asks', 2)],
    // Its process ended: idle since the app's last activity.
    ['/Users/me/.claude/agent-state/local_c.json', filed('', 'Stopped', 1)],
    // Archived, and gone from the app: left out though their files say idle.
    ['/Users/me/.claude/agent-state/local_d.json', filed('💤 idle', 'Archived', 5)],
    ['/Users/me/.claude/agent-state/local_e.json', filed('💤 idle', 'Deleted', 5)],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  const listed = (id: string, title: string, hoursAgo: number, isArchived = false) => ({
    sessionId: id,
    title,
    cwd: '/x',
    isArchived,
    lastActivityAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
  })
  on('mcp.call', (_$, e) => ({
    value: {
      isError: false,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            e.tool === 'list_sessions'
              ? [
                  listed('local_a', 'App title', 1),
                  listed('local_b', 'Asks', 1),
                  listed('local_c', 'Stopped', 2),
                  listed('local_d', 'Archived', 1, true),
                  // Never ran the mod: idle since the app's last activity.
                  listed('local_f', 'Old', 3),
                ]
              : listed('local_g', 'This one', 0),
          ),
        },
      ],
    },
  }))

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button' })).map(row => row.text)).toEqual([
    'Time',
    'Projects',
    'Asks',
    'This one',
    'App title',
    'Stopped',
    'Old',
  ])
  expect((await ui.findAll({ type: 'Text', text: /^(🔐 permission|💤 idle)$/ })).map(row => row.text)).toEqual([
    '🔐 permission',
    '💤 idle',
    '💤 idle',
    '💤 idle',
    '💤 idle',
  ])
  expect((await ui.findAll({ type: 'Text', text: /^ · / })).map(row => row.text)).toEqual([
    ' · 2 min',
    ' · now',
    ' · 30 min',
    ' · 2 hours',
    ' · 3 hours',
  ])
  await ui.unmount()
})

test("a press on a session's row opens it in the app", async ($, on) => {
  const filed = (state: string): string =>
    JSON.stringify({ state, note: '', since: Date.now(), cwd: '/Users/me/project', updated: Date.now() })
  const files = new Map([
    ['/Users/me/.claude/agent-state/local_b.json', filed('🔐 permission')],
  ])
  const opened: (readonly string[])[] = []
  engine(on, { HOME: '/Users/me' }, files, opened)

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button' })).map(button => button.text)).toEqual(['Time', 'Projects', 'project'])
  opened.length = 0
  await ui.press({ key: 'local_b' })
  expect(opened).toEqual([['open', 'claude://claude.ai/epitaxy/local_b']])
  await ui.unmount()
})

test("in the app, a button beside the session's modes opens the pane, and closes it while shown", async ($, on) => {
  const done: string[] = []
  let isShown = false
  on('ui.panes', () => ({ value: isShown ? [{ id: 'agent-state', title: 'Sessions', isShown, isFocused: false, isPlaced: true }] : [] }))
  on('ui.open', (_$, e) => {
    done.push(`open ${e.id}`)
    isShown = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    done.push(`close ${e.id}`)
    isShown = false
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  drawModes(on)

  const ui = await $.ui.mount({ plugin: 'agent-state', surface: 'desktop', component: 'SessionMode', props: { modes: ['auto mode on'] } })
  expect((await ui.find({ type: 'Text', text: /auto/ }))?.text).toBe('auto mode on')
  await ui.press({ key: 'sessions' })
  await ui.press({ key: 'sessions' })
  await ui.press({ key: 'sessions' })
  expect(done).toEqual(['open agent-state', 'close agent-state', 'open agent-state'])
  await ui.unmount()
})

test('under the prompt, what is beneath the mod stays: beside the button in the app, alone in the terminal', async ($, on) => {
  engine(on, { HOME: '/Users/me' }, new Map())
  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })

  const props = { modes: ['beneath'] }
  const app = await $.ui.mount({ plugin: 'agent-state', surface: 'desktop', component: 'SessionMode', props })
  expect((await app.find({ type: 'Text', text: /beneath/ }))?.text).toBe('beneath')
  expect((await app.find({ type: 'Button' }))?.text).toBe('Sessions')
  await app.unmount()

  const terminal = await $.ui.mount({ plugin: 'agent-state', surface: 'terminal', component: 'SessionMode', props })
  expect((await terminal.find({ type: 'Text', text: /beneath/ }))?.text).toBe('beneath')
  expect(await terminal.find({ type: 'Button' })).toBeUndefined()
  await terminal.unmount()
})

test('the pane lists sessions under their project, the projects from Z to A and This computer last', async ($, on) => {
  const filed = (cwd: string): string =>
    JSON.stringify({ state: '💤 idle', note: '', since: Date.now(), title: cwd, cwd, updated: Date.now() })
  const files = new Map([
    ['/Users/me/.claude/agent-state/local_a.json', filed('/Users/me/Dev/agent-state')],
    ['/Users/me/.claude/agent-state/local_b.json', filed('/Users/me/Dev/hookdrills')],
    ['/Users/me/.claude/agent-state/local_c.json', filed('/Users/me/Library/Claude/scratch-workspaces/x/scratch-1')],
    ['/Users/me/.claude/agent-state/local_d.json', filed('/Users/me/Dev/agent-state/.claude/worktrees/fix')],
    ['/Users/me/.claude/agent-state/local_e.json', filed('/Users/me/Dev/cupboardian')],
  ])
  engine(on, { HOME: '/Users/me' }, files)

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const headings = await ui.findAll({ type: 'Text', text: /^(agent-state|hookdrills|cupboardian|This computer)$/ })
  expect(headings.map(heading => heading.text)).toEqual(['hookdrills', 'cupboardian', 'agent-state', 'This computer'])
  expect((await ui.findAll({ type: 'Button', text: /^[^↑↓]+$/ })).length).toBe(7)

  // Down on the first heading, then up on the last: both moves are saved for every pane.
  await ui.press({ key: 'down:hookdrills' })
  await ui.press({ key: 'up:This computer' })
  expect(JSON.parse(files.get('/Users/me/.claude/agent-state.order.json') ?? '[]')).toEqual([
    'cupboardian',
    'hookdrills',
    'This computer',
    'agent-state',
  ])
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const moved = await again.findAll({ type: 'Text', text: /^(agent-state|hookdrills|cupboardian|This computer)$/ })
  expect(moved.map(heading => heading.text)).toEqual(['cupboardian', 'hookdrills', 'This computer', 'agent-state'])
  // The first heading has no up arrow, the last no down arrow.
  expect(await again.find({ type: 'Button', key: 'down:cupboardian' })).toBeDefined()
  expect(await again.find({ type: 'Button', key: 'up:cupboardian' })).toBeUndefined()
  expect(await again.find({ type: 'Button', key: 'down:agent-state' })).toBeUndefined()
  await again.unmount()
})

test("a session the app started in a spare folder is listed under the app's folder for it", async ($, on) => {
  const spare = '/Users/me/.claude/spares/spare-BMhKIl'
  const files = new Map([
    [
      '/Users/me/.claude/agent-state/local_a.json',
      JSON.stringify({ state: '⚙️ working', note: '', since: Date.now(), title: 'a', cwd: spare, updated: Date.now() }),
    ],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  on('mcp.call', (_$, e) => {
    const listed = { sessionId: 'local_a', title: 'a', cwd: '/Users/me/Dev/hookdrills', lastActivityAt: new Date().toISOString() }
    const text = JSON.stringify(e.tool === 'list_sessions' ? [listed] : {})
    return { value: { isError: false, content: [{ type: 'text' as const, text }] } }
  })

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'hookdrills' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /spare-/ })).toBeUndefined()
  await ui.unmount()
})

test("the app's escaped titles read as written", async ($, on) => {
  const files = new Map([
    [
      '/Users/me/.claude/agent-state/local_a.json',
      JSON.stringify({ state: '💤 idle', note: '', since: Date.now(), title: 'a', cwd: '/x', updated: Date.now() }),
    ],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  on('mcp.call', (_$, e) => {
    const title = 'Drop "from &lt;subagent&gt;" &amp; keep &amp;lt; &#39;as is&#x27;'
    const listed = { sessionId: 'local_a', title, cwd: '/x', lastActivityAt: new Date().toISOString() }
    const text = JSON.stringify(e.tool === 'list_sessions' ? [listed] : {})
    return { value: { isError: false, content: [{ type: 'text' as const, text }] } }
  })

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const names = (await ui.findAll({ type: 'Button' })).map(button => button.text)
  expect(names).toContain(`Drop "from <subagent>" & keep &lt; 'as is'`)
  await ui.unmount()
})

test("a resumed session's idle begins at its last answer, not at the restart, until its next turn", async ($, on) => {
  const files = new Map<string, string>()
  engine(on, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' }, files)
  on('classic.SessionStart', () => ({}))
  const path = '/Users/me/.claude/agent-state/local_1.json'
  const since = (): number => (JSON.parse(files.get(path) ?? '{}') as { since: number }).since
  const hour = 3_600_000

  // The idle is written first, then SessionStart says the last answer was an hour ago.
  await $.session.start({ cwd: '/Users/me/project', surface: null, isInteractive: false })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 3600 })
  // An idle written after it waits behind the rewrite, so the file reads as settled.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'none', reason: 'answer' })
  expect(Math.abs(Date.now() - hour - since())).toBeLessThan(5_000)

  // A turn after the resume dates its idle as any other.
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(Date.now() - since()).toBeLessThan(5_000)
})

test('how long a state lasted reads in words, then as when it began past a day; this session is marked', async ($, on) => {
  const now = Date.now()
  const filed = (minutesAgo: number): string =>
    JSON.stringify({ state: '💤 idle', note: '', since: now - minutesAgo * 60_000, title: `${minutesAgo}`, cwd: '/Users/me/project', updated: now })
  const files = new Map([
    ['/Users/me/.claude/agent-state/local_a.json', filed(0)],
    ['/Users/me/.claude/agent-state/local_b.json', filed(90)],
    ['/Users/me/.claude/agent-state/local_c.json', filed(180)],
    ['/Users/me/.claude/agent-state/local_d.json', filed(2 * 24 * 60)],
  ])
  engine(on, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_a' }, files)

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const lasted = (await ui.findAll({ type: 'Text', text: /^ · / })).map(row => row.text)
  // The session's own file was rewritten at its start, so it reads now.
  expect(lasted).toEqual([
    ' · now',
    ' · 1 hour',
    ' · 3 hours',
    expect.stringMatching(/^ · [A-Z][a-z]{2} \d+ \d+:\d\d$/),
  ])
  // The session's own name has a pointer; its rewritten file names no title.
  expect((await ui.findAll({ type: 'Button' })).map(row => row.text)).toEqual(['Time', 'Projects', '› project', '90', '180', '2880'])
  await ui.unmount()
})

test("a session's file is read again only once its time or size changes, or its last read was torn", async ($, on) => {
  const folder = '/Users/me/.claude/agent-state'
  const filed = (title: string): string =>
    JSON.stringify({ state: '💤 idle', note: '', since: Date.now(), title, cwd: '/x', updated: Date.now() })
  const files = new Map([
    [`${folder}/local_a.json`, filed('a')],
    [`mtime:${folder}/local_a.json`, '1'],
    [`${folder}/local_b.json`, filed('b')],
    [`mtime:${folder}/local_b.json`, '1'],
  ])
  const read: string[] = []
  engine(on, { HOME: '/Users/me' }, files, [], read)
  const draw = async (): Promise<{ names: string[]; reads: string[] }> => {
    read.length = 0
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const names = (await ui.findAll({ type: 'Button' })).map(row => row.text).slice(2)
    await ui.unmount()
    return { names, reads: read.filter(path => path.startsWith(`${folder}/`)).map(path => path.slice(folder.length + 1)) }
  }

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  expect((await draw()).names).toEqual(['a', 'b'])
  // Nothing changed: nothing is read.
  expect(await draw()).toEqual({ names: ['a', 'b'], reads: [] })

  // A new time is read; so is a new size at the same time.
  files.set(`${folder}/local_a.json`, filed('a2'))
  files.set(`mtime:${folder}/local_a.json`, '2')
  files.set(`${folder}/local_b.json`, filed('b22'))
  expect(await draw()).toEqual({ names: ['a2', 'b22'], reads: ['local_a.json', 'local_b.json'] })

  // A read caught mid-write leaves the session out, and is read again though
  // nothing changed since.
  files.set(`${folder}/local_a.json`, '{"state":')
  files.set(`mtime:${folder}/local_a.json`, '3')
  expect(await draw()).toEqual({ names: ['b22'], reads: ['local_a.json'] })
  expect(await draw()).toEqual({ names: ['b22'], reads: ['local_a.json'] })
  files.set(`${folder}/local_a.json`, filed('a3'))
  files.set(`mtime:${folder}/local_a.json`, '4')
  expect(await draw()).toEqual({ names: ['a3', 'b22'], reads: ['local_a.json'] })

  // A file gone from the folder is gone from the pane.
  files.delete(`${folder}/local_b.json`)
  expect(await draw()).toEqual({ names: ['a3'], reads: [] })
})

// The app's tools answering with these sessions as the list, and this session as {}.
// An id after `untitled:` is listed with no title, and one after `noid:` under
// another key than the session id.
const appLists = (on: On, ids: string[]): void => {
  on('mcp.call', (_$, e) => ({
    value: {
      isError: false,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            e.tool === 'list_sessions'
              ? ids.map(id => {
                  const sessionId = id.replace(/^(untitled|noid):/, '')
                  const title = id.startsWith('untitled:') ? null : sessionId
                  const row = { title, cwd: '/x', lastActivityAt: new Date().toISOString() }
                  return id.startsWith('noid:') ? { ...row, id: sessionId } : { ...row, sessionId }
                })
              : {},
          ),
        },
      ],
    },
  }))
}

const removed = (ran: (readonly string[])[]): (readonly string[])[] => ran.filter(argv => argv[0] === 'rm')

test("a fetch of the whole list deletes the files of sessions the app no longer lists", async ($, on) => {
  const folder = '/Users/me/.claude/agent-state'
  const filed = (state: string): string => JSON.stringify({ state, note: '', since: 0, cwd: '/x', updated: 0 })
  const minutesAgo = (minutes: number): string => String(Date.now() - minutes * 60_000)
  const files = new Map([
    // Listed: kept, with a title or without.
    [`${folder}/local_a.json`, filed('')],
    [`mtime:${folder}/local_a.json`, '1'],
    [`${folder}/local_untitled.json`, filed('')],
    [`mtime:${folder}/local_untitled.json`, '1'],
    // Archived or deleted, its process ended: deleted.
    [`${folder}/local_ended.json`, filed('')],
    [`mtime:${folder}/local_ended.json`, minutesAgo(2)],
    // Not listed, its process still running: kept, as a list may leave it out by
    // mistake, unless its file is a week old.
    [`${folder}/local_running.json`, filed('⚙️ working')],
    [`mtime:${folder}/local_running.json`, minutesAgo(2)],
    // One caught mid-write, its state unknown: kept.
    [`${folder}/local_torn.json`, '{"state":'],
    [`mtime:${folder}/local_torn.json`, minutesAgo(2)],
    [`${folder}/local_old.json`, filed('💤 idle')],
    [`mtime:${folder}/local_old.json`, minutesAgo(8 * 24 * 60)],
    // Written in the minute before the fetch, as by a session the list does not
    // have yet: kept.
    [`${folder}/local_new.json`, filed('')],
    [`mtime:${folder}/local_new.json`, minutesAgo(0.5)],
    // Not a session's file: kept.
    [`${folder}/notes.txt`, ''],
    [`mtime:${folder}/notes.txt`, '1'],
  ])
  const ran: (readonly string[])[] = []
  engine(on, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_me' }, files, ran)
  appLists(on, ['local_a', 'untitled:local_untitled'])

  // This session's own file, which the list leaves out: kept.
  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  files.set(`mtime:${folder}/local_me.json`, '1')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.unmount()
  expect(removed(ran)).toEqual([['rm', '-f', '--', `${folder}/local_ended.json`, `${folder}/local_old.json`]])
})

for (const [why, count] of [
  ['the limit may have cut short', 200],
  ['that came back empty', 0],
  ['with a row that has no id', 2],
] as const) {
  test(`nothing is deleted from a list ${why}`, async ($, on) => {
    const folder = '/Users/me/.claude/agent-state'
    const files = new Map([
      [`${folder}/local_gone.json`, JSON.stringify({ state: '', note: '', since: 0, cwd: '/x', updated: 0 })],
      [`mtime:${folder}/local_gone.json`, '1'],
    ])
    const ran: (readonly string[])[] = []
    engine(on, { HOME: '/Users/me' }, files, ran)
    appLists(on, Array.from({ length: count }, (_, i) => (count === 2 && i === 1 ? 'noid:local_gone' : `local_${i}`)))

    await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.unmount()
    expect(removed(ran)).toEqual([])
  })
}

test('nothing is deleted without a fetched list: from the saved one, or after a fetch that failed', async ($, on) => {
  const folder = '/Users/me/.claude/agent-state'
  const files = new Map([
    [`${folder}/local_gone.json`, JSON.stringify({ state: '', note: '', since: 0, cwd: '/x', updated: 0 })],
    [`mtime:${folder}/local_gone.json`, '1'],
    [`${folder}.sessions.json`, JSON.stringify([['local_a', { title: 'a', cwd: '/x', lastActivity: 0 }]])],
  ])
  const ran: (readonly string[])[] = []
  engine(on, { HOME: '/Users/me' }, files, ran)
  on('mcp.call', () => ({ value: { isError: true, content: [] } }))

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button' })).map(row => row.text).slice(2)).toEqual(['a'])
  await ui.unmount()
  expect(removed(ran)).toEqual([])
})

test('the button under the prompt counts the sessions in each state, what waits on the person first', async ($, on) => {
  const filed = (state: string): string =>
    JSON.stringify({ state, note: '', since: Date.now(), cwd: '/x', updated: Date.now() })
  const files = new Map([
    ['/Users/me/.claude/agent-state/local_a.json', filed('🔐 permission')],
    ['/Users/me/.claude/agent-state/local_b.json', filed('🔐 permission')],
    ['/Users/me/.claude/agent-state/local_c.json', filed('❓ input')],
    ['/Users/me/.claude/agent-state/local_d.json', filed('⚙️ working')],
    ['/Users/me/.claude/agent-state/local_e.json', filed('🧵 background')],
    ['/Users/me/.claude/agent-state/local_f.json', filed('💤 idle')],
    ['/Users/me/.claude/agent-state/local_g.json', filed('💤 idle')],
    ['/Users/me/.claude/agent-state/local_h.json', filed('📦 compacting')],
    ['/Users/me/.claude/agent-state/local_i.json', filed('')],
  ])
  engine(on, { HOME: '/Users/me' }, files)

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ plugin: 'agent-state', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  expect((await ui.find({ type: 'Button' }))?.text).toBe('Sessions · 🔐2 ❓1 📦1 ⚙️1 🧵1 💤2')
  await ui.unmount()
})

test("an idle session whose last turn asked the person something needs them, as the app's record says", async ($, on) => {
  const now = Date.now()
  const folder = '/Users/me/.claude/agent-state'
  const records = '/Users/me/Library/Application Support/Claude/claude-code-sessions/account/org'
  const filed = (state: string, title: string, minutesAgo: number): string =>
    JSON.stringify({ state, note: '', since: now - minutesAgo * 60_000, title, cwd: '/x', updated: now, prompted: now })
  const record = (fields: object): string => JSON.stringify({ lastAssistantUuid: 'u2', ...fields })
  const asked = { description: 'Done.', needsUser: 'Ship it?' }
  const files = new Map([
    [`${folder}/local_asked.json`, filed('💤 idle', 'asked', 1)],
    [`${records}/local_asked.json`, record({ turnWrapUp: asked })],
    [`mtime:${records}/local_asked.json`, '1'],
    // The wrap-up asked nothing: a summary that says blocked does not count over it.
    [`${folder}/local_told.json`, filed('💤 idle', 'told', 2)],
    [
      `${records}/local_told.json`,
      record({ turnWrapUp: { description: 'Done.' }, postTurnSummary: { status_category: 'blocked' }, postTurnSummaryFor: 'u2' }),
    ],
    // A turn that failed is not a question.
    [`${folder}/local_failed.json`, filed('💤 idle', 'failed', 3)],
    [`${records}/local_failed.json`, record({ turnWrapUp: asked, postTurnSummary: { status_category: 'failed' } })],
    // With no wrap-up, a summary counts when it is of the last message.
    [`${folder}/local_summary.json`, filed('💤 idle', 'summary', 4)],
    [`${records}/local_summary.json`, record({ postTurnSummary: { status_category: 'need_input' }, postTurnSummaryFor: 'u2' })],
    [`mtime:${records}/local_summary.json`, '1'],
    [`${folder}/local_stale.json`, filed('💤 idle', 'stale', 5)],
    [`${records}/local_stale.json`, record({ postTurnSummary: { status_category: 'blocked' }, postTurnSummaryFor: 'u1' })],
    // Running: whatever its record says, it is working.
    [`${folder}/local_working.json`, filed('⚙️ working', 'working', 6)],
    [`${records}/local_working.json`, record({ turnWrapUp: asked })],
    // Caught mid-write, and none at all.
    [`${folder}/local_torn.json`, filed('💤 idle', 'torn', 7)],
    [`${records}/local_torn.json`, '{"turnWrapUp":'],
    [`mtime:${records}/local_torn.json`, '1'],
    [`${folder}/local_none.json`, filed('💤 idle', 'none', 8)],
    // Idle with a background command still running: the app counts it as running.
    [`${folder}/local_busy.json`, JSON.stringify({ ...JSON.parse(filed('💤 idle', 'busy', 9)), note: '⏳1' })],
    [`${records}/local_busy.json`, record({ turnWrapUp: asked })],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  const state = /^(💤 idle|⚙️ working|🙋 needs you)$/

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Each session that needs the person has Dismiss after its name.
  expect((await ui.findAll({ type: 'Button' })).map(row => row.text)).toEqual([
    'Time',
    'Projects',
    'asked',
    'Dismiss',
    'summary',
    'Dismiss',
    'working',
    'told',
    'failed',
    'stale',
    'torn',
    'none',
    'busy',
  ])
  const states = await ui.findAll({ type: 'Text', text: state })
  expect(states.map(one => one.text)).toEqual([
    '🙋 needs you',
    '🙋 needs you',
    '⚙️ working',
    '💤 idle',
    '💤 idle',
    '💤 idle',
    '💤 idle',
    '💤 idle',
    '💤 idle',
  ])
  expect(states[0]?.props.color).toBe('error')
  await ui.unmount()

  const button = await $.ui.mount({ plugin: 'agent-state', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  expect((await button.find({ type: 'Button' }))?.text).toBe('Sessions · 🙋2 ⚙️1 💤6')
  await button.unmount()

  // By time, it is in Recent, with Pin and no → Today, as a dialog's session is.
  files.set('store:isByTime', 'true')
  const byTime = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const keys = (await byTime.findAll({ type: 'Button', text: /^(→ Today|Pin)$/ })).map(one => one.key)
  expect(keys).toContain('pin:local_asked')
  expect(keys).not.toContain('today:local_asked')
  await byTime.unmount()

  // Answered: the app clears the wrap-up, and the record is read again as its time
  // changed. A record whose time did not change is not read again, unless the last
  // read caught it mid-write.
  files.set(`${records}/local_asked.json`, record({}))
  files.set(`mtime:${records}/local_asked.json`, '2')
  files.set(`${records}/local_summary.json`, record({}))
  files.set(`${records}/local_torn.json`, record({ turnWrapUp: asked }))
  files.set('store:isByTime', 'false')
  const answered = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await answered.findAll({ type: 'Button', text: /^(?!Dismiss$)/ })).map(one => one.text).slice(2, 5)).toEqual([
    'summary',
    'torn',
    'working',
  ])
  expect((await answered.findAll({ type: 'Text', text: '🙋 needs you' })).length).toBe(2)
  await answered.unmount()

  // A read caught mid-write keeps the question the last read found. A record gone
  // from the folder has none.
  files.set(`${records}/local_torn.json`, '{"turnWrapUp":')
  files.set(`mtime:${records}/local_torn.json`, '3')
  files.delete(`${records}/local_summary.json`)
  const torn = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await torn.findAll({ type: 'Button' })).map(one => one.text)[2]).toBe('torn')
  expect((await torn.findAll({ type: 'Text', text: '🙋 needs you' })).length).toBe(1)
  await torn.unmount()

  // A folder that is there but fails to list once keeps what its sessions said.
  files.set(`fail:${records}`, '')
  const failed = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await failed.findAll({ type: 'Text', text: '🙋 needs you' })).length).toBe(1)
  await failed.unmount()
  // Gone for good: no question is left.
  files.delete(`fail:${records}`)
  for (const path of [...files.keys()]) if (path.startsWith(`${records}/`)) files.delete(path)
  const gone = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await gone.findAll({ type: 'Text', text: '🙋 needs you' })).length).toBe(0)
  await gone.unmount()
})

test("the mod's own fetch of the app's list leaves a permission up", async ($, on) => {
  const files = new Map<string, string>()
  engine(on, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' }, files)
  on('classic.PermissionRequest', () => ({}))
  on('tool.call', () => ({ result: {} }))
  // The engine raises tool.call on the main loop for the mod's call, as a model's.
  on('mcp.call', async (_$, e) => {
    await $.tool.call({ tool: `mcp__${e.server}__${e.tool}`, ...e.args } as never)
    return { value: { isError: false, content: [{ type: 'text' as const, text: '[]' }] } }
  })
  const path = '/Users/me/.claude/agent-state/local_1.json'

  await $.session.start({ cwd: '/Users/me/project', surface: null, isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  expect(stateIn(files, path)).toBe('🔐 permission')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.unmount()
  expect(stateIn(files, path)).toBe('🔐 permission')
})

test("a list the app gives as text that is not JSON draws the files, and the model's own call to the app's tools still counts", async ($, on) => {
  const files = new Map([
    ['/Users/me/.claude/agent-state/local_a.json', JSON.stringify({ state: '💤 idle', note: '', since: Date.now(), title: 'a', cwd: '/x', updated: 0 })],
  ])
  engine(on, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' }, files)
  on('classic.PermissionRequest', () => ({}))
  on('tool.call', () => ({ result: {} }))
  on('mcp.call', () => ({ value: { isError: false, content: [{ type: 'text' as const, text: 'not JSON' }] } }))
  const path = '/Users/me/.claude/agent-state/local_1.json'

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button' })).map(row => row.text)).toContain('a')
  await ui.unmount()

  // The fetch is over: the model's call to the same tools, once approved, is its
  // own, and its end shows working again.
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.PermissionRequest({ tool_name: 'mcp__ccd_session_mgmt__list_sessions', tool_input: {} })
  expect(stateIn(files, path)).toBe('🔐 permission')
  await $.tool.call({ tool: 'mcp__ccd_session_mgmt__list_sessions', tool_use_id: 'u1' } as never)
  expect(stateIn(files, path)).toBe('⚙️ working')
})

test('the app attaching to a session leaves the pane closed', async ($, on) => {
  const opened: string[] = []
  let ticks = 0
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('clock.every', () => {
    ticks += 1
    return { value: undefined }
  })
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })

  expect(opened).toEqual([])
  // The button's count still redraws, on one timer.
  expect(ticks).toBe(1)
})

test('the timer redraws only while the app shows the session, and switching back redraws at once', async ($, on) => {
  let draws = 0
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    draws += 1
    const { Text } = $.ui.resolve(e)
    return <Text>modes</Text>
  })
  let surfaces: 'desktop'[] = ['desktop']
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  const clock = mock.clock(on)
  const attach = () => $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })

  await attach()
  const ui = await $.ui.mount({ plugin: 'agent-state', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  const shown = draws
  await clock.advance(3000)
  expect(draws).toBe(shown + 3)

  // The person switched to another session: no surface, no redraws.
  surfaces = []
  const away = draws
  await clock.advance(3000)
  expect(draws).toBe(away)

  // And back: drawn at the attach, then on each tick again.
  surfaces = ['desktop']
  await attach()
  await clock.settle()
  expect(draws).toBe(away + 1)
  await clock.advance(1000)
  expect(draws).toBe(away + 2)
  await ui.unmount()
})

test("switching back to a session draws the list the session on screen saved, not the one it held while hidden", async ($, on) => {
  const path = '/Users/me/.claude/agent-state.sessions.json'
  const listed = (title: string) => JSON.stringify([['local_a', { title, cwd: '/x', lastActivity: Date.now() }]])
  const files = new Map([[path, listed('Old title')]])
  engine(on, { HOME: '/Users/me' }, files)
  // The app's tools fail: the list is only ever the saved one.
  on('mcp.call', () => {
    throw new Error('no app tools')
  })
  let surfaces: 'desktop'[] = ['desktop']
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  const clock = mock.clock(on)
  const attach = () => $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  const names = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ text: string }[]> }) =>
    (await ui.findAll({ type: 'Button' })).map(row => row.text).slice(2)

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  await attach()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await names(ui)).toEqual(['Old title'])

  // Hidden while the session on screen saves a newer list.
  surfaces = []
  files.set(path, listed('New title'))
  await clock.advance(3000)

  surfaces = ['desktop']
  await attach()
  await clock.settle()
  expect(await names(ui)).toEqual(['New title'])

  // A switch the roster lists late still takes the saved list, for the next tick to draw.
  surfaces = []
  files.set(path, listed('Newer title'))
  await clock.advance(3000)
  await attach()
  surfaces = ['desktop']
  await clock.advance(1000)
  expect(await names(ui)).toEqual(['Newer title'])
  await ui.unmount()
})

test('the pane is open or closed for every session: each follows the shared choice', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' }, files)
  const path = '/Users/me/.claude/agent-state.pane.json'
  const done: string[] = []
  let isOpen = false
  on('ui.panes', () => ({
    value: isOpen ? [{ id: 'agent-state', title: 'Sessions', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', () => {
    done.push('open')
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    done.push('close')
    isOpen = false
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  let surfaces: 'desktop'[] = ['desktop']
  on('session.surfaces', () => ({ value: surfaces }))
  const follow = () => $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  // A session the app is not showing does not try, to open or to close.
  files.set(path, 'true')
  surfaces = []
  await follow()
  expect(done).toEqual([])
  isOpen = true
  files.set(path, 'false')
  await follow()
  expect(done).toEqual([])
  isOpen = false
  surfaces = ['desktop']
  files.delete(path)

  // Nothing chosen yet: closed.
  await follow()
  expect(done).toEqual([])

  // Another session chose open, then closed.
  files.set(path, 'true')
  await follow()
  await follow()
  expect(done).toEqual(['open'])
  files.set(path, 'false')
  await follow()
  await follow()
  expect(done).toEqual(['open', 'close'])

  // The button here writes the choice for the others.
  const ui = await $.ui.mount({ plugin: 'agent-state', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  await ui.press({ key: 'sessions' })
  expect(files.get(path)).toBe('true')
  await ui.press({ key: 'sessions' })
  expect(files.get(path)).toBe('false')
  await ui.unmount()
})

test('a restarted session draws from the saved list before its fetch ends, and saves what it fetches', async ($, on) => {
  const path = '/Users/me/.claude/agent-state.sessions.json'
  const saved = { title: 'Saved title', cwd: '/x', lastActivity: Date.now() }
  const files = new Map([[path, JSON.stringify([['local_a', saved]])]])
  engine(on, { HOME: '/Users/me' }, files)
  let release = (): void => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  on('mcp.call', async (_$, e) => {
    await held
    const listed = { sessionId: 'local_b', title: 'Fetched title', cwd: '/x', lastActivityAt: new Date().toISOString() }
    return {
      value: {
        isError: false,
        content: [{ type: 'text' as const, text: JSON.stringify(e.tool === 'list_sessions' ? [listed] : {}) }],
      },
    }
  })

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  // The fetch is held, yet the pane draws.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button' })).map(row => row.text)).toEqual(['Time', 'Projects', 'Saved title'])
  await ui.unmount()

  release()
  // Let the held fetch finish and write.
  for (let turn = 0; turn < 1000; turn += 1) await Promise.resolve()
  const again = JSON.parse(files.get(path) ?? '[]') as [string, unknown][]
  expect(again.map(([id]) => id)).toEqual(['local_b'])
})

const LISTED = (id: string, cwd: string, at: number) => ({
  sessionId: id,
  title: id,
  cwd,
  lastActivityAt: new Date(at).toISOString(),
})

test('by time, the boxes rank by the last message, and Recent holds what still runs or just ran', async ($, on) => {
  const now = Date.now()
  const hours = (count: number): number => now - count * 60 * 60 * 1000
  const filed = (state: string, prompted: number): string =>
    JSON.stringify({ state, note: '', since: now, cwd: '/Users/me/Dev/alpha', updated: now, prompted })
  const files = new Map([
    ['store:isByTime', 'true'],
    ['/Users/me/.claude/agent-state/local_latest.json', filed('💤 idle', hours(0))],
    ['/Users/me/.claude/agent-state/local_window.json', filed('💤 idle', hours(1))],
    ['/Users/me/.claude/agent-state/local_working.json', filed('⚙️ working', hours(4))],
    ['/Users/me/.claude/agent-state/local_ran.json', filed('💤 idle', hours(3.5))],
    ['/Users/me/.claude/agent-state/local_today.json', filed('💤 idle', hours(3))],
    ['/Users/me/.claude/agent-state/local_older.json', filed('💤 idle', hours(30))],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  const app = '/Users/me/Dev/alpha'
  const listed = [
    LISTED('local_latest', app, hours(0)),
    LISTED('local_window', app, hours(1)),
    LISTED('local_working', app, hours(4)),
    LISTED('local_ran', app, hours(1.5)),
    LISTED('local_today', app, hours(3)),
    LISTED('local_older', app, hours(30)),
    // No file, so no message on record: its last activity stands in.
    LISTED('local_unfiled', app, hours(5)),
  ]
  on('mcp.call', (_$, e) => ({
    value: {
      isError: false,
      content: [{ type: 'text' as const, text: JSON.stringify(e.tool === 'list_sessions' ? listed : {}) }],
    },
  }))

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const headings = await ui.findAll({ type: 'Text', text: /^(Recent|Today|Older)$/ })
  // Three hours ago is yesterday in the small hours, and no Today box is left.
  const isTodayShown = hours(3) >= new Date(now).setHours(0, 0, 0, 0)
  expect(headings.map(heading => heading.text)).toEqual(isTodayShown ? ['Recent', 'Today', 'Older'] : ['Recent', 'Older'])
  expect((await ui.findAll({ type: 'Button', text: /^local_/ })).map(row => row.text)).toEqual([
    'local_latest',
    'local_window',
    'local_ran',
    'local_working',
    'local_today',
    'local_unfiled',
    'local_older',
  ])
  // Each row names its project, and no heading has arrows.
  expect((await ui.findAll({ type: 'Text', text: /^alpha$/ })).length).toBe(7)
  expect(await ui.find({ type: 'Button', text: '↓' })).toBeUndefined()
  await ui.unmount()
})

test('in both views, waiting on the person is error, others success until idle, then warning in Recent and dim outside it', async ($, on) => {
  const now = Date.now()
  const hours = (count: number): number => now - count * 60 * 60 * 1000
  const filed = (state: string, cwd: string, prompted: number): string =>
    JSON.stringify({ state, note: '', since: now, cwd, updated: now, prompted })
  const alpha = '/Users/me/Dev/alpha'
  // Alone in its project, so a rule read per project would call it Recent.
  const beta = '/Users/me/Dev/beta'
  const folder = '/Users/me/.claude/agent-state'
  const files = new Map([
    [`${folder}/local_latest.json`, filed('💤 idle', alpha, hours(0))],
    [`${folder}/local_ran.json`, filed('💤 idle', alpha, hours(3.5))],
    [`${folder}/local_today.json`, filed('💤 idle', alpha, hours(3))],
    [`${folder}/local_older.json`, filed('💤 idle', beta, hours(30))],
    // Old messages: what has not come to rest takes its color whenever it was sent.
    [`${folder}/local_working.json`, filed('⚙️ working', alpha, hours(30))],
    [`${folder}/local_permission.json`, filed('🔐 permission', alpha, hours(30))],
    [`${folder}/local_input.json`, filed('❓ input', alpha, hours(30))],
    [`${folder}/local_background.json`, filed('🧵 background', alpha, hours(30))],
    [`${folder}/local_compacting.json`, filed('📦 compacting', alpha, hours(30))],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  const listed = [
    LISTED('local_latest', alpha, hours(0)),
    LISTED('local_ran', alpha, hours(1.5)),
    LISTED('local_today', alpha, hours(3)),
    LISTED('local_older', beta, hours(30)),
    LISTED('local_working', alpha, hours(30)),
    LISTED('local_permission', alpha, hours(30)),
    LISTED('local_input', alpha, hours(30)),
    LISTED('local_background', alpha, hours(30)),
    LISTED('local_compacting', alpha, hours(30)),
    // No file, so idle, and dim like any other idle outside Recent.
    LISTED('local_unfiled', alpha, hours(5)),
  ]
  on('mcp.call', (_$, e) => ({
    value: {
      isError: false,
      content: [{ type: 'text' as const, text: JSON.stringify(e.tool === 'list_sessions' ? listed : {}) }],
    },
  }))
  const state = /^(💤 idle|⚙️ working|🔐 permission|❓ input|🧵 background|📦 compacting)$/
  const error = { color: 'error', dimColor: undefined }
  const success = { color: 'success', dimColor: undefined }
  const warning = { color: 'warning', dimColor: undefined }
  const dim = { color: undefined, dimColor: true }

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  for (const isByTime of [true, false]) {
    files.set('store:isByTime', String(isByTime))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const names = await ui.findAll({ type: 'Button', text: /^local_/ })
    const states = await ui.findAll({ type: 'Text', text: state })
    // Each row draws its name, then its state, so the two lists pair up.
    expect(states.length).toBe(names.length)
    const colors = Object.fromEntries(
      names.map((name, at) => {
        const props = states[at]?.props
        return [name.text, { color: props?.color, dimColor: props?.dimColor }]
      }),
    )
    expect(colors).toEqual({
      local_latest: warning,
      local_ran: warning,
      local_today: dim,
      local_older: dim,
      local_unfiled: dim,
      local_working: success,
      local_permission: error,
      local_input: error,
      local_background: success,
      local_compacting: success,
    })
    await ui.unmount()
  }
})

test('by time, a box with no session is left out', async ($, on) => {
  const now = Date.now()
  const files = new Map([
    ['store:isByTime', 'true'],
    [
      '/Users/me/.claude/agent-state/local_a.json',
      JSON.stringify({ state: '💤 idle', note: '', since: now, cwd: '/x', updated: now, prompted: now }),
    ],
  ])
  engine(on, { HOME: '/Users/me' }, files)

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const headings = await ui.findAll({ type: 'Text', text: /^(Recent|Today|Older)$/ })
  expect(headings.map(heading => heading.text)).toEqual(['Recent'])
  await ui.unmount()
})

test('by time, an idle session in Recent moves to Today, for every pane, until it gets a message again', async ($, on) => {
  const now = Date.now()
  const hours = (count: number): number => now - count * 60 * 60 * 1000
  const folder = '/Users/me/.claude/agent-state'
  const filed = (state: string, prompted: number): string =>
    JSON.stringify({ state, note: '', since: now, cwd: '/Users/me/Dev/alpha', updated: now, prompted })
  const files = new Map([
    ['store:isByTime', 'true'],
    [`${folder}/local_latest.json`, filed('💤 idle', hours(0))],
    [`${folder}/local_working.json`, filed('⚙️ working', hours(0.5))],
    // Recent by its activity, its message from yesterday: once moved, it is in Today.
    [`${folder}/local_ran.json`, filed('💤 idle', hours(30))],
    // Recent by its message: a run after the move brings it back.
    [`${folder}/local_window.json`, filed('💤 idle', hours(1))],
    [`${folder}/local_older.json`, filed('💤 idle', hours(30))],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  const app = '/Users/me/Dev/alpha'
  const listed = [
    LISTED('local_latest', app, hours(0)),
    LISTED('local_working', app, hours(0.5)),
    LISTED('local_ran', app, hours(1)),
    LISTED('local_window', app, hours(1)),
    LISTED('local_older', app, hours(30)),
  ]
  on('mcp.call', (_$, e) => ({
    value: {
      isError: false,
      content: [{ type: 'text' as const, text: JSON.stringify(e.tool === 'list_sessions' ? listed : {}) }],
    },
  }))
  // The headings and the names as drawn, so each name follows its box.
  const boxes = async (ui: { findAll: (query: { text: RegExp }) => Promise<{ text: string }[]> }): Promise<string[]> =>
    (await ui.findAll({ text: /^(Recent|Today|Older|local_\w+)$/ })).map(one => one.text)

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await boxes(ui)).toEqual(['Recent', 'local_latest', 'local_working', 'local_window', 'local_ran', 'Older', 'local_older'])
  // Only the idle sessions in Recent have the button.
  expect((await ui.findAll({ type: 'Button', text: '→ Today' })).map(one => one.key)).toEqual([
    'today:local_latest',
    'today:local_window',
    'today:local_ran',
  ])
  await ui.press({ key: 'today:local_ran' })
  await ui.press({ key: 'today:local_window' })
  await ui.unmount()
  // A restart writes idle again with a new `since`: nothing ran, so the move holds.
  files.set(
    `${folder}/local_window.json`,
    JSON.stringify({ state: '💤 idle', note: '', since: Date.now() + 1, cwd: app, updated: Date.now() + 1, prompted: hours(1) }),
  )

  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await boxes(again)).toEqual([
    'Recent',
    'local_latest',
    'local_working',
    'Today',
    'local_window',
    'local_ran',
    'Older',
    'local_older',
  ])
  // Its color stays as Recent gives it, the same in both views.
  expect((await again.findAll({ type: 'Text', text: '💤 idle' })).map(one => one.props.color)).toEqual([
    'warning',
    'warning',
    'warning',
    undefined,
  ])
  await again.unmount()

  // The projects have no such button.
  files.set('store:isByTime', 'false')
  const projects = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await projects.find({ type: 'Button', text: '→ Today' })).toBeUndefined()
  await projects.unmount()

  // A message after the move brings one back, and a run that came to rest the other.
  files.set('store:isByTime', 'true')
  const later = Date.now() + 1
  files.set(`${folder}/local_ran.json`, filed('💤 idle', later))
  files.set(
    `${folder}/local_window.json`,
    JSON.stringify({ state: '💤 idle', note: '', since: later, cwd: app, updated: later, prompted: hours(1), ranAt: later }),
  )
  const back = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await boxes(back)).toEqual(['Recent', 'local_ran', 'local_latest', 'local_working', 'local_window', 'Older', 'local_older'])
  await back.press({ key: 'today:local_latest' })
  // A session that started running since the draw is not moved.
  files.set(`${folder}/local_ran.json`, JSON.stringify({ ...JSON.parse(files.get(`${folder}/local_ran.json`) ?? '{}'), state: '⚙️ working' }))
  await back.press({ key: 'today:local_ran' })
  await back.unmount()
  // A move that no longer holds is forgotten with the next one.
  expect(Object.keys(JSON.parse(files.get('store:movedToToday') ?? '{}') as object)).toEqual(['local_latest'])
})

test("by time, a move holds though the app's clock runs ahead of this one", async ($, on) => {
  const now = Date.now()
  const folder = '/Users/me/.claude/agent-state'
  const app = '/Users/me/Dev/alpha'
  const files = new Map([
    ['store:isByTime', 'true'],
    [`${folder}/local_a.json`, JSON.stringify({ state: '💤 idle', note: '', since: now, cwd: app, updated: now, prompted: now })],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  // The app dates its last activity a minute after this clock's now.
  const listed = [LISTED('local_a', app, now + 60_000)]
  on('mcp.call', (_$, e) => ({
    value: {
      isError: false,
      content: [{ type: 'text' as const, text: JSON.stringify(e.tool === 'list_sessions' ? listed : {}) }],
    },
  }))

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'today:local_a' })
  await ui.unmount()

  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const headings = await again.findAll({ type: 'Text', text: /^(Recent|Today|Older)$/ })
  expect(headings.map(heading => heading.text)).toEqual(['Today'])
  await again.unmount()
})

test('by time, a pinned session stays in Recent, in its place by time, for every pane, until unpinned', async ($, on) => {
  const now = Date.now()
  const hours = (count: number): number => now - count * 60 * 60 * 1000
  const folder = '/Users/me/.claude/agent-state'
  const app = '/Users/me/Dev/alpha'
  const filed = (state: string, prompted: number): string =>
    JSON.stringify({ state, note: '', since: now, cwd: app, updated: now, prompted })
  const files = new Map([
    ['store:isByTime', 'true'],
    [`${folder}/local_latest.json`, filed('💤 idle', hours(0))],
    // Recent only while it works: its message is from yesterday.
    [`${folder}/local_job.json`, filed('⚙️ working', hours(30))],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  const listed = [LISTED('local_latest', app, hours(0)), LISTED('local_job', app, hours(30))]
  on('mcp.call', (_$, e) => ({
    value: {
      isError: false,
      content: [{ type: 'text' as const, text: JSON.stringify(e.tool === 'list_sessions' ? listed : {}) }],
    },
  }))
  const boxes = async (ui: { findAll: (query: { text: RegExp }) => Promise<{ text: string }[]> }): Promise<string[]> =>
    (await ui.findAll({ text: /^(Recent|Today|Older|local_\w+)$/ })).map(one => one.text)
  const keys = async (
    ui: { findAll: (query: { type: 'Button'; text: string }) => Promise<{ key?: string | null }[]> },
    text: string,
  ): Promise<unknown[]> => (await ui.findAll({ type: 'Button', text })).map(one => one.key)

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await boxes(ui)).toEqual(['Recent', 'local_latest', 'local_job'])
  // Every session in Recent can be pinned, a working one too.
  expect(await keys(ui, 'Pin')).toEqual(['pin:local_latest', 'pin:local_job'])
  await ui.press({ key: 'pin:local_job' })
  await ui.unmount()
  files.set(`${folder}/local_job.json`, filed('💤 idle', hours(30)))

  // At rest it would sink to Older; pinned, it stays in Recent, below the newer
  // message, with no button to Today, its color dim as Recent's own rule gives it.
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await boxes(again)).toEqual(['Recent', 'local_latest', 'local_job'])
  expect(await keys(again, 'Unpin')).toEqual(['pin:local_job'])
  expect(await keys(again, 'Pin')).toEqual(['pin:local_latest'])
  expect(await keys(again, '→ Today')).toEqual(['today:local_latest'])
  expect((await again.findAll({ type: 'Text', text: '💤 idle' })).map(one => one.props.color)).toEqual([
    'warning',
    undefined,
  ])
  await again.press({ key: 'pin:local_job' })
  await again.unmount()

  const unpinned = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await boxes(unpinned)).toEqual(['Recent', 'local_latest', 'Older', 'local_job'])
  expect(await keys(unpinned, 'Pin')).toEqual(['pin:local_latest'])
  await unpinned.unmount()

  // The projects have no pins.
  files.set('store:isByTime', 'false')
  const projects = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await projects.find({ type: 'Button', text: 'Pin' })).toBeUndefined()
  await projects.unmount()
})

test('by time, pins sit in Recent by last message with the rest, Unpin forgets a move made under the pin, and an unlisted pin stays', async ($, on) => {
  const now = Date.now()
  const hours = (count: number): number => now - count * 60 * 60 * 1000
  const folder = '/Users/me/.claude/agent-state'
  const app = '/Users/me/Dev/alpha'
  const filed = (prompted: number): string =>
    JSON.stringify({ state: '💤 idle', note: '', since: now, cwd: app, updated: now, prompted })
  const files = new Map([
    ['store:isByTime', 'true'],
    // A session the app no longer lists, archived or past its list's end.
    ['store:pinnedToRecent', JSON.stringify({ local_gone: hours(40) })],
    [`${folder}/local_a.json`, filed(hours(0))],
    [`${folder}/local_d.json`, filed(hours(0.5))],
    [`${folder}/local_b.json`, filed(hours(1))],
    [`${folder}/local_c.json`, filed(hours(30))],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  const listed = [
    LISTED('local_a', app, hours(0)),
    LISTED('local_d', app, hours(0.5)),
    LISTED('local_b', app, hours(1)),
    LISTED('local_c', app, hours(30)),
  ]
  on('mcp.call', (_$, e) => ({
    value: {
      isError: false,
      content: [{ type: 'text' as const, text: JSON.stringify(e.tool === 'list_sessions' ? listed : {}) }],
    },
  }))
  const boxes = async (ui: { findAll: (query: { text: RegExp }) => Promise<{ text: string }[]> }): Promise<string[]> =>
    (await ui.findAll({ text: /^(Recent|Today|Older|local_\w+)$/ })).map(one => one.text)
  const stored = (key: string): string[] => Object.keys(JSON.parse(files.get(`store:${key}`) ?? '{}') as object).sort()

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await boxes(ui)).toEqual(['Recent', 'local_a', 'local_d', 'local_b', 'Older', 'local_c'])
  // Since this pane drew, another pins a and c; this one still offers a's move, and it lands.
  files.set('store:pinnedToRecent', JSON.stringify({ local_gone: hours(40), local_a: now, local_c: now }))
  await ui.press({ key: 'today:local_a' })
  // Since that draw, another moves b to Today; this one still offers b's pin, and it
  // lands. Each holds a pin and a move, and the pin wins.
  files.set('store:movedToToday', JSON.stringify({ ...JSON.parse(files.get('store:movedToToday') ?? '{}'), local_b: now + 1 }))
  await ui.press({ key: 'pin:local_b' })
  await ui.unmount()
  expect(stored('movedToToday')).toEqual(['local_a', 'local_b'])
  expect(stored('pinnedToRecent')).toEqual(['local_a', 'local_b', 'local_c', 'local_gone'])

  const pinned = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await boxes(pinned)).toEqual(['Recent', 'local_a', 'local_d', 'local_b', 'local_c'])
  await pinned.press({ key: 'pin:local_b' })
  await pinned.press({ key: 'pin:local_a' })
  await pinned.unmount()

  // Unpinned, each goes back where its own times put it, not to Today.
  const unpinned = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await boxes(unpinned)).toEqual(['Recent', 'local_a', 'local_d', 'local_b', 'local_c'])
  await unpinned.unmount()
  expect(stored('movedToToday')).toEqual([])
  expect(stored('pinnedToRecent')).toEqual(['local_c', 'local_gone'])
})

test('the view buttons switch between the projects and the time boxes, for every pane', async ($, on) => {
  const now = Date.now()
  const files = new Map([
    // No choice made yet, as the store answers for a key never set: the boxes are the default.
    ['store:isByTime', 'null'],
    [
      '/Users/me/.claude/agent-state/local_a.json',
      JSON.stringify({ state: '💤 idle', note: '', since: now, cwd: '/Users/me/Dev/alpha', updated: now }),
    ],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  const path = 'store:isByTime'
  const box = /^Recent$/

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: box })).toBeDefined()
  await ui.press({ key: 'view:projects' })
  expect(files.get(path)).toBe('false')
  await ui.unmount()

  const projects = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await projects.find({ type: 'Text', text: box })).toBeUndefined()
  await projects.press({ key: 'view:time' })
  expect(files.get(path)).toBe('true')
  await projects.unmount()

  const back = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await back.find({ type: 'Text', text: box })).toBeDefined()
  await back.unmount()
})

test('a message and a run are filed with the session, and a restarted process keeps them', async ($, on) => {
  const path = '/Users/me/.claude/agent-state/local_1.json'
  const files = new Map([
    [path, JSON.stringify({ state: '💤 idle', note: '', since: 1, cwd: '/x', updated: 1, prompted: 1234, ranAt: 5678 })],
  ])
  engine(on, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' }, files)
  on('classic.UserPromptSubmit', () => ({}))
  const promptedIn = (): unknown => (JSON.parse(files.get(path) ?? '{}') as { prompted?: unknown }).prompted
  const ranIn = (): unknown => (JSON.parse(files.get(path) ?? '{}') as { ranAt?: unknown }).ranAt

  // The first write after a restart keeps what the file held.
  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  expect(promptedIn()).toBe(1234)
  expect(ranIn()).toBe(5678)

  const before = Date.now()
  await $.classic.UserPromptSubmit({ prompt: 'hi' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(stateIn(files, path)).toBe('⚙️ working')
  expect(promptedIn()).toBeGreaterThanOrEqual(before)
  expect(ranIn()).toBeGreaterThanOrEqual(before)

  // The end of the session keeps it too.
  const sent = promptedIn()
  await $.session.end({ reason: 'other', sessionId: 'own-id', resume: { id: 'own-id' } })
  expect(stateIn(files, path)).toBe('')
  expect(promptedIn()).toBe(sent)
})

test('the 🔔 Alert menu sits at the far right of the view buttons, offers Off and each sound by a short name, and plays a pick', async ($, on) => {
  const files = new Map([
    [
      '/Users/me/.claude/agent-state/local_a.json',
      JSON.stringify({ state: '💤 idle', note: '', since: Date.now(), cwd: '/x', updated: Date.now() }),
    ],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  const played: unknown[] = []
  on('audio.play', (_$, e) => {
    played.push(e.clip)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const menu = await ui.find({ type: 'Select', key: 'sound' })
  expect(menu?.props.label).toBe('🔔 Alert')
  expect(menu?.props.value).toBe('off')
  expect((menu?.props.options as { label: string }[]).map(option => option.label)).toEqual([
    'Off',
    'ping',
    'short-ping',
    'bell-ting-1',
    'bell-ting-2',
    'up',
    'plunk',
    'glass-ping',
    'notification',
    'dingaling',
  ])
  // One line: the view buttons' track first, the menu last, pushed apart.
  const header = ((await ui.drawn()) as unknown as { children: unknown[] }).children[0] as { props: Record<string, unknown>; children: { type: string }[] }
  expect(header.props.justifyContent).toBe('space-between')
  expect(header.children.map(child => child.type)).toEqual(['Box', 'Select'])

  await ui.select({ key: 'sound', value: '719220__metrolynn__plunk.m4a' })
  expect(played).toEqual([{ asset: 'sounds/719220__metrolynn__plunk.m4a' }])
  expect(files.get('store:sound')).toBe(JSON.stringify('719220__metrolynn__plunk.m4a'))
  expect((await ui.find({ type: 'Select', key: 'sound' }))?.props.value).toBe('719220__metrolynn__plunk.m4a')

  await ui.select({ key: 'sound', value: 'off' })
  expect(played).toHaveLength(1)
  expect((await ui.find({ type: 'Select', key: 'sound' }))?.props.value).toBe('off')
  await ui.unmount()
})

const RECORD = '/Users/me/Library/Application Support/Claude/claude-code-sessions/account/org/local_1.json'
const ASKED = JSON.stringify({ turnWrapUp: { description: 'Done.', needsUser: 'Ship it?' } })

// The engine beneath, with the sound stored, and each clip played kept in `played`.
const soundEngine = (on: On, files: Map<string, string>, env: Record<string, string>): unknown[] => {
  engine(on, env, files)
  const played: unknown[] = []
  on('audio.play', (_$, e) => {
    played.push(e.clip)
    return { value: undefined }
  })
  on('classic.PermissionRequest', () => ({}))
  on('tool.call', () => ({ result: {} }))
  return played
}

test('in an app session the picked sound plays as it newly takes permission, input or needs you, and not on a plain answer', async ($, on) => {
  const files = new Map([['store:sound', JSON.stringify('545373__stwime__up3.mp3')]])
  const played = soundEngine(on, files, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' })
  const UP = { asset: 'sounds/545373__stwime__up3.mp3' }
  const answer = (turnId: string) =>
    $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId, reason: 'answer' })

  // As the app starts its sessions: no surface, not interactive.
  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  expect(played).toEqual([])

  // An answer that asks nothing plays nothing.
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await answer('t1')
  expect(played).toEqual([])

  // With the record saying the turn asked, an interrupt and a subagent's answer still play nothing.
  files.set(RECORD, ASKED)
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await $.turn.complete({ answer: 'x', durationMs: 5, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'a1' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't2', reason: 'aborted' })
  expect(played).toEqual([])
  files.delete(RECORD)

  // A permission dialog plays once; a second while the first is up plays nothing.
  await $.turn.start({ text: 'hi', turnId: 't3' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  expect(played).toEqual([UP])

  // A question plays.
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'q1', questions: [] } as never)
  expect(played).toEqual([UP, UP])

  // An answer that the app's record says asked the person something plays.
  files.set(RECORD, ASKED)
  await answer('t3')
  expect(played).toEqual([UP, UP, UP])
})

test('a session with no person at the prompt plays the sound too', async ($, on) => {
  const files = new Map([['store:sound', JSON.stringify('545373__stwime__up3.mp3')]])
  const played = soundEngine(on, files, { HOME: '/Users/me' })

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  expect(played).toEqual([{ asset: 'sounds/545373__stwime__up3.mp3' }])
})

test('with the sound off, nothing plays', async ($, on) => {
  const files = new Map([
    ['store:sound', JSON.stringify('off')],
    [RECORD, ASKED],
  ])
  const played = soundEngine(on, files, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' })

  // As the app starts its sessions: no surface, not interactive.
  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'q1', questions: [] } as never)
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(played).toEqual([])
})

test('a dialog back in view after a question plays nothing again; a new one after work does', async ($, on) => {
  const files = new Map([['store:sound', JSON.stringify('545373__stwime__up3.mp3')]])
  const played = soundEngine(on, files, { HOME: '/Users/me' })

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, agent_id: 'a1' })
  expect(played).toHaveLength(1)
  // The question plays; its end shows the subagent's dialog, still up, again.
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'q1', questions: [] } as never)
  expect(played).toHaveLength(2)
  // The subagent's turn ends its dialog: working again, so the next dialog is news.
  await $.turn.complete({ answer: 'x', durationMs: 5, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'a1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  expect(played).toHaveLength(3)
})

test("an answer's late question plays while the session waits, and not once a new turn has started", async ($, on) => {
  const files = new Map([['store:sound', JSON.stringify('545373__stwime__up3.mp3')]])
  const played = soundEngine(on, files, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' })
  const clock = mock.clock(on)
  const answer = (turnId: string) =>
    $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId, reason: 'answer' })

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })

  // The record says the turn asked only after the turn ended: the watch plays it.
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await answer('t1')
  expect(played).toEqual([])
  files.set(RECORD, ASKED)
  await clock.advance(1000)
  expect(played).toHaveLength(1)

  // A new turn, interrupted, while the last answer's watch sleeps: the watch ends.
  files.delete(RECORD)
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await answer('t2')
  await $.turn.start({ text: 'hi', turnId: 't3' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't3', reason: 'aborted' })
  files.set(RECORD, ASKED)
  await clock.advance(10_000)
  expect(played).toHaveLength(1)
})

test("Dismiss on a session that needs the person shows it idle in both views, until it gets a message or runs", async ($, on) => {
  const now = Date.now()
  const folder = '/Users/me/.claude/agent-state'
  const records = '/Users/me/Library/Application Support/Claude/claude-code-sessions/account/org'
  const filed = (title: string, ranAt: number): string =>
    JSON.stringify({ state: '💤 idle', note: '', since: now - 60_000, title, cwd: '/x', updated: now - 60_000, prompted: now - 60_000, ranAt })
  const files = new Map([
    [`${folder}/local_a.json`, filed('a', now - 60_000)],
    [`${records}/local_a.json`, JSON.stringify({ turnWrapUp: { description: 'Done.', needsUser: 'Ship it?' } })],
    [`${folder}/local_b.json`, filed('b', now - 60_000)],
    [`${records}/local_b.json`, JSON.stringify({ turnWrapUp: { description: 'Done.', needsUser: 'Merge?' } })],
  ])
  engine(on, { HOME: '/Users/me' }, files)
  const needsYou = async (ui: { findAll: (query: object) => Promise<{ text: string }[]> }) =>
    (await ui.findAll({ type: 'Text', text: '🙋 needs you' })).length

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })

  // By project: Dismiss is the row's one button.
  const projects = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await projects.findAll({ type: 'Button', text: 'Dismiss' })).map(one => one.key)).toEqual(['dismiss:local_a', 'dismiss:local_b'])
  await projects.press({ key: 'dismiss:local_a' })
  expect(await needsYou(projects)).toBe(1)
  expect((await projects.findAll({ type: 'Button', text: 'Dismiss' })).map(one => one.key)).toEqual(['dismiss:local_b'])
  await projects.unmount()

  // By time, for every pane: Dismiss sits before Pin, never beside → Today; the
  // dismissed session is idle with → Today.
  files.set('store:isByTime', 'true')
  const byTime = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const keys = (await byTime.findAll({ type: 'Button', text: /^(→ Today|Dismiss|Pin)$/ })).map(one => one.key)
  expect(keys.indexOf('pin:local_b') - keys.indexOf('dismiss:local_b')).toBe(1)
  expect(keys.indexOf('pin:local_a') - keys.indexOf('today:local_a')).toBe(1)
  expect(keys).not.toContain('today:local_b')
  expect(keys).not.toContain('dismiss:local_a')
  await byTime.press({ key: 'dismiss:local_b' })
  expect(await needsYou(byTime)).toBe(0)
  await byTime.unmount()

  // The button under the prompt counts them as idle.
  const button = await $.ui.mount({ plugin: 'agent-state', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  expect((await button.find({ type: 'Button' }))?.text).toBe('Sessions · 💤2')
  await button.unmount()

  // Session a runs again and asks again: it needs the person once more.
  files.set(`${folder}/local_a.json`, filed('a', Date.now() + 60_000))
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await again.findAll({ type: 'Button', text: 'Dismiss' })).map(one => one.key)).toEqual(['dismiss:local_a'])
  await again.unmount()

  // Session b gets a message: it needs the person once more too.
  files.set(
    `${folder}/local_b.json`,
    JSON.stringify({ ...JSON.parse(filed('b', now - 60_000)), prompted: Date.now() + 60_000 }),
  )
  const messaged = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await messaged.findAll({ type: 'Button', text: 'Dismiss' })).map(one => one.key).sort()).toEqual([
    'dismiss:local_a',
    'dismiss:local_b',
  ])
  await messaged.unmount()
})

// Sessions that each need the person, by the app's records, filed a minute ago.
const askingSessions = (ids: string[], now: number): Map<string, string> => {
  const folder = '/Users/me/.claude/agent-state'
  const records = '/Users/me/Library/Application Support/Claude/claude-code-sessions/account/org'
  const files = new Map<string, string>()
  for (const id of ids) {
    const at = now - 60_000
    files.set(`${folder}/${id}.json`, JSON.stringify({ state: '💤 idle', note: '', since: at, cwd: '/x', updated: at, prompted: at, ranAt: at }))
    files.set(`${records}/${id}.json`, JSON.stringify({ turnWrapUp: { description: 'Done.', needsUser: 'Ship it?' } }))
  }
  return files
}

test('a Dismiss press forgets the dismissals that no longer hold', async ($, on) => {
  const now = Date.now()
  const files = askingSessions(['local_a', 'local_c'], now)
  engine(on, { HOME: '/Users/me' }, files)

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'dismiss:local_a' })
  // Session a runs again: its dismissal no longer holds, and the next press drops it.
  const a = JSON.parse(files.get('/Users/me/.claude/agent-state/local_a.json') ?? '{}') as object
  files.set('/Users/me/.claude/agent-state/local_a.json', JSON.stringify({ ...a, ranAt: Date.now() + 60_000 }))
  await ui.press({ key: 'dismiss:local_c' })
  expect(Object.keys(JSON.parse(files.get('store:dismissedNeedsYou') ?? '{}') as object)).toEqual(['local_c'])
  await ui.unmount()
})

test("a dismissal holds though the app's clock runs ahead of this one", async ($, on) => {
  const now = Date.now()
  const files = askingSessions(['local_a'], now)
  engine(on, { HOME: '/Users/me' }, files)
  // The app dates its last activity a minute after this clock's now.
  const listed = [LISTED('local_a', '/x', now + 60_000)]
  on('mcp.call', (_$, e) => ({
    value: {
      isError: false,
      content: [{ type: 'text' as const, text: JSON.stringify(e.tool === 'list_sessions' ? listed : {}) }],
    },
  }))

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'dismiss:local_a' })
  await ui.unmount()

  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await again.findAll({ type: 'Text', text: '🙋 needs you' })).length).toBe(0)
  await again.unmount()
})

test('a Dismiss press from a pane drawn before the session got a message dismisses nothing', async ($, on) => {
  const now = Date.now()
  const files = askingSessions(['local_a'], now)
  engine(on, { HOME: '/Users/me' }, files)

  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The person messages the session after the draw: the app clears its question.
  const record = '/Users/me/Library/Application Support/Claude/claude-code-sessions/account/org/local_a.json'
  files.set(record, JSON.stringify({}))
  files.set(`mtime:${record}`, '2')
  await ui.press({ key: 'dismiss:local_a' })
  expect(files.get('store:dismissedNeedsYou')).toBeUndefined()
  await ui.unmount()
})
