import type { EngineInterface, McpToolResult, Register } from 'claude-code'

// Shows Claude's state in the iTerm2 tab through the user variable the profile's
// Subtitle reads: \(user.claudeState). Only an event that changes what the tab
// shows starts a process.
// Each session also writes its state to a file of its own, and a pane in the
// desktop app lists every session's file.

const VAR = 'claudeState'

const WORKING = '⚙️ working'
const PERMISSION = '🔐 permission'
const INPUT = '❓ input'
const IDLE = '💤 idle'
const BACKGROUND = '🧵 background'
const COMPACTING = '📦 compacting'
const CLEARED = ''

// $1 variable, $2 the state, $3 "1" to stamp the state with the date and time,
// $4 the tty a write before this one found, or empty, $5 log line, $6 "1" when no
// person is at the prompt (a -p run or the SDK), $7 text to put after the stamp, or empty.
// The child has no controlling terminal of its own, so without $4 the tty is found
// by walking up the process tree to the first ancestor that has one (claude, then
// its shell). Prints the tty it used, for the next write to pass back. Exits 0 when
// the state reached the tab, 2 when this session has no tab to write to and never
// will, so the module stops asking, and 1 for any other failure.
// Logs the write when the environment variable AGENT_STATE_LOG names a file.
// A session with no person at the prompt writes only when AGENT_STATE_HEADLESS is
// set: started from inside another session's tool, it would write over that
// session's tab.
// A session moved to the background (/background) goes on in a process whose environment
// names no terminal at all, only the iTerm2 profile it was started under (observed).
// A write that lands inside Claude Code's own title write is taken as title text and
// lost (observed), so a write that went out is sent again half a second later, unless
// a newer one has gone out to that tty since: the mark file names the latest.
const EMIT = `
case "$TERM_PROGRAM$LC_TERMINAL" in *iTerm*) iterm=1 ;; *) iterm=0 ;; esac
if [ -z "$TERM_PROGRAM$LC_TERMINAL" ] && [ -n "$ITERM_PROFILE" ]; then iterm=1; fi
off=
if [ "$iterm" = 0 ]; then off='not iTerm2'; fi
if [ "$6" = 1 ] && [ -z "$AGENT_STATE_HEADLESS" ]; then off='no person at the prompt'; fi
tty=none
case "$4" in /dev/*) if [ -w "$4" ]; then tty="$4"; fi ;; esac
if [ -z "$off" ] && [ "$tty" = none ]; then
  p=$PPID
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    t=$(ps -o tty= -p "$p" 2>/dev/null | tr -d ' ')
    case "$t" in ttys*) if [ -w "/dev/$t" ]; then tty="/dev/$t"; break; fi ;; esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
fi
state="$2"
if [ "$3" = 1 ]; then state="$state $(LC_ALL=C date '+%b %-d %H:%M')"; fi
if [ -n "$7" ]; then state="$state $7"; fi
rc=-
if [ -n "$off" ]; then rc="off, $off"; fi
if [ -z "$off" ] && [ "$tty" != none ]; then
  esc=$(printf '\\033]1337;SetUserVar=%s=%s\\007' "$1" "$(printf '%s' "$state" | base64 | tr -d '\\n')")
  printf '%s' "$esc" > "$tty" 2>/dev/null
  rc=$?
fi
if [ "$rc" = 0 ]; then
  mark="\${TMPDIR:-/tmp}/agent-state.$(basename "$tty")"
  printf '%s' "$$" > "$mark"
  (
    sleep 0.5
    if [ "$(cat "$mark" 2>/dev/null)" != "$$" ]; then exit 0; fi
    printf '%s' "$esc" > "$tty" 2>/dev/null
    again=$?
    if [ -n "$AGENT_STATE_LOG" ]; then
      printf '%s %s again rc=%s\\n' "$(date '+%H:%M:%S')" "\${5%% *}" "$again" >> "$AGENT_STATE_LOG"
    fi
  ) </dev/null >/dev/null 2>&1 &
fi
if [ -n "$AGENT_STATE_LOG" ]; then
  printf '%s %s tty=%s wrote=[%s] rc=%s\\n' "$(date '+%H:%M:%S')" "$5" "$tty" "$state" "$rc" >> "$AGENT_STATE_LOG"
fi
printf '%s' "$tty"
if [ -n "$off" ]; then exit 2; fi
[ "$rc" = 0 ]
`

