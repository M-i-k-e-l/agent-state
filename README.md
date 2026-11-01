# agent-state

A Claude Code mod that shows what Claude is doing, so a glance tells which session needs you: in the iTerm2 tab subtitle,
and in a Sessions pane in the Claude desktop app.

**iTerm2 and the desktop app's Code tab only.** In any other terminal the mod writes nothing and reports nothing.

Requires macOS and Claude Code: 2.1.296 for the iTerm2 tab and 2.1.309 for the desktop app, the versions they were
tested on. The hooks API it uses is early access and may change between releases.

| The tab shows          | Meaning                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| ⚙️ working             | Main agent is running                                                    |
| 🔐 permission          | A permission dialog is waiting for you, the main agent's or a subagent's |
| ❓ input               | A question dialog is waiting for you                                     |
| 💤 idle `Oct 10 12:40` | Nothing is running, since that time                                      |
| 💤 idle `… ⏳1`        | Waiting for you, with a background command still running                 |
| 🧵 background          | Main agent is idle, a subagent is running                                |
| 📦 compacting          | The conversation is being compacted                                      |
| (blank)                | The session ended                                                        |

## Set up

### iTerm2

1. Install the mod:

   ```
   /plugin install agent-state --marketplace M-i-k-e-l/agent-state
   ```

2. In iTerm2, open Settings → Profiles → General and set the profile's Subtitle to:

   ```
   \(user.claudeState)
   ```

3. Start a new Claude Code session. The tab shows 💤 idle, and ⚙️ working once you send a prompt.

### The desktop app

1. Install the mod: click + next to the prompt box, then Plugins, Add marketplace with `M-i-k-e-l/agent-state`, then Add
   plugin. Installing it from a terminal, as above, works too.
2. Start a new session. A **Sessions** button shows in the line under the prompt.

## The desktop app

The **Sessions** button counts the app's sessions in each state, what waits on you first, such as
`Sessions · 🔐1 ❓1 ⚙️2 💤6`. Clicking it opens or closes the pane, for every session of the app.

The pane lists the sessions under their projects, each with its name, its state and how long it has been in that state.
The session you are in has a `›` before its name. Clicking a name opens that session. The ↑ and ↓ next to a project move
it up and down, for every session too.

**Time** and **Projects** at the top of the pane pick the view, for every session. **Time**, the default, shows three boxes, each ordered
by your last message, newest first, with each session's project on a line of its own:

- **Recent**: your latest message and the 2 hours before it, plus any session that ran in that time or is not idle.
- **Today**: the rest from today.
- **Older**: everything else.

A session with no message on record yet uses its last activity instead.

The state's color means the same in both views: the theme's `error` for permission and input, its `success` for working,
background and compacting, its `warning` for an idle session that counts as Recent, and dim for any other idle.

## What it reads

The mod reads Claude Code's `tool_decision` telemetry records to see the moment you approve a permission dialog; no
other event says so. It reads them and changes none, and it sends nothing anywhere. This is why `claude plugin validate`
prints "hooks telemetry for: collector". It works with `DISABLE_TELEMETRY=1` set.

In the desktop app it also reads the list of sessions through the app's own session tools, and keeps what the sessions
share on your machine: each session's state in `~/.claude/agent-state/`, the pane's order, open or closed choice and last list in
`~/.claude/agent-state.*.json`, and the pane's view in the plugin's own store.

## How it works

In iTerm2, the mod writes the state to the tab's terminal as an iTerm2 user variable, `user.claudeState`, which the
Subtitle shows. It starts a short shell process only when the state changes, about two for each prompt you send.

In the desktop app, each session writes its state to a file of its own. Every second, each session redraws its button
and pane from those files. Every ten seconds, it fetches the app's list of sessions, which decides what shows and under
what name.

## Limits

In iTerm2:

- After you approve with "always allow", or if the approval record is missing, the tab may stay on 🔐 until the approved
  tool ends.
- An interrupted `/compact` may leave 📦 until the next event (untested).
- If something else changes the tab's variable, the tab stays wrong until the state next changes.
- A `claude -p` or SDK session shows nothing unless `AGENT_STATE_HEADLESS` is set.
- A session moved to the background (`/background`) blanks the tab, and the tab you attach it from stays blank until
  the state next changes.
- A dialog Claude Code opens by itself at the prompt, such as "Teach auto mode about your environment?", leaves the tab
  as it was: no event a mod may read says it is up.
- Claude Code on a Linux machine, reached over SSH from iTerm2, shows nothing (read from the code, not tried).
- Not tried: tmux inside iTerm2, and a permission dialog in auto mode.

In the desktop app:

- The pane opens late on a session you have not visited recently: the app has stopped that session's process, and the
  pane cannot open until it runs again. The pane belongs to each session, so it can't be kept up in the meantime.
- The projects start in Z to A order, and your order is the arrows': the app does not tell a mod the order of its
  sidebar.
- Sessions in a terminal, shown in the app as Remote Control sessions, are not listed or counted.
- The Sessions button is the app's gray chip: the app ignores any color a mod asks for there.
- After the mod reloads, a session's idle time starts over from the reload.
- A session that crashes keeps its last state until it next starts, as long as the app lists it.
- Not tried: closing the pane with its own close mark, which should close it for every session.

## Development

Load the mod from a checkout by setting `CLAUDE_CODE_PLUGIN_DIRS` to its folder in the `env` block of
`~/.claude/settings.json`. Saving a file reloads the mod in every open session; a session that is working then shows 💤
until its next prompt.

Checks: `claude plugin validate .`, `claude plugin test .`, and `tsc -p .` once Claude Code has loaded the mod and
written `.claude-plugin/types/`.

When checking by hand, stay in manual mode for a whole test: it is the easiest way to get a permission dialog.

Two environment variables, both unset by default:

| Variable               | Effect when set                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `AGENT_STATE_LOG`      | Names a file; the mod appends one line to it for each write it attempts, and repeats    |
| `AGENT_STATE_HEADLESS` | Lets a session with no person at the prompt (`claude -p`, the SDK) write to the tab too |

A `claude -p` run stays silent by default because one started from inside another session's tool call would write over
that session's tab.

Design notes, with the signal for each state and the by-hand test table: [docs/design.md](docs/design.md).

## License

MIT
