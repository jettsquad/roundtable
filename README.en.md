# Squad · Roundtable

[中文](README.md) | English

A **human-chaired** roundtable, running on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Several agents sit in seats. **You** decide who speaks, what they see, and when.

```sh
dsh plugin --profile web add @jettsquad/roundtable
dsh web
```

A "团队" (Teams) button appears at the bottom of the sidebar. It is empty — teams,
agents, prompts and connections are yours to create.

> **The interface is currently Simplified Chinese only.** English localization is
> in progress; the harness's own `zh`/`en` switch does not yet cover this plugin's
> copy.

## How this differs from a "multi-agent framework"

In most such systems a _model_ does the scheduling: it decides who is called, what
they see, when to stop. Not here.

**Slash commands are typed by a person, run by code, and never enter model
history.** That is not a stylistic preference — it is an invariant the code
enforces. The context-assembly layer keeps a separate table of events that only a
_turn_ can produce (`turn/start`, `assistant/*`, `tool/*`), and **throws** the
moment one appears in the host node's log. Their presence would mean the chair
itself spoke, and the chair is an anchor, not a decider.

That table also covers dsh's own Agent Teams `team/*` events. Upstream's lead is a
model; ours is a person. Mount both and it throws — which is the correct answer,
not a merge.

## What a session looks like

1. **Form a team** — pick a project folder, seat agents from your library. One
   folder = one workspace = one team.
2. **Speak** — `@someone` for one person, or ask everyone. Each seat is a **fresh
   process** that sees only the window you hand it.
3. **Agenda** — the secretary drafts a phased plan; nothing runs until you confirm
   it. If it goes wrong you can **rewind to any phase** and re-run.
4. **Checkpoints** — a long discussion folds into key points. The original is
   still there and can be brought back.
5. **New sitting** — one team can hold many sittings. Same roster, separate
   discussions.

## Seat backends

| Backend       | Runs                             | Tool fence                            |
| ------------- | -------------------------------- | ------------------------------------- |
| `claude-code` | your machine's Claude Code login | yes (Task/Agent denied by default)    |
| `codex`       | `codex exec`                     | none — codex has no tools to delegate |
| `dsh`         | `dsh --profile headless`         | none                                  |

Seats are **child processes** using logins you already have. Squad neither creates
nor modifies them. A dsh seat emits a heartbeat on stderr so the watchdog can tell
"thinking" from "dead".

## Where the data lives

All under `$DSH_HOME` (default `~/.dsh`): teams and rosters, discussions, the
prompt-fragment library, connections, criteria. Uninstalling does not delete them.

**Credentials are stored by name only** — values are resolved per call by dsh's own
credentials service. This code never holds a secret.

## Three prompt layers

Team-wide prompt → fragment sets (attached to some seats) → the seat's own prompt.
The fragment library is user-level and teams copy from it; a team may edit its copy
in place, and edited copies are marked — because refreshing overwrites silently,
and without the mark nobody would know their edit was gone.

## Development

```sh
npm install          # runs link-dsh: bind this checkout to your dsh's own framework copy
npm run install-profile
npm run ui
```

Why `link-dsh` exists: **Node caches modules by realpath.** If this repository
resolved its own copy of cordis while the profile resolved the harness's, the
process would hold two service registries and two `Symbol.for` identities — and
every symptom would point somewhere other than the cause. It records the bound
harness commit in `.dsh-link.json` and warns when it changes: dsh being swapped
underneath you should not present as "behaviour changed and no diff explains it".

```sh
npm run typecheck && npm run lint && npm test
npm run build:bundle     # produce the publishable @jettsquad/roundtable
```

Published and development trees **share one patch file**:
`bundle/cordis.patch.yml` is the single source, and the development one is
generated from it. Two hand-maintained copies of the same plugin tree drift, and
the drift presents as "works for me, breaks when they install it".

## Requirements

- `dsh` ≥ 0.1.2-alpha.5, with `pnpm` on PATH (`dsh plugin` forwards to it)
- Node `^22.19 || >=24`
- The CLI and login for whichever seat backends you use

## License

MIT.