const loaded = Date.now()
let seq = 0
// One write at a time, in the order the events came: two states written at once
// could land on the tab in the wrong order.
let queue: Promise<unknown> = Promise.resolve()
// The tab's tty, as the script last reported it. It does not change while the
// process lives; a reload starts it over, and the next write searches again.
let tty: string | undefined
// The state the tab shows, as last written with success; undefined after a reload,
// so the first write after one always goes out.
let shown: string | undefined
// Set once the script says this session has no tab to write to: no write is tried
// again until a reload.
let isOff = false
// Whether no person is at the prompt, as session.start said; a reload raises
// session.start again.
let isHeadless = false
// Whether the main agent's turn is running: what a finished tool or compaction
// goes back to. A tool's end that arrives after an interrupt must not write working.
let isTurnLive = false
// The main agent's running turn, by id; undefined between turns and after a reload.
let liveTurn: string | undefined
// The background commands in flight, as the main agent's last Stop listed them: one
// of them may be a server that runs as long as the session, so they add to idle and
// do not make it background. A turn's start clears the count, since an interrupted
// turn may raise no Stop to list them again.
let jobs = 0
// Every entry of that Stop's list as type:status, subagents too, for the log line.
let listed = ''

// What idle adds for the background commands in flight: an hourglass and their count.
const jobsNote = (): string => (jobs === 0 ? '' : `⏳${jobs}`)

// The folder under the home folder that holds one file per session of the desktop
// app, named by the app's id for it (local_…).
const FOLDER = '.claude/agent-state'

// What a session's file holds. `since` is when the state began; `state` is empty
// once the session ended; `prompted` is when the person last sent it a message.
type Filed = { state: string; note: string; since: number; title?: string; cwd: string; updated: number; prompted?: number }

// This session's file, set at session.start; undefined when it writes none: any
// session the desktop app does not host, such as one in an iTerm2 tab, whose
// state its tab shows.
let file: string | undefined
let cwd = ''
// The session's title, as the classic hooks last reported it.
let title: string | undefined
// What the file holds, as last written; undefined after a reload.
let filed: Filed | undefined
// The state last asked of the file, which a write still queued may not have reached.
let asked: { state: string; note: string } | undefined
// When the person last sent this session a message; a restart reads it back from
// the file before the first write.
let prompted: number | undefined
let fileQueue: Promise<unknown> = Promise.resolve()
// When a resumed session last answered, as its SessionStart said, until its first
// turn: the app restarts a session's process often (reopened, returned to), and
// its idle began at that answer, not at the restart. A reload of this module,
// which says nothing of the kind, still starts idle over.
let lastAnswer: number | undefined

// The file AGENT_STATE_LOG names, read at session.start: each write to the
// session's file appends a line to it, as each write to the tab does.
let logFile: string | undefined

// Appends a line to that log, with the time and how long this module has run.
const logLine = async ($: EngineInterface, text: string): Promise<void> => {
  if (logFile === undefined) return
  const time = new Date().toTimeString().slice(0, 8)
  const logged = `${time} +${Date.now() - loaded}ms ${text}`
  await $.process.run(['sh', '-c', 'printf "%s\\n" "$1" >> "$2"', 'sh', logged, logFile], { timeoutMs: 5000 }).catch(() => undefined)
}

// Writes the state to the session's file, unless it already holds it. A repeated
// idle keeps its first `since`. `line` names the event, for the log.
const toFile = ($: EngineInterface, line: string, state: string, note: string, isForced = false): Promise<unknown> => {
  asked = { state, note }
  fileQueue = fileQueue.then(async () => {
    if (file === undefined) return
    if (!isForced && filed?.state === state && filed.note === note) return
    const now = Date.now()
    const kept = filed?.state === state ? filed.since : now
    const since = state === IDLE && lastAnswer !== undefined ? Math.min(kept, lastAnswer) : kept
    const next: Filed = { state, note, since, title, cwd, updated: now, prompted }
    const isWritten = await $.fs.write(file, JSON.stringify(next)).then(
      () => true,
      () => false,
    )
    filed = isWritten ? next : undefined
    await logLine($, `file ${line} wrote=[${state}${note}] ok=${isWritten}`)
  })
  return fileQueue
}

