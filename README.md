# agent-state

A Claude Code mod that shows what Claude is doing in the iTerm2 tab subtitle, so a glance at the tab bar tells which
session needs you.

**iTerm2 only.** In any other terminal the mod writes nothing and reports nothing.

Requires macOS, iTerm2 and Claude Code 2.1.296, the version it was tested on. The hooks API it uses is early access and
may change between releases.

| The tab shows          | Meaning                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| ⚙️ working             | Main agent is running                                                    |
| 🔐 permission          | A permission dialog is waiting for you, the main agent's or a subagent's |
| ❓ input               | A question dialog is waiting for you                                     |
| 💤 idle `Oct 10 12:40` | Nothing is running, since that time                                      |
| 💤 idle `… · 1 job`    | Waiting for you, with a background command still running                 |
| 🧵 background          | Main agent is idle, a subagent is running                                |
| 📦 compacting          | The conversation is being compacted                                      |
| (blank)                | The session ended                                                        |

## Set up

1. Install the mod:

   ```
   /plugin install agent-state --marketplace M-i-k-e-l/agent-state
   ```

2. In iTerm2, open Settings → Profiles → General and set the profile's Subtitle to:

   ```
   \(user.claudeState)
   ```

3. Start a new Claude Code session. The tab shows 💤 idle, and ⚙️ working once you send a prompt.

## What it reads

The mod reads Claude Code's `tool_decision` telemetry records to see the moment you approve a permission dialog; no
other event says so. It reads them and changes none, and it sends nothing anywhere. This is why `claude plugin validate`
prints "hooks telemetry for: collector". It works with `DISABLE_TELEMETRY=1` set.

## How it works

The mod writes the state to the tab's terminal as an iTerm2 user variable, `user.claudeState`, which the Subtitle shows.
It starts a short shell process only when the state changes, about two for each prompt you send.

## Limits

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
| `AGENT_STATE_LOG`      | Names a file; the mod appends one line to it for each write it attempts                 |
| `AGENT_STATE_HEADLESS` | Lets a session with no person at the prompt (`claude -p`, the SDK) write to the tab too |

A `claude -p` run stays silent by default because one started from inside another session's tool call would write over
that session's tab.

Design notes, with the signal for each state and the by-hand test table: [docs/design.md](docs/design.md).

## License

MIT
