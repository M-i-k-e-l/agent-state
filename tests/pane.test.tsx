import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

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

// Stands for the engine beneath the mod: a file system held in a map, the
// environment given, and no tab to write to. Each process run is kept in `ran`.
const engine = (
  on: On,
  env: Record<string, string>,
  files: Map<string, string>,
  ran: (readonly string[])[] = [],
): void => {
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
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  // The store sits in the map too. Most of these tests draw the projects; one that
  // wants the other view says so.
  on('store.get', (_$, e) => ({ value: JSON.parse(files.get(`store:${e.key}`) ?? 'false') as unknown }))
  on('store.set', (_$, e) => {
    files.set(`store:${e.key}`, JSON.stringify(e.value))
    return { value: undefined }
  })
  on('fs.list', (_$, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
}

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

  const ui = await $.ui.mount({ plugin: 'agent-state', surface: 'desktop', component: 'SessionMode', props: { modes: ['auto mode on'] } })
  expect((await ui.find({ type: 'Text', text: /auto/ }))?.text).toBe('auto mode on · ')
  await ui.press({ key: 'sessions' })
  await ui.press({ key: 'sessions' })
  await ui.press({ key: 'sessions' })
  expect(done).toEqual(['open agent-state', 'close agent-state', 'open agent-state'])
  await ui.unmount()
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
  // A session the app is not showing does not try.
  files.set(path, 'true')
  surfaces = []
  await follow()
  expect(done).toEqual([])
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

test('a message is filed with the session, and a restarted process keeps it', async ($, on) => {
  const path = '/Users/me/.claude/agent-state/local_1.json'
  const files = new Map([[path, JSON.stringify({ state: '💤 idle', note: '', since: 1, cwd: '/x', updated: 1, prompted: 1234 })]])
  engine(on, { HOME: '/Users/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' }, files)
  on('classic.UserPromptSubmit', () => ({}))
  const promptedIn = (): unknown => (JSON.parse(files.get(path) ?? '{}') as { prompted?: unknown }).prompted

  // The first write after a restart keeps what the file held.
  await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
  expect(promptedIn()).toBe(1234)

  const before = Date.now()
  await $.classic.UserPromptSubmit({ prompt: 'hi' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(stateIn(files, path)).toBe('⚙️ working')
  expect(promptedIn()).toBeGreaterThanOrEqual(before)

  // The end of the session keeps it too.
  const sent = promptedIn()
  await $.session.end({ reason: 'other', sessionId: 'own-id', resume: { id: 'own-id' } })
  expect(stateIn(files, path)).toBe('')
  expect(promptedIn()).toBe(sent)
})