// Writes the state to the tab and to the session's file; an event with no state
// leaves both alone, and so does one whose state the tab already shows. A repeated
// idle keeps its first stamp.
const emit = ($: EngineInterface, line: string, state: string | undefined): Promise<unknown> => {
  if (state === undefined) return Promise.resolve()
  const note = state === IDLE ? jobsNote() : ''
  const filing = toFile($, line, state, note)
  if (isOff) return filing
  const at = Date.now() - loaded
  const shows = `${state}${note}`
  queue = queue.then(async () => {
    if (shows === shown || isOff) return
    seq += 1
    const stamped = `#${seq} +${at}ms ${line}`
    const stamp = state === IDLE ? '1' : '0'
    const argv = ['sh', '-c', EMIT, 'sh', VAR, state, stamp, tty ?? '', stamped, isHeadless ? '1' : '0', note]
    const ran = await $.process.run(argv, { timeoutMs: 5000 }).catch(() => undefined)
    // A failed search prints "none": caching that would stop every later write.
    const found = ran?.stdout.trim()
    if (found?.startsWith('/dev/')) tty = found
    // A write that failed leaves the tab unknown, so the next one goes out whatever it is.
    shown = ran?.exitCode === 0 ? shows : undefined
    if (ran?.exitCode === 2) isOff = true
  })
  return Promise.all([filing, queue])
}

// The tool calls in flight, each with the agent that made it: a decision names
// its call, not its agent.
const calls = new Map<string, string | undefined>()

// The subagents with a permission dialog put to the person. A dialog of theirs
// outranks working, background and idle: it is the person the session waits on.
const waiting = new Set<string>()

const who = (agentId: string | undefined): string => agentId ?? 'main'

// What a running main agent shows.
const active = (): string => (waiting.size > 0 ? PERMISSION : WORKING)

// The agent statuses that keep the tab on background. A subagent whose turn ended
// with background work of its own still running is waiting, and reports when that
// work ends (observed).
const LIVE = new Set<unknown>(['running', 'pending', 'waiting'])

// What the main agent rests in: background while a subagent of it still runs.
const resting = async ($: EngineInterface): Promise<string> => {
  if (waiting.size > 0) return PERMISSION
  const agents = await $.agent.list().catch(() => [])
  const live = agents.filter(a => LIVE.has(a.status))
  return live.length > 0 ? BACKGROUND : IDLE
}

// The sources of a decision that a person gave at the dialog, for this call alone
// or with a rule kept for later ones (the first observed, the second from the engine's
// monitoring docs). A rule, a mode or a hook deciding is not the person answering.
const BY_PERSON = new Set<unknown>(['user_temporary', 'user_permanent'])

// A subagent's dialog is over when the person approves it, its tool returns or its
// turn ends: what the tab goes back to, or undefined when that subagent had no dialog up.
const settled = async ($: EngineInterface, agentId: string): Promise<string | undefined> => {
  if (!waiting.delete(agentId)) return undefined
  return isTurnLive ? active() : resting($)
}

// The folder of session files, set at session.start once the home folder is known.
let folder: string | undefined
// The app's id for this session, which names its file; undefined outside the app.
let own: string | undefined

const PANE = 'agent-state'

// The pane lists what waits on the person first.
const RANK = [PERMISSION, INPUT, COMPACTING, WORKING, BACKGROUND, IDLE]

// Whether the timer that redraws the pane and the button and follows the shared
// open or closed choice runs; it starts once the app attaches, or the pane is placed.
let isTicking = false

const tick = ($: EngineInterface): void => {
  if (isTicking) return
  isTicking = true
  $.clock.every(1000, () => {
    $.ui.invalidate('ui.render')
    void followPane($)
  })
}

// A session as the app's own session tools list it.
type Listed = { title: string; link?: string; cwd: string; lastActivity: number }

// The app's sessions that are not archived, by its id for each, fetched through
// its own session tools at most every ten seconds; undefined until the list is
// fetched, and where those tools are missing.
let appSessions: Map<string, Listed> | undefined
let appSessionsAt = 0
// Whether a fetch of the list is running. The engine raises tool.call for it on
// the main loop (observed), and a main tool's end writes working: it must not
// take the state for a tool of the model's, over a question or a permission.
let isFetching = false
const APP_TOOLS = 'mcp__ccd_session_mgmt__'

const parsed = (result: McpToolResult): unknown => {
  const block = result.content[0]
  return !result.isError && typeof block?.text === 'string' ? (JSON.parse(block.text) as unknown) : undefined
}

const fetchAppSessions = async ($: EngineInterface): Promise<void> => {
  if (Date.now() - appSessionsAt < 10_000) return
  appSessionsAt = Date.now()
  isFetching = true
  // The list leaves out archived sessions and this one, which get_session adds.
  const others = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 200 }).then(parsed, () => undefined)
  const self = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' }).then(parsed, () => undefined)
  isFetching = false
  if (!Array.isArray(others)) return
  const fetched = new Map<string, Listed>()
  for (const one of [...others, self]) {
    if (typeof one !== 'object' || one === null) continue
    const { sessionId, title: named, link, cwd: at, lastActivityAt, isArchived } = one as Record<string, unknown>
    if (typeof sessionId !== 'string' || typeof named !== 'string' || isArchived === true) continue
    fetched.set(sessionId, {
      title: named,
      link: typeof link === 'string' ? link : undefined,
      cwd: typeof at === 'string' ? at : '',
      lastActivity: typeof lastActivityAt === 'string' ? Date.parse(lastActivityAt) : 0,
    })
  }
  appSessions = fetched
  const path = savedSessionsFile()
  if (path !== undefined) await $.fs.write(path, JSON.stringify([...fetched])).catch(() => undefined)
}

