# cy7372/rpiv-todo — vendored fork with dancher extensions

> Fork of [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 2.10.0, vendored for self-maintenance (2026-09-13).
> Upstream sync: `git remote add upstream https://github.com/juicesharp/rpiv-mono.git` (already configured); sync = fetch upstream, extract `packages/rpiv-todo`, three-way merge onto the dancher commits.

**Install (pinned ref):**

```sh
pi install git:github.com/cy7372/rpiv-todo@v2.10.0-dancher.1
```

## What this fork adds on top of upstream 2.10.0

Five overlay patches (2026-09-07/09-11, formerly hand-edited into `node_modules`, tracked in upstream issue #215):

1. Hide the overlay the instant all alive tasks are completed (no waiting for next turn)
2. Status-bar progress `N/M ● current-subject`
3. One-shot all-completed toast (latch resets when new work appears)
4. Completed lists sediment to a memory service (best-effort, silent)
5. Fullscreen collapse to one heading line while scrolled up in history

Dancher extension (2026-09-13, commit 470a885) — informed by [Ona's "rethinking the todo tool"](https://ona-frontmatter.chrprompt.com/blog/1697542992672/) post-mortem and the Claude Code / TaskTrellis feature survey:

- **Priority** `P0/P1/P2` on create/update — overlay and `/todos` sort by priority within a status; P0 badge pops
- **One-level subtasks** — `parent:#N` (validated: exists, top-level, not self); overlay nests children with `(done/total)` rollup; deleting a parent detaches children
- **Timestamps** — `createdAt` / `completedAt` / `updatedAt` bookkeeping; `get` prints them
- **Flexible corrections** — `deleted → pending` (undelete), `completed → in_progress/pending` (reopen)
- **Blocked hard guard** — `in_progress`/`completed` rejected while blockers are unfinished; the error names them and teaches the fix
- **All-done guardrail** — when a completion drains the list, the tool result itself carries "deliver the final summary now" (the classic end-of-list failure is drifting onward, not task failure)
- **Advisory note** when completing a parent with open subtasks
- **list filter** — case-insensitive substring over subject / description / owner
- **Overlay heading** — 8-cell progress bar `▓▓░░░░░░ (3/7)`
- **Robust memory-service import** — multi-candidate path probe so package relocation never silently kills sedimentation

Dev: `tsc -p tsconfig.json` (type-check, paths mapped to a local pi install) · `node smoke.mjs` (25-check behavioral suite)

---

# @juicesharp/rpiv-todo (upstream README below)

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-todo.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo">
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-todo/docs/cover.png" alt="rpiv-todo — a persistent todo overlay for Pi Agent, showing a task panel with completed, in-progress, and pending rows" width="50%">
  </a>
</div>

Give the model a task list you can see. `rpiv-todo` adds a `todo` tool, a
`/todos` command, and a live panel above the editor to
[Pi Agent](https://github.com/badlogic/pi-mono), so you always know what the
agent is doing now, what it finished, and what is queued. The list is rebuilt
from the conversation itself, so it survives `/reload` and compaction — useful
on long research → design → implement sessions.

## Install

```sh
pi install npm:@juicesharp/rpiv-todo
```

Restart your Pi session.

## Quick start

Run `/todos` after the restart to confirm the extension is loaded. On a fresh
session it prints:

```
No todos yet. Ask the agent to add some!
```

Then ask for something with several steps — "add a repository layer with tests,
and track it as todos". The model calls `todo` and the panel appears above your
input box, updating as work moves:

![Todo overlay panel: a Todos (2/7) heading above two struck-through completed rows, one in-progress row with its activity label, and four pending rows](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-todo/docs/overlay.jpg)

Press `ctrl+shift+t` to collapse the panel to its heading plus a one-line hint,
and again to expand it. Run `/todos` at any time to print the full list grouped
by status.

## What you get

- **The plan stays on screen.** A panel above the editor shows every task with a
  status glyph, the label of whatever is in progress, and a `Todos (done/total)`
  heading — you never have to ask the agent where it is.
- **Tasks survive `/reload` and compaction.** Each tool call carries the full
  post-mutation snapshot, and the list is replayed from the session branch. No
  disk writes, nothing to lose.
- **Finished work gets out of the way.** Completed rows stay visible for the rest
  of the turn, then drop at the start of the next one; the panel disappears
  entirely when the list empties.
- **The overlay never eats your terminal.** Past the row budget it drops
  completed tasks first, truncates unfinished ones last, and tells you what it
  hid with `+3 more (2 completed, 1 pending)`.
- **The agent can sequence work, not just list it.** `blockedBy` dependencies are
  validated before anything is written — dangling ids, deleted dependencies,
  self-blocks, and cycles are all rejected.
- **Parallel sessions stay separate.** Task state is keyed by session, so a
  detached or child session can neither read nor overwrite the foreground list.
- **Localized UI, no setup required.** Nine locales ship with the package and
  activate when [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
  is installed; without it, everything falls back to English.

## Configuration

Optional. Create `~/.config/rpiv-todo/config.json` (or
`$XDG_CONFIG_HOME/rpiv-todo/config.json` if you set that variable):

```json
{
  "maxWidgetLines": 8,
  "collapseKey": "alt+t"
}
```

| Setting | What it does | Default |
| --- | --- | --- |
| `maxWidgetLines` | Content rows the overlay may use, heading included. Minimum `3`. Applies on the next repaint. Pi's tool-output expansion mode shows all tasks. | `12` |
| `collapseKey` | Key that collapses and expands the panel, in Pi keybinding form (`alt+o`, `ctrl+shift+t`). Set `"off"` to register no shortcut. Needs `/reload` to rebind. | `"ctrl+shift+t"` |
| `guidance` | Replaces the built-in instructions the extension gives the model about when and how to use the todo list. Needs `/reload`. | _(built-ins)_ |

A missing or malformed file falls back to these defaults. `rpiv-todo` only reads
this file — it never writes one. Full semantics:
[Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-todo/docs/configuration.md).

## Reference

- [`todo` tool reference](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-todo/docs/tool-schema.md)
  — every `todo` parameter, the status machine, the response envelope, and the
  exact error strings.
- [Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-todo/docs/configuration.md)
  — config file resolution, option validation rules, and the accepted keybinding
  grammar.
- [Overlay and `/todos`](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-todo/docs/overlay.md)
  — overlay lifecycle, glyphs, overflow behavior, `/todos` output, and
  localization.

## Requirements

- A Pi Agent host. No API key, no model selection, no native dependencies.
- An interactive session for the panel and `/todos`. Headless runs still get the
  `todo` tool; nothing is rendered.
- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
  is an optional peer — install it for a localized UI, skip it for English.

## Related

- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
  ([source](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-i18n))
  — localizes this extension's UI chrome and adds a `/languages` picker.
- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi)
  ([source](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-pi))
  — the umbrella package that installs this extension alongside its siblings.

## License

MIT — see [LICENSE](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-todo/LICENSE).
