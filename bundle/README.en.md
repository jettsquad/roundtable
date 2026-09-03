# @jettsquad/roundtable

[中文](README.md) | English

A **human-chaired** roundtable of agent seats, as a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.

Several agents sit in seats. **You** decide who speaks, what they see, and when.
Slash commands are typed by a person, run by code, and never enter model history —
so nothing above the table can quietly put an LLM in the chair.

## Install

```sh
dsh plugin --profile web add @jettsquad/roundtable
dsh web
```

A "团队" (Teams) button appears at the bottom of the sidebar. It is empty — teams,
agents, prompts, connections and criteria are yours to create.

> **The interface is Simplified Chinese only for now.** English localization is in
> progress.

## Requirements

- `dsh` ≥ 0.1.2-alpha.5, with `pnpm` on PATH (`dsh plugin` forwards to it)
- Node `^22.19 || >=24`
- The CLI and login for whichever seat backends you use:
  `claude` (Claude Code) · `codex` · `dsh` itself

Seats are **child processes** using logins you already have. Squad neither creates
nor modifies them.

## Where the data lives

All under `$DSH_HOME` (default `~/.dsh`): teams and rosters, discussions, the
prompt-fragment library, connections, criteria. Uninstalling does not delete them.

**Credentials are stored by name only** — values are resolved per call by dsh's own
credentials service. This package never holds a secret.

## Uninstall

```sh
dsh plugin --profile web remove @jettsquad/roundtable
```

Source: https://github.com/jettsquad/roundtable