// The list as a session last fetched it, in a file every session reads. A session
// the app has just restarted draws its pane from it at once, as a fetch takes a
// moment, and archived sessions stay out of that first draw.
const savedSessionsFile = (): string | undefined => (folder === undefined ? undefined : `${folder}.sessions.json`)

const loadSavedSessions = async ($: EngineInterface): Promise<void> => {
  const path = savedSessionsFile()
  const text = path === undefined ? undefined : await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') return
  try {
    const saved: unknown = JSON.parse(text)
    if (Array.isArray(saved)) appSessions = new Map(saved as [string, Listed][])
  } catch {
    // A file caught mid-write: the fetch stands in for it.
  }
}

// The link that shows a session in the app: as the app's session tools gave it, or
// in the shape they give it.
const linkOf = (id: string): string => appSessions?.get(id)?.link ?? `claude://claude.ai/epitaxy/${id}`

type Row = { id: string; filed: Filed }

// Every session file, read as it stands now.
const listFiled = async ($: EngineInterface, from: string): Promise<Row[]> => {
  const entries = await $.fs.list(from).catch(() => [])
  const rows: Row[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const text = await $.fs.read(`${from}/${entry.name}`).catch(() => undefined)
    if (typeof text !== 'string') continue
    try {
      const filed = JSON.parse(text) as Filed
      if (typeof filed.state === 'string') rows.push({ id: entry.name.slice(0, -5), filed })
    } catch {
      // A file caught mid-write reads whole on the next redraw.
    }
  }
  return rows
}

// The sessions to show. Once the app's list is known, saved or fetched: each
// session it lists, from its file while its process runs, else idle since its
// last activity, as the app stops the process of a session left alone; an
// archived session is left out. Before that, or without the app's tools: every
// live file.
const sessionRows = async ($: EngineInterface): Promise<Row[]> => {
  if (appSessions === undefined) await loadSavedSessions($)
  if (appSessions === undefined) await fetchAppSessions($)
  else void fetchAppSessions($)
  const files = folder === undefined ? [] : await listFiled($, folder)
  if (appSessions === undefined) return files.filter(row => row.filed.state !== CLEARED)
  const byId = new Map(files.map(row => [row.id, row]))
  return [...appSessions].map(([id, app]) => {
    const row = byId.get(id)
    if (row !== undefined && row.filed.state !== CLEARED) return row
    const filed = { state: IDLE, note: '', since: app.lastActivity, cwd: app.cwd, updated: 0, prompted: row?.filed.prompted }
    return { id, filed }
  })
}

const rank = (state: string): number => {
  const at = RANK.indexOf(state)
  return at === -1 ? RANK.length : at
}

