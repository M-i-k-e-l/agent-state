import type { EngineInterface, Register } from 'claude-code'

// Shows Claude's state in the iTerm2 tab through the user variable the profile's
// Subtitle reads: \(user.claudeState). Only an event that changes what the tab
// shows starts a process.

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
  printf '\\033]1337;SetUserVar=%s=%s\\007' "$1" "$(printf '%s' "$state" | base64 | tr -d '\\n')" > "$tty" 2>/dev/null
  rc=$?
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

// Writes the state to the tab; an event with no state leaves the tab alone, and so
// does one whose state the tab already shows. A repeated idle keeps its first stamp.
const emit = ($: EngineInterface, line: string, state: string | undefined): Promise<unknown> => {
  if (state === undefined || isOff) return Promise.resolve()
  const at = Date.now() - loaded
  const note = state === IDLE ? jobsNote() : ''
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
  return queue
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isHeadless = !e.isInteractive
    await emit($, `session.start surface=${e.surface} interactive=${e.isInteractive}`, IDLE)
    return started
  })

  on('session.end', async ($, e, next) => {
    // A /clear ends the conversation, not the process, and no session.start follows.
    jobs = 0
    listed = ''
    await emit($, `session.end reason=${e.reason}`, e.reason === 'clear' ? IDLE : CLEARED)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
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
