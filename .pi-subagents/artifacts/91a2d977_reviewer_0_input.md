# Task for reviewer

[Read from: /home/travofoz/pi-bake/plan.md, /home/travofoz/pi-bake/progress.md]

Review ALL changes in this pi-bake repo diff for **correctness and regressions**. Focus on:

1. `commands/start.ts`: pipeline is now fire-and-forget (background promise). Does the `.catch()` handler correctly report errors? Is there any risk of overlapping pipeline runs (guard checks `status === "running"`)? Is there a missing `abort()` mechanism from the old overlay?

2. `commands/spec-decompose.ts` and `commands/start.ts`: removed `showLoaderOverlay` entirely. Does `cmdCtx.ui.notify` + `setStatus` produce visible feedback? Is the abort path removed acceptable for decompose (single LLM call, shorter)?

3. `bake-machine.ts`: `isReady()` now guards against missing phase IDs with `if (!p) return false` and treats missing dependencies as met. Could a stale DAG with phantom deps cause phases to run out-of-order? Can `isReady` return true for a phase whose dependency was never a phase file?

4. `rpc-agent.ts`: `cb.resolve()` → `cb.resolve(undefined)`. Does anything consuming the settled promise depend on the resolved value?

5. `commands/skip.ts`: `list.onSelect = (v) => done(v.value)` (was `done(v)` — v was SelectItem object, not string). Did anything downstream expect the SelectItem? The `selected` variable is now declared before the try block — any scoping edge cases?

6. `commands/detail.ts`: `ov!` non-null assertions. Is the overlay always initialized before render/invalidate/dispose are called?

7. Any race condition or ordering issue from running multiple async operations in parallel?

Read the actual files to verify. Do NOT edit anything. Report blockers, things worth fixing now, and optional observations.

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