// How long a state has lasted, in words read at a glance (`now`, `5 min`,
// `2 hours`), and past a day when it began.
const lasted = (since: number, now: number): string => {
  const minutes = Math.floor((now - since) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`
  return stamp(since)
}

// The state's color in the subtitle: a session waiting on the person, one that has
// not come to rest, and a recent idle one. Any other idle stays dim.
const colorOf = (state: string, isRecent: boolean): string | undefined => {
  if (state === PERMISSION || state === INPUT) return 'error'
  if (state !== IDLE) return 'success'
  return isRecent ? 'warning' : undefined
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// When a state began, as the tab's idle stamp reads: `Oct 10 12:40`.
const stamp = (at: number): string => {
  const day = new Date(at)
  const minutes = String(day.getMinutes()).padStart(2, '0')
  return `${MONTHS[day.getMonth()]} ${day.getDate()} ${day.getHours()}:${minutes}`
}

// The heading a session is listed under, as the app's sidebar groups by project:
// the folder it started in, a worktree under the folder it was made from, and a
// scratch session under This computer.
const THIS_COMPUTER = 'This computer'
const projectOf = (row: Row): string => {
  const { cwd } = row.filed
  if (cwd.includes('/scratch-workspaces/')) return THIS_COMPUTER
  const root = cwd.split('/.claude/worktrees/')[0] ?? cwd
  return root.split('/').pop() || cwd
}

// The headings in the order the sidebar showed them grouped by project (observed,
// as the app tells no one its order): names from Z to A, This computer last.
const byHeading = (a: string, b: string): number =>
  Number(a === THIS_COMPUTER) - Number(b === THIS_COMPUTER) || b.localeCompare(a)

// The order the person set with the headings' arrows, kept in one file every
// session's pane reads: the headings it names first, in its order, then the rest.
const orderFile = (): string | undefined => (folder === undefined ? undefined : `${folder}.order.json`)

const readOrder = async ($: EngineInterface): Promise<string[]> => {
  const path = orderFile()
  const text = path === undefined ? undefined : await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') return []
  try {
    const order: unknown = JSON.parse(text)
    return Array.isArray(order) ? order.filter((one): one is string => typeof one === 'string') : []
  } catch {
    return []
  }
}

const ordered = (headings: string[], order: string[]): string[] => {
  const at = (heading: string): number => {
    const index = order.indexOf(heading)
    return index === -1 ? order.length : index
  }
  return [...headings].sort((a, b) => at(a) - at(b) || byHeading(a, b))
}

// Moves a heading one place up or down among those shown, keeping the place of
// headings the file names that no session shows now.
const move = async ($: EngineInterface, shown: string[], heading: string, by: -1 | 1): Promise<void> => {
  const path = orderFile()
  const from = shown.indexOf(heading)
  const to = from + by
  if (path === undefined || from === -1 || to < 0 || to >= shown.length) return
  const next = [...shown]
  next[from] = next[to] ?? heading
  next[to] = heading
  const order = await readOrder($)
  await $.fs.write(path, JSON.stringify([...next, ...order.filter(one => !next.includes(one))])).catch(() => undefined)
  $.ui.invalidate('ui.render')
}

// Whether the pane lists the sessions by time instead of under their projects is
// one choice for every session's pane, kept in the plugin's store: `false` by
// project, anything else by time.
const BY_TIME = 'isByTime'

const readByTime = async ($: EngineInterface): Promise<boolean> =>
  (await $.store.get(BY_TIME).catch(() => undefined)) !== false

const chooseByTime = async ($: EngineInterface, isByTime: boolean): Promise<void> => {
  await $.store.set(BY_TIME, isByTime).catch(() => undefined)
  $.ui.invalidate('ui.render')
}

// When the app last saw the session active. The file's `updated` stands in only
// without the app's list: a process the app restarts writes it (observed).
const activeAt = (row: Row): number => appSessions?.get(row.id)?.lastActivity ?? row.filed.updated

// When the person last used the session: their last message, or its last activity
// for a session that has not recorded one yet.
const usedAt = (row: Row): number => row.filed.prompted ?? activeAt(row)

const RECENT_WINDOW = 2 * 60 * 60 * 1000

// What counts as Recent among these rows: from the latest message back two hours,
// and also what ran in that time or has not come to rest, whenever its own last
// message was.
const recentAmong = (rows: Row[]): ((row: Row) => boolean) => {
  const from = Math.max(...rows.map(usedAt)) - RECENT_WINDOW
  return row => row.filed.state !== IDLE || activeAt(row) >= from || usedAt(row) >= from
}

// The boxes of the time view, each newest message first. A box with no session is
// left out.
const byTime = (rows: Row[], now: number): [string, Row[]][] => {
  const isRecent = recentAmong(rows)
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const sorted = [...rows].sort((a, b) => usedAt(b) - usedAt(a))
  const recent = sorted.filter(isRecent)
  const rest = sorted.filter(row => !isRecent(row))
  const boxes: [string, Row[]][] = [
    ['Recent', recent],
    ['Today', rest.filter(row => usedAt(row) >= midnight)],
    ['Older', rest.filter(row => usedAt(row) < midnight)],
  ]
  return boxes.filter(([, inBox]) => inBox.length > 0)
}

// The app's title for the session; the one Claude Code reported can be another
// session's, such as the one it was started from (observed).
const nameOf = (row: Row): string =>
  appSessions?.get(row.id)?.title ?? row.filed.title ?? (row.filed.cwd.split('/').pop() || row.id)

// Opens the pane and, once a surface places it, the timer that redraws it.
const openPane = async ($: EngineInterface): Promise<boolean> => {
  const opened = await $.ui.open({ id: PANE, title: 'Sessions' }).catch(() => undefined)
  if (opened?.isPlaced !== true) return false
  tick($)
  return true
}

// Whether the pane is open is one choice for every session of the app, kept in a
// file they all follow: `true` open, anything else closed.
const paneFile = (): string | undefined => (folder === undefined ? undefined : `${folder}.pane.json`)

const choosePane = async ($: EngineInterface, isOpen: boolean): Promise<void> => {
  const path = paneFile()
  if (path !== undefined) await $.fs.write(path, String(isOpen)).catch(() => undefined)
}

// Whether a follow is running: the timer fires whether or not the last one ended.
let isFollowing = false

// Opens or closes this session's pane to match the choice. The choice is read
// last, so a press that changed it while the panes were read is not undone. A
// session the app is not showing has no surface to open it on (observed), and
// follows when the app attaches to it again.
const followPane = async ($: EngineInterface): Promise<void> => {
  const path = paneFile()
  if (path === undefined || isFollowing) return
  const surfaces = await $.session.surfaces().catch(() => [])
  if (surfaces.length === 0) return
  isFollowing = true
  const panes = await $.ui.panes().catch(() => [])
  const isOpen = (await $.fs.read(path).catch(() => undefined)) === 'true'
  if (isOpen && !panes.some(pane => pane.id === PANE && pane.isPlaced)) await openPane($)
  if (!isOpen && panes.some(pane => pane.id === PANE)) await $.ui.close({ id: PANE }).catch(() => undefined)
  isFollowing = false
}

// Closes the pane while the surface shows it, and opens or shows it otherwise,
// for every session.
const togglePane = async ($: EngineInterface): Promise<unknown> => {
  const panes = await $.ui.panes().catch(() => [])
  const isShown = panes.some(pane => pane.id === PANE && pane.isShown)
  await choosePane($, !isShown)
  return isShown ? $.ui.close({ id: PANE }).catch(() => undefined) : openPane($)
}

// Keeps the session's title for its file, and writes the file again when it changed.
const retitle = async ($: EngineInterface, named: string | undefined): Promise<unknown> => {
  if (named === undefined || named === '' || named === title) return
  title = named
  if (asked !== undefined) await toFile($, 'retitle', asked.state, asked.note, true)
}

// Reads back when the person last messaged this session, as an earlier process
// filed it. A message sent meanwhile stands.
const loadPrompted = async ($: EngineInterface): Promise<void> => {
  const text = file === undefined ? undefined : await $.fs.read(file).catch(() => undefined)
  if (typeof text !== 'string') return
  try {
    const saved = (JSON.parse(text) as Filed).prompted
    if (prompted === undefined && typeof saved === 'number') prompted = saved
  } catch {
    // No file yet, or one caught mid-write: the next message sets it.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isHeadless = !e.isInteractive
    const home = await $.env.get('HOME').catch(() => undefined)
    const host = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID').catch(() => undefined)
    cwd = await $.session.cwd().catch(() => '')
    folder = home === undefined ? undefined : `${home}/${FOLDER}`
    logFile = await $.env.get('AGENT_STATE_LOG').catch(() => undefined)
    own = host
    file = folder !== undefined && host !== undefined ? `${folder}/${host}.json` : undefined
    filed = undefined
    await loadPrompted($)
    await emit($, `session.start surface=${e.surface} interactive=${e.isInteractive}`, IDLE)
    return started
  })

  // Raised before or after session.start's idle is written, so a file already
  // idle is written again from the last answer.
  on('classic.SessionStart', ($, e, next) => {
    void retitle($, e.session_title)
    const seconds = e.seconds_since_last_response
    if (seconds !== undefined) {
      lastAnswer = Date.now() - seconds * 1000
      if (filed?.state === IDLE) void toFile($, `resume seconds=${seconds}`, IDLE, filed.note, true)
    }
    return next(e)
  })

  on('classic.UserPromptSubmit', ($, e, next) => {
    prompted = Date.now()
    void retitle($, e.session_title)
    if (asked !== undefined) void toFile($, 'prompt', asked.state, asked.note, true)
    return next(e)
  })

  // The desktop app attaches after session.start, which names no surface there,
  // and again each time the person switches to the session. The button's count
  // redraws from then on, and the pane follows the choice shared by the sessions.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (e.surface === 'desktop') {
      tick($)
      await followPane($)
    }
    return attached
  })

  // The person closing the pane by its own mark closes it for every session.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await choosePane($, false)
    return next(e)
  })

  // In the app, a button beside the session's modes under the prompt opens and
  // closes the pane, and counts the sessions in each state, what waits on the
  // person first, so they show with the pane closed. The app draws it grey whatever color or background it
  // asks for, and draws nothing there for a Client region (observed). The
  // terminal keeps its own line.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const modes = e.props.modes.join(' & ')
    const rows = await sessionRows($)
    const counts = RANK.map(state => {
      const count = rows.filter(row => row.filed.state === state).length
      return count === 0 ? '' : `${state.split(' ')[0]}${count}`
    }).filter(count => count !== '')
    return (
      <Box>
        {modes !== '' && <Text>{modes} · </Text>}
        <Button key="sessions" plain onPress={() => void togglePane($)}>
          {counts.length === 0 ? 'Sessions' : `Sessions · ${counts.join(' ')}`}
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const rows = await sessionRows($)
    const isByTime = await readByTime($)
    rows.sort((a, b) => rank(a.filed.state) - rank(b.filed.state) || b.filed.since - a.filed.since)
    const now = Date.now()
    const groups = new Map<string, Row[]>()
    for (const row of rows) groups.set(projectOf(row), [...(groups.get(projectOf(row)) ?? []), row])
    const headings = ordered([...groups.keys()], await readOrder($))
    // Each session is its name as a title, a button, then its state and how long
    // it lasted as a subtitle under it, the state in its color, in either view. The
    // session the pane is in has a pointer before its name. Listed by time, no card
    // names its project, so a line between the two does. Inside a button the
    // app draws one line of plain text, whatever the Text in it asks for (observed).
    const isRecent = recentAmong(rows)
    const session = (row: Row) => {
      const { state, note, since } = row.filed
      const color = colorOf(state, isRecent(row))
      const rest = `${note === '' ? '' : ` ${note}`} · ${lasted(since, now)}`
      const link = linkOf(row.id)
      // The page draws an https link alone, so the session's link goes to
      // the system, which hands it back to the app.
      const show = (): void => void $.process.run(['open', link], { timeoutMs: 5000 }).catch(() => undefined)
      return (
        <Box flexDirection="column">
          <Button key={row.id} plain onPress={show}>
            {row.id === own ? `› ${nameOf(row)}` : nameOf(row)}
          </Button>
          {isByTime && (
            <Text dimColor size="footnote">
              {projectOf(row)}
            </Text>
          )}
          <Box>
            {color === undefined ? (
              <Text dimColor size="footnote">
                {state}
              </Text>
            ) : (
              <Text color={color} weight="medium" size="footnote">
                {state}
              </Text>
            )}
            <Text dimColor size="footnote">
              {rest}
            </Text>
          </Box>
        </Box>
      )
    }
    // Each project is a card with rounded corners, as the app's own panel draws them.
    // The two buttons above them pick the view. The elements hold no segmented
    // control, so a border around both is its track, the one in force a primary chip
    // and the other plain, with none. The app's own header above takes nothing from a mod.
    return (
      <Box flexDirection="column" gap={1}>
        {rows.length === 0 && <Text dimColor>No session has written its state yet.</Text>}
        {rows.length > 0 && (
          <Box alignSelf="flex-start" alignItems="center" borderStyle="round" borderColor="subtle" padding={0}>
            <Button
              key="view:time"
              label="Time"
              variant="primary"
              plain={isByTime ? undefined : true}
              onPress={() => void chooseByTime($, true)}
            />
            <Button
              key="view:projects"
              label="Projects"
              variant="primary"
              plain={isByTime ? true : undefined}
              onPress={() => void chooseByTime($, false)}
            />
          </Box>
        )}
        {isByTime && byTime(rows, now).map(([heading, inBox]) => (
          <Box flexDirection="column" gap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text dimColor weight="medium">
              {heading}
            </Text>
            {inBox.map(session)}
          </Box>
        ))}
        {!isByTime && headings.map((heading, index) => (
          <Box flexDirection="column" gap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
            <Box gap={1}>
              <Text dimColor weight="medium">
                {heading}
              </Text>
              {index > 0 && (
                <Button key={`up:${heading}`} label="↑" plain onPress={() => void move($, headings, heading, -1)} />
              )}
              {index < headings.length - 1 && (
                <Button key={`down:${heading}`} label="↓" plain onPress={() => void move($, headings, heading, 1)} />
              )}
            </Box>
            {(groups.get(heading) ?? []).map(session)}
          </Box>
        ))}
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    // A /clear ends the conversation, not the process, and no session.start follows.
    jobs = 0
    listed = ''
    await emit($, `session.end reason=${e.reason}`, e.reason === 'clear' ? IDLE : CLEARED)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's turn starts too, also when SendMessage wakes it while the main
    // turn runs (observed): taken for the main turn's, it made that turn's end look late.
    if (e.agentId !== undefined) return next(e)
    lastAnswer = undefined
    isTurnLive = true
    liveTurn = e.turnId
    jobs = 0
    listed = ''
    await emit($, `turn.start turn=${e.turnId}`, active())
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A prompt typed over a running turn starts the new turn before the old one's
    // end is reported (observed): that late end must not put a working tab to idle.
    const isCurrent = e.agentId === undefined && (liveTurn === undefined || liveTurn === e.turnId)
    if (isCurrent) {
      isTurnLive = false
      liveTurn = undefined
    }
    // A subagent killed with its dialog up ends its turn without its tool returning.
    const state = isCurrent ? await resting($) : e.agentId !== undefined ? await settled($, e.agentId) : undefined
    const tasks = isCurrent ? ` jobs=[${listed}]` : ''
    await emit($, `turn.complete agent=${who(e.agentId)} reason=${e.reason} turn=${e.turnId}${tasks}`, state)
    return next(e)
  })

  // The main agent's Stop, raised just before its turn.complete (observed), lists the
  // background work in flight. Only shells count: a subagent is counted from
  // $.agent.list(), and a session watching its published artifacts for comments keeps
  // a monitor running for each (observed).
  on('classic.Stop', async ($, e, next) => {
    const tasks = e.background_tasks ?? []
    jobs = tasks.filter(t => t.type === 'shell').length
    listed = tasks.map(t => `${t.type}:${t.status}`).join(',')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (isFetching && tool.startsWith(APP_TOOLS)) return next(e)
    const isMain = e.agentId === undefined
    calls.set(e.tool_use_id, e.agentId)
    await emit($, `tool.call> tool=${tool} agent=${who(e.agentId)}`, isMain && tool === 'AskUserQuestion' ? INPUT : undefined)
    try {
      const ran = await next(e)
      calls.delete(e.tool_use_id)
      const outcome = ran.deny !== undefined ? 'deny' : ran.isError === true ? 'error' : 'ok'
      const after = e.agentId === undefined ? (isTurnLive ? active() : undefined) : await settled($, e.agentId)
      await emit($, `tool.call< tool=${tool} agent=${who(e.agentId)} ${outcome}`, after)
      return ran
    } catch (error) {
      calls.delete(e.tool_use_id)
      const after = e.agentId === undefined ? undefined : await settled($, e.agentId)
      await emit($, `tool.call! tool=${tool} agent=${who(e.agentId)} threw`, after)
      throw error
    }
  })

  on('session.compact', async ($, e, next) => {
    const isMain = e.agentId === undefined && e.trigger !== 'precompute'
    await emit($, `session.compact> trigger=${e.trigger} agent=${who(e.agentId)}`, isMain ? COMPACTING : undefined)
    try {
      const compacted = await next(e)
      const after = isMain ? (isTurnLive ? WORKING : await resting($)) : undefined
      await emit($, `session.compact< trigger=${e.trigger} ${'skip' in compacted ? 'skipped' : 'done'}`, after)
      return compacted
    } catch (error) {
      await emit($, `session.compact! trigger=${e.trigger} threw`, isMain ? IDLE : undefined)
      throw error
    }
  })

  // Raised when the dialog is put to the person; a tool.check verdict of `ask`
  // is not, since it also comes when no dialog is shown.
  // A question put to the person is tool.call's to name, not a permission.
  // No event of its own says the person approved: the decision record below does,
  // and failing it the tab stays on permission until the approved tool ends.
  on('classic.PermissionRequest', async ($, e, next) => {
    const isPrompt = e.tool_name !== 'AskUserQuestion'
    // A subagent's dialog is shown too, and remembered: its end is that
    // subagent's tool returning, which otherwise writes nothing.
    if (isPrompt && e.agent_id !== undefined) waiting.add(e.agent_id)
    await emit(
      $,
      `classic.PermissionRequest tool=${e.tool_name} agent=${who(e.agent_id)} mode=${e.permission_mode}`,
      isPrompt ? PERMISSION : undefined,
    )
    return next(e)
  })

  // The engine logs each decision on a tool call for the operator's collector, with
  // or without one configured (observed): an accept the person gave, of a call in flight,
  // is the approval of the dialog that is up, the main agent's or a subagent's. An
  // accept from a rule, a mode or a hook comes with no dialog of its own, and may
  // come while another call's dialog is up. Read, never changed.
  on('telemetry.log', { to: 'collector' }, async ($, e, next) => {
    const isApproval =
      e.event === 'tool_decision' && e.attributes.decision === 'accept' && BY_PERSON.has(e.attributes.source)
    const id = isApproval ? e.attributes.tool_use_id : undefined
    if (typeof id === 'string' && calls.has(id)) {
      const agentId = calls.get(id)
      const state = agentId !== undefined ? await settled($, agentId) : isTurnLive ? active() : undefined
      await emit($, `tool_decision accept call=${id} agent=${who(agentId)}`, state)
    }
    return next(e)
  })
}
