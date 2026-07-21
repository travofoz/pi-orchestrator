# Task for reviewer

[Read from: /home/travofoz/pi-bake/plan.md, /home/travofoz/pi-bake/progress.md]

Review ALL changes in this pi-bake repo diff for **maintainability, dead code, and simplification**. Focus on:

1. Dead code removed: `closeLoader`, `loaderMsg`, `showLoaderOverlay`, `WHITE_FG`, abort paths in spec-decompose. Are there any remaining references to these in files NOT in this diff that are now orphaned?

2. `commands/ctx.ts`: `closeLoader` and `loaderMsg` fields removed. Check `commands/index.ts`, `commands/resume.ts`, `commands/pause.ts`, `commands/retry.ts`, `commands/reset.ts` for any lingering references to `closeLoader` or `loaderMsg`.

3. The overlay removal means `lib/overlay.ts` and `components/loader.ts` are now dead code. Should they be deleted, or are they potentially useful for future features? Check if anything still imports them.

4. Biome auto-formatting reformatted many files (detail.ts, doctor.ts, rules.ts, etc.). Are there any formatting-only changes that obscure the semantic changes? Is it worth committing formatting separately?

5. `components/overlay.ts`: `Picker<Theme, 'fg' | 'bg'>` — this is more precise than the old hand-rolled type. Is there any other code that constructs or uses ThemeProxy directly (not by passing Theme) that might break?

6. `index.ts`: `onLoader` handler simplified from 6 lines to 2. `onStateChange` lost the `closeLoader` block. Verify these callbacks still provide adequate status feedback during pipeline execution.

7. Any imports added but not used, or old imports that should be removed?

Read the actual files to verify. Do NOT edit anything. Report maintainability concerns, orphaned code, simplification opportunities, and optional observations.

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