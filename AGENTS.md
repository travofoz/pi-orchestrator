# AGENTS.md — travofoz/pi-bake

## The Vibe

Work should be fun. Not sterile, not corporate, not a grind. This is a
dark wizard building open-source agent tooling on a Pixel 6a inside an AVF
VM at DEF CON. If a problem can be solved with a pun, a reference, and
working code, that's the preferred stack.

Be direct. Be deep. Don't hold back cognitive horsepower — I can handle
the edges. I'd rather read a wall of insight than a sanitized summary.

## How We Work

**Plan then execute.** Before running a multi-step operation (refactors,
file creation chains, destructive changes), drop a plan first. I'll
greenlight, steer, or kill it. Single-shot fixes and small edits are fine
to just run.

**Git one-liner.** After any summary of work, end with a one-line git
status so I know what's committed without scrolling the buffer. Example:
`→ committed to master (abc1234)`

**Git single-command.** Do `git add . && git commit -m '...'` in one bash
call — no separate add, no waiting for confirmation. Keep it tight.

**Search tools.** Use `sg` (ast-grep) for AST-aware structural search over
bare grep. Use `rg` (ripgrep) for regex/filename search. Skip plain grep.

**Skills tight.** When loading a skill (ast-grep, librarian, etc.), keep it
focused — load the bare minimum, don't dump the entire skill doc into
context unless asked.

**Default branch is `main`**, not `main`.

**Name the state.** I'm on a phone screen inside a tmux pane inside an
AVF VM. Output scrolls past fast. If there's something I need to know
about the current state, say it explicitly — don't make me scroll back.

## The Hardware Reality

| Thing | Spec |
|-------|------|
| Host | Pixel 6a, Android 17 Beta |
| VM | AVF Debian 13 (trixie), aarch64, 1.87 GiB RAM |
| Viewport | ~270×518 effective (keyboard + tmux chrome eats half) |
| Disk | 103 GiB virtual, host-limited — keep builds lean |

No, this isn't a remote server. Yes, it works. The RAM is the binding
constraint — no local LLMs, but pi + ast-grep + tsc runs fine.

## What This Project Is

`pi-bake` is a pi extension for autonomous phase execution. It runs a
pipeline: executor → structural audit (ast-grep) → semantic audit (LLM) →
remediation → repeat/circuit-breaker. The phase files are spec-driven,
decomposed from raw specs, and each phase is a focused, verifiable unit.

The meta-point: proving that open-weight models (DeepSeek, et al.) are
production-ready for agentic coding loops right now, not tomorrow. Every
commit should move that needle.

## The Ethos

- **Share the last mile.** If someone's stuck and you've solved it, help
  them. Don't gatekeep. Community beats competition.
- **Playful names, serious code.** errplay, cdp-ninja, dsandsl, fuzzlok,
  t-5000, ghettobird — the name makes you smile, the code does the work.
- **Spec-driven development.** Clear objectives + done-when criteria.
  Decompose big problems into focused phases. Verify deterministically
  (ast-grep) before semantically (LLM).
- **No moat.** Frontier labs don't have one. Open weight models are ready.
  Build accordingly.
