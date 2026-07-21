Here is my complete review.

---

## Review

### 1. `commands/start.ts` — fire-and-forget pipeline

**Blocker: The running guard is ineffective.** The guard checks `bake.stateSnapshot.status === "running"`, but `Bake.runPipeline()` never sets `state.status` to `"running"`. Only `Bake.resume()` does. So on every call to `bake-start`, the guard passes, and multiple concurrent pipeline runs can be launched. Two concurrent `runPipeline()` calls each call `rpcAgent.start()` (idempotent), create separate XState actors, share the same event log and RPC agent — causing races on file I/O and RPC sessions.

**Evidence:** `grep -n '\.status\s*=\s*"running"' bake.ts` returns only line 316, which is inside `resume()`. The `runPipeline()` method (lines 333–391) never sets status to `"running"`.

**Fixed if:** `runPipeline()` sets `this.state.status = "running"` at the top (similar to `resume()`), and the guard then works.

**.catch() handler:** Correctly reports via `notify` + `setStatus`. If a pipeline-internal error propagates (the `try/finally` in `runPipeline()` does not catch), the `.catch()` consumes it. A minor concern: if the rejection value is not an `Error` object, `err.message` would be `undefined`, producing an unhelpful message like `"Pipeline failed: undefined"`. This is unlikely but worth hardening.

### 2. `commands/spec-decompose.ts` and `commands/start.ts` — removed `showLoaderOverlay`

**Acceptable for decompose.** The old loader overlay provided animated feedback plus escape-to-abort. The new code uses `cmdCtx.ui.setStatus` + `cmdCtx.ui.notify`, which produce visible status-line and notification feedback. Decompose is a single LLM call — the loss of abort is minor.

**No regression in feedback:** The old overlay's `onAbort` called `bake.abort()` (which aborts the RPC agent). The new decompose has no abort path, but since the handler is `await`ed (not fire-and-forget), the user waits at most a couple of minutes. Acceptable tradeoff.

**`bakeCtx.loaderMsg` / `bakeCtx.closeLoader`:** These where removed from the mutable context. The old `index.ts` `onLoader` callback also no longer references them. Clean removal — no dangling dead code.

### 3. `bake-machine.ts` — `isReady()` phantom dependencies

**Not a blocker, but a design risk.** The `isReady` logic:
```ts
return p.dependsOn.every(
    (d) => !phaseSpecs.has(d) || completedMap[d] || skipped.has(d),
);
```

If a phase's `dependsOn` references a phase ID not present in `phaseSpecs`, that dependency is silently treated as met (`!phaseSpecs.has(d)` is `true`). This tolerates stale `dag.json` entries **but can cause phases to run out-of-order** if:
- A phase is deleted from disk but its ID remains in another phase's `dependsOn`.
- A `dag.json` is manually edited with a typo in a dependency name.

The defensive `if (!p) return false` at the top prevents starting a phase with no spec at all. The comment explicitly documents this choice. Acceptable but worth documenting for users.

### 4. `rpc-agent.ts` — `cb.resolve(undefined)` vs `cb.resolve()`

**No regression.** The settled promise is typed as `Promise<void>`. Calling `resolve(undefined)` is functionally identical to `resolve()` — the awaited value is `undefined` either way. Nothing downstream reads the settled value. This change is harmless.

### 5. `commands/skip.ts` — `SelectItem` fix

**This is a fix, not a regression.** The old code:
- Passed the entire `SelectItem` object `{ value, label, description }` to `done(v)`, so `selected` was an object.
- Declared `const selected` inside the `try` block but referenced it outside — a TypeScript scoping error (would not compile).

The new code:
- Uses `done(v.value)` to pass just the string phase name.
- Declares `let selected: string | null = null` before the `try`, scoping it correctly.

Both changes fix real bugs. Downstream `bake.skipPhase(selected)` expects a string, and `t.fg("warning", ...)` was passed an object before. **This is correct.**

### 6. `commands/detail.ts` — `ov!` non-null assertions

**Safe.** The overlay variable `ov` is initialized synchronously before the return statement:
```ts
ov = makeOv(scrollOffset);
// ...
return {
    render: (w: number) => ov!.render(w),
    invalidate: () => ov!.invalidate(),
    dispose: () => ov!.dispose(),
};
```

`makeOv` always returns a new `Overlay` instance. By the time the TUI calls `render`, `invalidate`, or `dispose`, `ov` is guaranteed non-null. The `!` assertions are correct.

### 7. Race conditions from parallel async operations

Beyond the **blocker** in item 1 (concurrent pipelines), there are minor race surfaces:

- **`generateReadme` fire-and-forget vs pipeline:** After `spec-decompose` completes, `generateReadme(...)` calls `bake.runPrompt()` which uses the RPC agent. If the user immediately starts a pipeline (via `bake-start`), the pipeline also uses the RPC agent. They'd compete for `newSession()` and `prompt()` calls. The README has its own `.catch()` so it won't crash, but the RPC agent session could be disrupted. This is unchanged from the old code (README was always fire-and-forget).

- **`skipPhase` and `retryAttempt` both call `rpcAgent.abort()`:** If a user presses `s` in the detail overlay while a pipeline is running, `skipPhase()` aborts the RPC agent mid-prompt. The pipeline's XState actor will see the rejected promise and handle it (it has `onError` handlers). This is intentional behavior — the abort provides fast feedback.

- **`bake-start` after `bake-resume`:** If `bake-resume` sets status to `"running"` and then calls `await this.runPipeline()`, calling `bake-start` while resume's pipeline is running would be blocked by the guard (since status is `"running"`). But the guard is ineffective for the direct `bake-start` path as noted above.

---

## Acceptance Report