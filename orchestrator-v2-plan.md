# Orchestrator V2 — Architecture & Implementation Plan

## The Problem

The current orchestrator.cjs converges too slowly (or not at all) because its BASELINE_REVIEW sub-audit is an open-ended code review prompt that can always find something new in any real codebase. Combined with a dissent-only failure model (any 1 of N samples says ISSUES → sub-audit fails), the pipeline is guaranteed to eventually hit the circuit breaker.

Three root causes:
1. **Open-ended audit** — always finds new issues, never converges
2. **No remediation verification** — executor can skip tasks without detection
3. **No state tracking** — each cycle is blind to what was previously fixed

## The Fix (validated by testing)

### 1. ast-grep for structural checks (deterministic, ~50ms)
Replace the open-ended BASELINE_REVIEW with a hybrid:

- **ast-grep rules** catch structural issues deterministically
  - Dead ternary: `sg run -l js -p '$X ? $A : $A'`
  - console.log: `sg run -l js -p 'console.log($$$)'`
  - Hardcoded branch names: `sg run -l js -p '"main"'`
  - Sync URL.revokeObjectURL after click: `sg scan -r rules/no-sync-revoke.yml`
  - Missing onDestroy import: structural scan
  - Plus project-specific rules

- **Structured LLM audit** catches semantic issues the model can't
  - 8-12 item finite checklist
  - Machine-parseable output: `PASS/FAIL` lines + `RESULT: PASS/ISSUES` + JSON failures block
  - Tested across 3 independent samples — format holds consistently

### 2. Remediation verification (deterministic)
After executor runs, before re-auditing:
1. Parse previous audit's failures JSON
2. Check each against git diff (structural: was the file modified?) or re-run ast-grep rule
3. If any task was skipped → re-run executor, don't waste tokens on a fresh audit

### 3. JSON-lines event log (zero dependencies)
`.orchestrator/events.jsonl` — append-only, grep-able, jq-parseable:
```json
{"ts":"2026-07-13T10:00:00Z","type":"phase_start","data":{"phase":"1_spec"}}
{"ts":"2026-07-13T10:00:01Z","type":"audit_sub","data":{"sub":"STRUCTURAL","result":"PASS"}}
{"ts":"2026-07-13T10:00:30Z","type":"audit_sub","data":{"sub":"SEMANTIC","result":"ISSUES","failures":[...]}}
{"ts":"2026-07-13T10:01:00Z","type":"remediation","data":{"attempt":1,"tasks":[...]}}
```

## The Architecture

### Component: pi Extension

The orchestrator runs as a pi extension with:

**Widget** (always visible above editor):
```
┌─ Phase 1/4: build spec ─────────────────────
│ Attempt 2/3  │  STRUCTURAL   ✅   ast-grep   
│               │  SEMANTIC     ⏳   LLM       
│ Tokens: 12.4K │  Elapsed: 14m              
└──────────────────────────────────────────────
```

**Custom tools:**
| Tool | Purpose |
|------|---------|
| `/orchestrator-status` | Full status + last N events |
| `/orchestrator-pause` | Pause after current attempt |
| `/orchestrator-resume` | Continue from pause |
| `/orchestrator-skip-phase` | Skip current phase, move to next |
| `/orchestrator-retry-attempt` | Re-run executor for current attempt |
| `/orchestrator-steer <msg>` | Inject guidance into next executor run |
| `/orchestrator-spec-decompose <path>` | Decompose raw spec into phase files |
| `/orchestrator-log [n]` | Show last N events as overlay |
| `/orchestrator-metrics` | Token counts, turns, cache hit rate |
| `/orchestrator-approve <finding-id>` | Acknowledge a false positive |
| `/orchestrator-override verdict=pass` | Force-pass a stuck phase |
| `/orchestrator-checklist-add <rule>` | Add project-specific ast-grep rule |

**Footer status:**
```
● Phase 2/4 • Attempt 1/3 • 14m elapsed
```

### Component: Core Loop

```
orchestrator.run():
  1. Load phase from future_phases/
  2. Run executor (pi with phase spec + remediation history)
  3. Run structural check:
     - ast-grep scan against base rules + project rules
     - If FAIL → skip semantic check, fast-fail to remediation
  4. Run semantic check (if structural passed):
     - LLM with 8-12 item structured checklist
     - Parse PASS/FAIL + JSON failures
  5. If both PASS → archive phase, advance
  6. If FAIL → remediation verification:
     - Check git diff against previous failures JSON
     - If tasks were skipped → re-run executor (no re-audit)
     - If tasks were done but still fail → generate remediation spec
     - Max 3 attempts → circuit breaker
  7. Log everything to events.jsonl
```

