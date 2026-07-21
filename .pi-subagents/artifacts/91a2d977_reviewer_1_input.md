# Task for reviewer

[Read from: /home/travofoz/pi-bake/plan.md, /home/travofoz/pi-bake/progress.md]

Review ALL changes in this pi-bake repo diff for **type safety and null/undefined correctness**. Focus on:

1. `components/overlay.ts`: `ThemeProxy` changed from `{ fg: (string,string)=>string; bg: (string,string)=>string }` to `Pick<Theme, 'fg' | 'bg'>`. Verify every consumer that passes a Theme instance to something typed ThemeProxy now compiles cleanly. Check `index.ts`, `commands/config.ts`, `commands/detail.ts`, `commands/reset.ts`, `commands/skip.ts`, `commands/rules.ts` for any remaining ThemeProxy mismatches.

2. `lib/phase-writer.ts`: `depends_on ?? []` and `plan ?? []` extracted to local vars. Verify narrowest possible type, and that consumers of `depsArr`/`planArr` get `string[]` not `string[] | undefined`.

3. `commands/doctor.ts`: `t.fg("bold", ...)` → `t.bold(...)`. Confirm all other `.fg(...)` calls in the file use valid ThemeColor literals.

4. `commands/skip.ts`: `String(args).trim()` — args is typed as `string` from RegisteredCommand handler. Is `String(args)` redundant? Does `args.trim()` work? Check the handler signature.

5. `commands/rules.ts`: `bakeCtx` was missing — verify it's now imported and used correctly.

6. `commands/log.ts`, `commands/steer.ts`, `commands/skip.ts`: `usage` field removed. Does `Omit<RegisteredCommand, 'name' | 'sourceInfo'>` accept the remaining fields? Verify no other invalid fields remain.

7. `commands/detail.ts`: `ov!` assertions — verify with TypeScript that `ov` is definitely assigned before those callbacks can fire.

Read the actual files to verify. Do NOT edit anything. Report type safety issues, correctness concerns, and optional observations.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```