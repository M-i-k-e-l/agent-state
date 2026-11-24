# agent-state mod — design notes

A turn (taken from the hook names of Claude Code's engine) is everything Claude does from one prompt until it stops and
waits. A background subagent's report starts a turn too, with no prompt typed.

## Decisions

| Decision                                  | Why                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| No fallback for the approval signal       | the one candidate could clear 🔐 early (see The approval signal)       |
| 🔐 from `classic.PermissionRequest`       | `tool.check` verdict `ask` also fires when no dialog is shown          |
| The hooks wait for the write              | on exit the process could end before the tab is blanked                |
| Only a `/dev/` tty is cached              | the search is two thirds of a write; a cached miss would stop them all |
| Repeated states are not written           | each write starts a process; about a third repeated the last one       |
| The log switch is an environment variable | the module runs with no Node; the script can read the environment      |
| Each write is sent again 0.5s later       | a write inside Claude Code's title write is lost (see The repeat)      |

## Cost

Each write to the tab starts one short shell process, which leaves a sleeping one behind for the repeat. Script timings
are 40 runs each from a shell, with the tty three levels up the process tree. The scripted turn is a `claude -p` run
with two shell tool calls; its count includes the session's start and end. The average real turn is computed, not
counted: a log of 119 real turns, taken before repeated states were skipped, had 3.5 writes a turn, a third of them
repeats.

| Time                    | ms  |
| ----------------------- | --- |
| One write, tty searched | 28  |
| One write, tty known    | 9   |

| Count                                    | Number |
| ---------------------------------------- | ------ |
| Processes in the scripted turn           | 4      |
| Writes in an average real turn, computed | 2.4    |

## Signal map

| State                       | Signal                                                                          |
| --------------------------- | ------------------------------------------------------------------------------- |
| ⚙️ working                  | `turn.start`; a tool's return while the turn is live; an approval (see below)   |
| 💤 idle, with date and time | `turn.complete` of the current turn; `session.start`; `session.end` on `/clear` |
| 🧵 background               | `turn.complete` while a subagent or a workflow runs, pends or waits (below)     |
| 🔐 permission               | `classic.PermissionRequest`, main agent or subagent, tool not `AskUserQuestion` |
| ❓ input                    | the main agent's `tool.call` on `AskUserQuestion`, before `next`                |
| 📦 compacting               | the main agent's `session.compact`, trigger not `precompute`, before `next`     |
| 🙋 needs you, app only      | idle, and the app's record of the session asks the person (see below)          |
| blank                       | `session.end`, any other reason                                                 |

Rules:

- Subagent events carry `agentId` and never write the tab, with one exception: a subagent's permission dialog writes 🔐,
  since it is the person the session waits on. The mod remembers which subagents have a dialog up; 🔐 holds over
  working, background and idle until the person approves it, that subagent's tool returns or its turn ends.
- A `turn.complete` for a turn that is no longer the current one is ignored: a prompt typed over a running turn starts
  the new turn before the old one's end is reported. Only the main agent's `turn.start` makes a turn current; a
  subagent's comes during the main turn when `SendMessage` wakes it (observed).
- After a compaction the tab shows working if the turn is live, else idle or background.
- Idle adds `⏳N` for the background shells the main agent's last `classic.Stop` listed. Subagents are left
  out, as `$.agent.list()` counts those, and so are monitors: a session watching its published artifacts for comments
  keeps one running for each (observed). A command may be a server that runs as long as the session, so it adds to idle and
  does not make it background. `classic.Stop` comes just before the main agent's `turn.complete` (observed); a turn's
  start clears the count, as an interrupted turn may raise no `Stop`.
- A subagent is one that `$.agent.list()` gives as running, pending or waiting. A workflow (the `Workflow` tool, such
  as a deep research) is one the main agent's last `classic.Stop` listed: `$.agent.list()` leaves a workflow's agents
  out (its docs), and a session showed 💤 while its workflow ran (observed). A turn's start clears the count, as for
  shells.
- A workflow that ends by itself, done or failed, reports, which starts a turn: 🧵 ends there. One the person stops or
  pauses sends a passive notice, which starts no turn (read from the engine's code), and no event a mod may read says so
  reliably (its agents' turns may end aborted, but so does an agent skipped or retried alone): 🧵 holds until their next
  message, and a subagent's dialog or a compaction that settles meanwhile writes 🧵 again.
- A turn interrupted while a workflow runs may raise no `Stop`, and then it ends in 💤 until the workflow reports or a
  later turn ends; so does a reload, which writes 💤 for a subagent too. Keeping the count over a turn's start would
  trade that for a 🧵 that sticks when the workflow's own report turn is interrupted, and would differ from the shells'
  count.
- The tty is found by walking up the process tree from the `$.process.run` child; writes are serialized.
- 🙋 needs you is drawn, never filed or written to the tab. Each redraw takes an idle session's record from
  `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/<id>.json`, read again only when its
  time changes. The rule is the app's own check of whether a session waits on the person (read from its code; the sidebar dot is drawn
  where a mod cannot read it): a `turnWrapUp` with a `needsUser`,
  unless `postTurnSummary.status_category` is `failed`; with no `turnWrapUp`, a `postTurnSummary` whose
  `postTurnSummaryFor` is the `lastAssistantUuid` and whose category is `blocked` or `need_input`. The app clears
  `turnWrapUp` when the person sends a message and when a turn starts. The record does not say whether the session
  runs, so the mod's own idle stands for that, with or without `⏳N`. The app counts background work as running; the
  mod does not follow it there, as the question waits on the person whatever runs behind it, and a command that
  never ends, a dev server, would hide the 🙋 for good. A session in 🧵, its main turn over and subagents still
  running, takes the same rule. So do the sound and the push. One Dismiss is for one question, and a question is
  its turn's: the session's file holds `turnAt`, when the main agent's last turn started, and a dismissal holds
  until a later message or turn, whatever subagents or commands do meanwhile. A file with no `turnAt`, and a session
  the app lists with no process, go by the last message, activity or run.

## Test table

Done by hand in iTerm2.

| #   | Case                                          | Result                                         |
| --- | --------------------------------------------- | ---------------------------------------------- |
| 1   | Prompt, no tools                              | ✅ ⚙️ → 💤                                     |
| 2   | Auto-allowed tool                             | ✅ no false 🔐                                 |
| 3   | Session start                                 | ✅ 💤                                          |
| 4   | Permission dialog appears (manual mode)       | ✅ 🔐 at once                                  |
| 5   | Approve, long tool                            | ✅ ⚙️ at the approval                          |
| 6   | Approve, short tool                           | ✅ ⚙️                                          |
| 7   | Answer "No"                                   | ✅ 💤                                          |
| 8   | Esc on the permission dialog                  | ✅ 🔐 → 💤                                     |
| 9   | Esc while thinking                            | ✅ 💤                                          |
| 10  | Esc mid-tool                                  | ✅ 💤 within 60ms                              |
| 11  | Ctrl+C mid-tool, and while thinking           | ✅ 💤                                          |
| 12  | `/exit`, then resume                          | ✅ blank; 💤 on resume, mod reloaded by itself |
| 13  | Question dialog, answered                     | ✅ ❓ → ⚙️                                     |
| 14  | Question dialog, Esc                          | ✅ ❓ → 💤                                     |
| 15  | `/compact`                                    | ✅ 📦 → 💤                                     |
| 16  | `/compact`, Esc or Ctrl+C midway              | not tested                                     |
| 17  | `/rename` (local command)                     | ✅ stays 💤                                    |
| 18  | Subagent runs after the main turn ends        | ✅ 🧵, no flicker                              |
| 19  | Subagent finishes                             | ✅ ⚙️ → 💤                                     |
| 20  | Kill a task from `/tasks`                     | ✅ 🧵 → ⚙️ → 💤                                |
| 21  | Background subagent needs permission, Esc     | ✅ 🔐 → 🧵 → ⚙️ → 💤                           |
| 22  | Background subagent needs permission, approve | ✅ 🔐 → 🧵 at the approval → ⚙️ → 💤           |
| 23  | Subagent's background shell outlives its turn | ✅ 🧵 → ⚙️ → 💤                                |
| 24  | Main agent's background shell outlives a turn | ✅ 💤 `⏳1` → ⚙️ → 💤                          |

Ctrl+C has no effect on the question dialog or the permission dialog; the tab keeps the dialog's state, which is right.

Row 20: a killed subagent's own turn ends `aborted` and writes nothing. The tab leaves 🧵 because the kill sends the
main agent a task notification, which starts a turn (⚙️) that then ends (💤). A kill that sent no notification would
leave 🧵 until the next event; not observed.

Row 21: after Esc the subagent is still running while it writes its report, hence 🧵; its report then starts a main turn
(⚙️ → 💤).

## The repeat

Claude Code sets the tab title as it redraws, and both it and the mod write to the same terminal. A write of the mod's
that lands inside a title write is taken as title text: the variable keeps its old state, and the title ends with
`1337;SetUserVar=…` (observed once, a tab left on ⚙️ after its turn ended). So each write that went out is sent again
half a second later, unless a newer write has gone out to that tty since; a mark file in `$TMPDIR` names the latest.
The repeat is logged as `#N again`.

A stress test in a spare tab, one process writing frames with title sequences every 2ms and the variable read back
through AppleScript after each write, lost 46 to 48 of 100 single writes and none of 100 with the repeat.

## The approval signal

No event of its own fires when a permission is approved. The approval of a permission dialog (rows 5 and 22) writes ⚙️
for the main agent and 🧵 for a background subagent, at the approval.

- The signal is the `tool_decision` record the engine logs on the operator-collector telemetry stream:
  `decision: accept`, `source: user_temporary`, `tool_name`, `tool_use_id`, no agent id. The mod maps the call's id to
  its agent from `tool.call`.
- Only an accept a person gave counts: `source` `user_temporary` (observed) or `user_permanent` (from the engine's
  monitoring docs). An accept from a rule, a mode or a hook (`config`, `hook`) is left alone: it may come for one call
  while another call's dialog is up.
- The record was raised with no collector configured, and also in a session started with `DISABLE_TELEMETRY=1`. Where it
  is not raised, 🔐 stays until the approved tool ends.
- No fallback covers that case. A running shell command shows a "ctrl+b to run in background" hint, which also tells
  that a call has started. But it does not say who approved the call, and with several calls in flight it may belong to
  a call other than the one whose dialog is up, so 🔐 could clear early.

## The desktop app

The same state logic feeds a second output. A session the app hosts (`CLAUDE_CODE_HOST_SESSION_ID` is set, and no mark
of a session's child, below) writes its state to `~/.claude/agent-state/<id>.json`; any other session writes no file, and the tab's write is as it was. A session
there starts with `surface` null and `isInteractive` false, so the tab's script turns itself off at the first write,
and the file write stands ahead of that gate.

A session that one of the app's sessions starts, such as a test that runs `claude -p`, takes that session's
environment, `CLAUDE_CODE_HOST_SESSION_ID` with it. It is not the app's session, so it writes no file. The marks are
`CLAUDE_CODE_CHILD_SESSION` and `CLAUDECODE`: the engine sets both for what a session's tools and hooks start, and
`CLAUDECODE` alone for its MCP servers (the tools' and the servers' observed, the hooks' read from its code). The process
the app starts has neither (observed, every session running at the time). Either one set, and not to `0`, `false`, `no` or `off`, counts.

| Decision                                     | Why                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| The app's list decides what shows            | a file says neither that a session was archived nor what it is called   |
| A listed session with no live file is idle   | the app stops the process of a session left alone; its file says ended  |
| Names come from the app                      | `session_title` can be the session it was started from (observed)       |
| A session started by a session's tool, hook or MCP server writes no file | it takes the app's id from that session's environment: its states went into that session's file, and its end left a working session shown idle (observed) |
| The mod's own fetches skip its `tool.call`   | the engine raises it on the main loop; its end wrote ⚙️ over ❓ and 🔐  |
| A resumed idle dates from the last answer    | `seconds_since_last_response` says when; the restart is not when        |
| The last list is saved for the next process, and for a session switched back to | the first draw need not wait for a fetch; a hidden session fetches nothing, so the list it held is old |
| One file holds the pane's open or closed     | a pane belongs to a session; each follows the file on a one second timer |
| A session with no surface does not redraw or follow on the timer, and does both once a surface shows it: at the app's attach, or the next tick if the app is listed late | no one sees its drawing, each redraw lists every session's file, and a follow would ask every second to open or close a pane no surface shows; the session on screen reads the others' files, so their rows stay current |
| A session's file is read again only once the listing gives it a new time or size | a redraw comes every second, and most files have not changed since the last; one read mid-write is read again |
| A session's file is deleted once a fetch of the whole list (under 200 rows, not empty, every row with an id) has no such session, the file is a minute older than the fetch, and its process ended or it is a week old | the folder each redraw lists stops growing; a saved list or one the 200 limit may have cut is not whole, and a session just started writes its file before the list has it; an archived or deleted session's process ends, so a list that leaves out a running one by mistake leaves its file, while an ended one relies on the list being whole; `$.fs` deletes nothing, so `rm` does |
| A click opens a session through `open`       | a pane draws only an `https:` link; the app's link is `claude://`       |
| The plugin's store holds the pane's view     | every session's pane shows one view; a choice made in one held when moving to another (observed) |
| The view is two buttons in one border, the chosen one primary, the other plain | a mod's elements hold no segmented control |
| Order and boxes use the person's last message | `lastActivityAt` moves while a session works, so rows would move under the pointer |
| Activity, a state other than idle, or idle with background commands puts a session in Recent | a session running or waiting must not sink below what the person last messaged |
| **→ Today** moves an idle session out of Recent until its next message, activity or run, and to Older after midnight, kept in the plugin's store | the person is done with it for now; new work on it is news again. Its color stays, as the Projects view does not know of the move |
| **Pin** keeps a session in Recent, in its place by time like the rest, until **Unpin**, in any state, kept in the plugin's store; a pinned session has no **→ Today**, a pin outranks a move, and Unpin forgets the move | the person wants it at hand whatever its age, and Recent reads as one timeline, so a pin does not reorder it; Pin and **→ Today** sit together at the right of the state line, so they read as the row's actions and Pin lines up down the box; on the name's line a long name pushed Pin out, and spread across the state line → Today floated alone in a wide pane. Its color stays, as the Projects view does not know of pins. A stale pane can store a move under a pin, in either order of the writes; forgetting it on Unpin needs no guard on either press |
| **Dismiss** shows a 🙋 needs you session as it was, idle or 🧵, until its next message or turn (its next message, activity or run where its file holds no `turnAt` or it has no process), in both views, kept in the plugin's store and dated no earlier than the row's own times | the person has seen the question and wants it off the list without answering; 🙋 is a state both views draw, so its button is in both, unlike → Today and Pin; a 🙋 session is never plain idle, so Dismiss and → Today never share a row, and once dismissed the session gets → Today like any idle one, or shows ⏳ again when it has background commands |
| Idle with background commands (`⏳N`) counts as at work in the pane: in Recent, `success`, ranked with background, no **→ Today**, and counted as ⏳ after 🧵 on the button, not as 💤 | it is running as far as the person is concerned; what the commands are is not looked at, so a server keeps the session at work for as long as it runs |
| A pin of a session the app does not list stays | the list can be stale, fail or stop at 200, and an archived session can come back; a pin no row has draws nothing |
| A run is the file's `ranAt`, not `since` | a restart or a reload writes idle with a new `since`, which would undo a move though nothing ran |
| A file's `updated` does not stand for activity while the app's list is known | it moves when the app restarts the process (observed) |
| Permission and input are `error`, other states `success` until idle with no background commands, such an idle `warning` if it counts as Recent and dim if not, in both views | a state's color should not change with the view, so both use the Time view's Recent rule |
| The button under the prompt draws beside `next(e)` | a hook that skips `next` hides every mod after it on that row, so the mods' order would decide what shows |
| A session's project is the app's folder for it while the app's list is known | the app starts a session in a spare folder (`~/.claude/spares/spare-…`) and then moves it, so the folder its file kept from the start is the spare (observed) |

What the app draws (observed):

- A `Button` is one line of plain text. It ignores the `Text` in it, line breaks and color.
- Under the prompt, every `Button` is a gray chip, whichever props it has. In a pane, a `plain` one has no chip.
- `Text` outside a `Button` honors `dimColor`, `size`, `weight` and `color`. `Box` borders draw in a pane.
- `SessionMode` is drawn at the right of the line under the prompt, beside the model. A `Client` draws in `AbovePrompt`,
  and nothing shows in `SessionMode` with one in its tree.
- The app's own panel and sidebar take nothing from a mod. A pane docks at the right, and covers the app's panel when
  the window is narrow.

The projects' first order, Z to A with This computer last, is read off one sidebar; the app tells no one its order. The
pane opens within 0.3 seconds of the mod loading (one log), so the wait on a session whose process has stopped lies
outside the mod.

Done by hand in the app: the states, the count on the button, a question and a permission dialog held through fetches,
a click on a session and on the button, the arrows, the pane following across sessions, and the view holding across sessions. Not tried: closing the pane
with its own close mark, as the test kit cannot act as a person there either.

## Open

- A session moved to the background (`/background`) goes on in a daemon's process with a terminal of its own, and an
  environment without `TERM_PROGRAM`, `LC_TERMINAL` and `ITERM_SESSION_ID`; `ITERM_PROFILE` stays (observed). The mod
  took that for another terminal and stopped writing, so the tab kept the state it had at the move. It now takes
  `ITERM_PROFILE` alone as iTerm2, and its writes reach the tab the session is attached from (tried on 2.1.303). The
  old process blanks the tab as it leaves, and the new one's 💤 is written before anyone attaches, so an attached tab
  stays blank until the state next changes.
- A dialog the engine opens by itself at the prompt ("Teach auto mode about your environment?", observed with the tab on
  🧵) holds the prompt until the person answers, and subagents run on under it. It should show ❓, but nothing a mod may
  read says it is up: no hook event, no render component, and `classic.Notification` is not known to fire for it. The
  engine logs `tengu_auto_mode_env_onboarding_shown`, `_accept`, `_later` and `_dismiss` (names read from the binary) on
  the `anthropic` telemetry stream, and a mod with a hook on that stream is not loaded: it is for the built-in plugins.
- The app started from a shell that carries `CLAUDE_CODE_CHILD_SESSION` or `CLAUDECODE`, such as one a session's tool
  runs, may hand the mark to every session it hosts: none would write a file, and all would show idle. Not tried; the
  `session.start` line of the log says `child=true` there.
- A session moved to the background from one of the app's sessions has neither mark (read from the engine's code).
  Not known: whether it keeps the app's id, and so writes over that session's file.
- An "always allow" answer (`user_permanent`) has not been tried.
- Ways of switching telemetry off other than `DISABLE_TELEMETRY=1` have not been tried.
- Not known: whether the engine starts a second call while another call's dialog is up. If it does, one wrong case is
  left: a person's accept for one call of a subagent clears 🔐 while a second dialog of that subagent waits.
- When a permission dialog is dismissed with Esc, the tool's return writes ⚙️ about 30ms before the turn's end writes
  💤; not visible. A tool interrupted while it runs writes 💤 alone.

## Phone push

With 📱 on, a session of the desktop app sends a push to the person's phone as it stops working and waits. The steps
for the phone, and what each option does, are in [phone-push.md](phone-push.md); this is why it is built as it is.

- **Through ntfy.sh.** It is free, needs no account, and needs no app on the phone: its web page takes pushes in
  Chrome on Android and from the Home Screen on an iPhone, so anyone who installs the mod can use it. The app's own
  push to the phone was the first choice, and did not work well enough to lean on.
- **What is sent.** `POST https://ntfy.sh/<topic>`, the body `<icon> <session name>`, the headers `Title: Claude Code`,
  `Cache: no` unless Keep missed pushes is on, `Priority` when the menu's is not 3, ntfy's default, and `Click` with
  the session's link when it has Remote Control. Left without a title, ntfy shows the topic as one.
- **Which sessions, and when.** A session the app hosts, as it leaves work: 🔐, ❓, 🙋 or 💤. Not a session's end,
  and not a session another session started. A 💤 waits up to 10 seconds on the app's record of the session, which
  may turn it into 🙋. A turn that ends with a command or a subagent still in the background has not left work and
  sends no 💤, but its 🙋 is sent, once for the turn: the question waits on the person whatever runs behind it. Not sent:
  with a dialog up, which pushed for itself, and for an interrupted turn, whose record may hold an older question. Known and left: a 💤 still in that wait goes out though the session ended or was cleared
  meanwhile, and though 📱 was turned off meanwhile.
- **The topic** is a random UUID made on the Mac, or one the person types (16 to 64 letters, digits, `-` or `_`). It
  is never made from an id of Claude's. Whoever knows it reads the pushes, so it is kept out of toasts and the log:
  a failure's reason has it replaced by `<topic>`. No online QR service draws its link, as that service would be
  handed the topic.
- **The link** is `claude://claude.ai/code/<id>`, the id being the last of `bridgeSessionIds` in the app's record of
  the session. It is the one form that reached the Claude app on both phones; the `intent://` forms tried beside it
  are removed. ntfy's web page opens a push's link itself, in the browser, so no tap goes straight to the Claude app:
  on Android Chrome shows **Continue**, on an iPhone ntfy opens and shows **Open link**.
- **The options** (Push on idle, Keep missed pushes, Only when I'm away and its seconds, Priority) are kept in the plugin's
  store and read as each push is about to go, so they hold for every session at once and need no Save. Save and
  Cancel are the topic's alone, and leave the menu open.
- **Only when I'm away** reads `HIDIdleTime` with `/usr/sbin/ioreg`: the nanoseconds since the last key or pointer
  move. Under the seconds set (120 unless changed), the push is held, and it is not sent later. A time that can't be
  read sends the push: one too many is the lesser miss.
- **The menu** is kept in the store too, with the time of its last change, as every session draws the pane and the
  person moves between them. Each session also holds the last it wrote or read, and the later of the two stands, so
  a redraw doesn't put an older draft back over what is being typed.
- **A push that fails** shows a toast with ntfy's reason and 🔕 on the session's row, which says it again when
  pressed. The next push that goes out, or the session's next start, clears it. ntfy.sh takes 250 pushes a day from
  one network address, 60 in a burst, and answers 429 past that.
- **Send test push** goes to the topic in the field, saved or not, from the session whose pane was pressed. It
  follows Keep missed pushes and Priority, and ignores the other options. ntfy.sh can't say whether anyone listens to a topic, so
  the toast says only that the push went out, and that it has no link when the session has no Remote Control.

What the app's drawing allows, found by trying:

- A one-line field is drawn at a width of its own; a field of two rows or more fills the pane. A box of a set width
  around a one-line field narrows it. Nothing sets where a field's text sits.
- A field shows a button of its own only with a `submitLabel`, and that button is Enter. The topic field has none,
  and Enter there does nothing: only Save saves.
- A dropdown takes no width, and a box of a set width around it does not stretch it. Push on idle was a dropdown of
  two choices and became a toggle for that reason.
- A toggle drawn without chrome when off is shorter than a filled one, so the rows below it jumped. On and off are
  both drawn as buttons, primary and secondary.
- The toggles and their links are two columns, so the links start at one edge; each link's box grows to its toggle's
  height.
- A change to the mod's code does not reliably load into a running app: restart the app.

Done by hand: pushes on Android with Chrome in the background and with the ntfy tab closed, and on an iPhone from the
Home Screen (a phone on another Claude account: the tap reached the Claude app); the tap on both; Push on idle off;
Only when I'm away, both held and sent. Not tried: Keep missed pushes on a phone, the ntfy app in place of its
web page, and 🙋 for a turn that asks with a command in the background or with a subagent running (pane, sound,
push and Dismiss).

## The sound

- **🔊 On/Off** and its **▼** menu sit after 📱's in Alerts. The store's `sound` holds the file in force, or `off`;
  `soundPick` holds the last pick, so Off keeps it. On takes the pick, or the first sound where none was made. A
  store from before 0.8.0 holds only `sound`, and reads the same: a file is On.
- **One menu at a time.** The store's `pushMenu` holds both menus' open state in one value (`isOpen` for 📱,
  `isSoundOpen` for 🔊), and a write that opens one leaves the other out. Opening 🔊 hides 📱's menu and keeps a
  topic typed and not saved, which 📱's ▼ shows again; only 📱's own ▲ drops it.
- **Current session** (`soundCurrent`: `play`, the default, `atMac` or `silent`) says what the session the person
  last opened does with the sound: the app's record of each session holds `lastFocusedAt`, a time in milliseconds,
  and the latest names that session. Read only as a sound is about to play, and only the records written since this
  session's own time. The app does not say whether the person is still looking, so `atMac` also asks that a key or
  the pointer was used in the last 60 seconds, its own time and not 📱's Away after; `silent` holds the sound
  whatever the Mac says. A record or a time that can't be read plays the sound. A pick in the menu plays whatever
  this says. The push does not follow it: Only when I'm away is the push's own.

## Phone push: might add later

- An own ntfy server: an option for a server address in place of ntfy.sh, for someone who runs ntfy themselves and
  wants the pushes kept off a public service.
- A QR code of the topic link in the menu, to scan with the phone in place of copying the link over. It has to be
  drawn by the mod itself: an online QR service would be handed the topic.
- The menu on a surface with no text field, as the phone app's pane may be: there the menu shows the topic as plain
  text, so it can't be typed or pasted. Not tried on a phone.