### Component: Filesystem Layout

```
orchestrator/
├── extension.ts              # pi extension entry point
├── orchestrator.ts            # Core loop logic
├── auditor.ts                 # ast-grep + LLM audit
├── executor.ts                # Phase execution
├── remediator.ts             # Remediation spec generation
├── event-log.ts              # JSON-lines event log
├── rules/                     # ast-grep rule files
│   ├── base/                  # Stack-agnostic rules
│   │   ├── no-dead-ternary.yml
│   │   ├── no-console-log.yml
│   │   ├── no-hardcoded-branch.yml
│   │   └── no-sync-revoke.yml
│   └── project/               # Per-project rules (user-extensible)
├── phases/                    # Phase spec files
│   └── <phase-name>.md
├── workspace/                 # The project being built (git subdir)
│   ├── src/
│   ├── package.json
│   └── .git/
└── .orchestrator/             # Runtime data (gitignored)
    ├── events.jsonl
    └── state.json             # Crash recovery state
```

### Component: ast-grep Rules (Base Set)

Stack-agnostic, shipped with the orchestrator:

| Rule | Pattern | Severity |
|------|---------|----------|
| Dead ternary | `$X ? $A : $A` | error |
| Console log | `console.log($$$)` | error |
| Hardcoded branch | `"main"` or `"master"` not in export | error |
| Sync blob revoke | `URL.revokeObjectURL($URL)` after `a.click()` | error |
| Debugger statement | `debugger` | error |
| Todo/fixme | `TODO` or `FIXME` in comments | warning |
| Empty catch | `catch($$$) {}` | error |
| Swallowed promise | `.catch($$$)` with empty body | warning |

Plus per-project rules loaded from `rules/project/`.

### ast-grep Rules: Language-Specific Add-Ons

Detected from project files (`package.json`, `Cargo.toml`, `go.mod`, etc.):

| Language | Rule | Pattern |
|----------|------|---------|
| TypeScript | No `any` type | `: any` |
| Go | No `log.Fatal` in lib | `log.Fatal($$$)` |
| Rust | No `unwrap()` in lib | `.unwrap()` |
| Python | No `except: pass` | `except:\n    pass` |

## Implementation Phases

### Phase 1 — Core Loop + ast-grep (proof the fix works)
- Port orchestrator.cjs logic to extension TypeScript
- ast-grep integration for structural checks
- Structured LLM audit for semantic checks  
- JSON-lines event logging
- Widget showing current phase/attempt status

### Phase 2 — Custom Tools
- pause/resume/skip/steer
- retry-attempt
- spec-decompose
- log viewer overlay

### Phase 3 — Metrics & polish
- Token/turn tracking from pi stderr
- Cache hit/miss visibility
- Cumulative project metrics
- ast-grep rule management (checklist-add)

### Phase 4 — Advanced
- Spec decomposition tool (raw spec → clean phase files)
- Multi-workspace support (workspace/frontend, workspace/backend)
- Event replay for debugging past sessions

## Design Decisions Made

1. **Event log: JSON-lines over NATS JetStream.** Zero dependencies, grep-able, easy to parse. Can upgrade to NATS later if distributed agents become necessary.

2. **Extension over standalone TUI.** Pi's existing TUI provides the container. We add a widget, custom tools, and a status line. No separate binary, no screen/tmux management.

3. **ast-grep + LLM hybrid.** Structural checks are deterministic and instant. LLM only handles semantic checks that require understanding. This combination converges because ast-grep rules prevent regression.

4. **No polling.** In-process SDK calls (`session.prompt()`) are async/await — no `inotifywait` or sleep loops needed.

5. **Workspace as subdirectory.** `.orchestrator/workspace/` contains the target project. Clean filesystem separation, easy to clone the orchestrator template fresh.

6. **Single-user architecture.** No multi-tenant concerns. Config from env vars, not setup wizards. Speed of iteration prioritized over polish.

## Open Questions

1. **Sub-agent model for audits** — Should each structured audit check be a separate sub-agent call, or one call with all checks? Trade-off: parallelism vs. context overhead.

2. **Spec decomposition format** — What's the canonical phase spec format? Minimum required fields? How does the orchestrator validate a spec is well-formed?

3. **Multi-workspace monorepo handling** — When a frontend and backend live in the same repo but need separate workspace views. Current thinking: workspace/ is the repo root, phases reference subdirectories.
