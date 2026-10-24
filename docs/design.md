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
| 🧵 background               | `turn.complete` while `$.agent.list()` has a running, pending or waiting agent  |
| 🔐 permission               | `classic.PermissionRequest`, main agent or subagent, tool not `AskUserQuestion` |
| ❓ input                    | the main agent's `tool.call` on `AskUserQuestion`, before `next`                |
| 📦 compacting               | the main agent's `session.compact`, trigger not `precompute`, before `next`     |
| blank                       | `session.end`, any other reason                                                 |

Rules:

- Subagent events carry `agentId` and never write the tab, with one exception: a subagent's permission dialog writes 🔐,
  since it is the person the session waits on. The mod remembers which subagents have a dialog up; 🔐 holds over
  working, background and idle until the person approves it, that subagent's tool returns or its turn ends.
- A `turn.complete` for a turn that is no longer the current one is ignored: a prompt typed over a running turn starts
  the new turn before the old one's end is reported.
- After a compaction the tab shows working if the turn is live, else idle or background.
- Idle adds `⏳N` for the background shells the main agent's last `classic.Stop` listed. Subagents are left
  out, as `$.agent.list()` counts those, and so are monitors: a session watching its published artifacts for comments
  keeps one running for each (observed). A command may be a server that runs as long as the session, so it adds to idle and
  does not make it background. `classic.Stop` comes just before the main agent's `turn.complete` (observed); a turn's
  start clears the count, as an interrupted turn may raise no `Stop`.
- The tty is found by walking up the process tree from the `$.process.run` child; writes are serialized.

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
- An "always allow" answer (`user_permanent`) has not been tried.
- Ways of switching telemetry off other than `DISABLE_TELEMETRY=1` have not been tried.
- Not known: whether the engine starts a second call while another call's dialog is up. If it does, one wrong case is
  left: a person's accept for one call of a subagent clears 🔐 while a second dialog of that subagent waits.
- When a permission dialog is dismissed with Esc, the tool's return writes ⚙️ about 30ms before the turn's end writes
  💤; not visible. A tool interrupted while it runs writes 💤 alone.
