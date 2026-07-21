Now I have all the information needed. Here is the complete review.

---

## Review

### 1. Dead code removed — orphaned references

- **`closeLoader` / `loaderMsg`**: These fields were removed from `bakeCtx` in `commands/ctx.ts`. Zero remaining references in any `.ts` source file. I verified all command files (`index.ts`, `resume.ts`, `pause.ts`, `retry.ts`, `reset.ts`, `rules.ts`, `spec-decompose.ts`, `start.ts`, `steer.ts`, `log.ts`, `skip.ts`, `detail.ts`, `doctor.ts`, `config.ts`, `status.ts`, `widget.ts`) — none reference `closeLoader` or `loaderMsg`. ✅ Clean.

- **`showLoaderOverlay`**: Import removed from `commands/start.ts` and `commands/spec-decompose.ts`. The source module `lib/overlay.ts` is now entirely orphaned (see below).

- **`WHITE_FG`**: Removed from `components/overlay.ts`. Zero remaining references in any `.ts` file. ✅ Clean.

- **`abort` paths in spec-decompose**: The `aborted` flag, escape-to-abort callback, and `bake?.abort()` call were removed from `spec-decompose.ts`. The `Bake.abort()` method still exists in `bake.ts:454` and `RpcAgent.abort()` at `rpc-agent.ts:323` — these are still used internally (e.g., for timeout handling in `rpc-agent.ts`), but they are no longer wired to any user-facing abort UI for decompose or start. **Note**: This means there is no longer a way for the user to abort a running decompose or start operation via the TUI — this is a minor UX regression introduced deliberately (the pipeline runs in the background now).

### 2. `commands/ctx.ts` — field removal verification

`closeLoader` and `loaderMsg` were removed from `bakeCtx`'s type definition. I verified all files listed in the question:

- **`commands/index.ts`**: No references to `closeLoader` or `loaderMsg`. ✅
- **`commands/resume.ts`**: No references. ✅
- **`commands/pause.ts`**: No references. ✅
- **`commands/retry.ts`**: No references. ✅
- **`commands/reset.ts`**: No references. ✅

### 3. Orphaned files — `lib/overlay.ts` and `components/loader.ts`

**Both files are now orphaned dead code and should be deleted.**

- `lib/overlay.ts` exports `showLoaderOverlay` and `LoaderOverlay` — **imported by zero files**.
- `components/loader.ts` exports `LoaderComponent` — only imported by `lib/overlay.ts` (which is itself orphaned).
- No command or module imports from either file.

**Deletion recommendation**: Delete both files. The loader overlay pattern has been replaced by `setStatus()` + `notify()` + working indicator callbacks. If the pattern is ever needed again, it can be reconstructed from git history. Keeping orphaned files creates confusion and dead-weight in the module graph.

**Severity**: Medium (maintainability — may cause confusion for new contributors).

### 4. Biome auto-formatting — semantic changes interleaved

The diff mixes Biome auto-formatting with semantic changes in these files:

| File | Formatting-only lines | Semantic lines |
|---|---|---|
| `commands/detail.ts` | ~95% (parameter wrapping, ternaries, catch blocks) | Description change only |
| `commands/doctor.ts` | ~90% (parameter wrapping, object literals) | `t.fg("bold",...)` → `t.bold(...)` |
| `commands/rules.ts` | ~85% (parameter wrapping) | Added `bakeCtx` import (was missing), indentation fix |
| `commands/skip.ts` | ~70% (parameter wrapping) | `done(v)` → `done(v.value)`, arg parsing fix, variable hoisting |
| `bake-machine.ts` | ~90% (parameter wrapping) | Null-safe `phaseSpecs.get(phaseId)` check, import corrections |
| `components/overlay.ts` | ~70% (parameter wrapping) | `ThemeProxy` type change, `WHITE_FG` removal, `Theme` import added |
| `lib/phase-writer.ts` | ~90% (nullish coalescing, multi-line) | `||` → `??` for `depends_on` and `plan` |

**Assessment**: The formatting changes are pervasive and make it harder to isolate semantic changes in review. However, separating them post-hoc would be manual and costly. **Worth committing separately in the future**, but not a blocking concern for this diff — the semantic changes are correct.

### 5. `components/overlay.ts` — `ThemeProxy` type precision

Old:
```ts
export type ThemeProxy = {
    fg: (variant: string, text: string) => string;
    bg: (variant: string, text: string) => string;
};
```

New:
```ts
import type { Theme } from "@earendil-works/pi-coding-agent";
export type ThemeProxy = Pick<Theme, "fg" | "bg">;
```

**This is strictly more precise** — it picks the exact overloaded signatures from the `Theme` class rather than a hand-rolled approximation.

**Risk assessment**: I searched all files that use `ThemeProxy`:
- `index.ts` imports `type ThemeProxy` and aliases it as `AnimTheme`, then accepts a `Theme` instance via the widget factory callback. ✅
- `components/overlay.ts` uses it in `scannerTaper`, `taperTitle`, and `Overlay` constructor — all called with `theme` instances. ✅

No code constructs a `ThemeProxy` manually anywhere — it is only used as a type annotation for `Theme` instances. **Zero breakage risk.** 🎉

### 6. `index.ts` — callback simplification

**`onLoader` handler** (line ~247):
Old: 6 lines (set status, close loader overlay on `!show`)
New: 2 lines (set status only)

This is adequate because the loader overlay was removed entirely. Status feedback still reaches the user via `setStatus`. The `_show` parameter is intentionally ignored — there's nothing to hide/show anymore. ✅

**`onStateChange` handler** (line ~231):
Old: had a block that called `bakeCtx.closeLoader()` on terminal states
New: removed that block

This is correct — there's no loader overlay to close. The status is still set to `"⏎ bake ready"` and working indicator is cleared on terminal states. **Adequate feedback.** ✅

**Concern**: The `onLoader` handler is the sole path for pipeline-loader status messages to reach the user. If the pipeline emits `onLoader(false, msg)` to clear, the message sticks as the last status. Previously, the `!show` branch would close the overlay AND (in `onStateChange`) transition to `"⏎ bake ready"`. Now `onLoader(false, ...)` just sets the last message as status, and `onStateChange` terminal transitions overwrite it. This is fine — the sequence is: `onLoader(false, "done")` → `onStateChange(done)` → `setStatus("⏎ bake ready")`. No regression. ✅

### 7. Unused or newly-needed imports

- **`bake-machine.ts`**: Still imports `type ExecutorDeps` on line 52 — but `ExecutorDeps` is **not used** anywhere in the file. This is a pre-existing unused import (not introduced by this diff). Weak opportunity to remove it.

- **`commands/rules.ts`**: Added `bakeCtx` to imports — this was a **bug fix**. The old code used `bakeCtx.widgetHidden` and `bakeCtx.requestWidgetRender` without importing `bakeCtx` from `ctx.ts`. The old import only had `RULES_DIR, RULES_STATE_FILE, loadRulesState, saveRulesState, getRuleFiles`. The new import correctly adds `bakeCtx`.

- **`components/overlay.ts`**: Added `import type { Theme } from "@earendil-works/pi-coding-agent"` — necessary for the `Pick<Theme, "fg" | "bg">` type. ✅

- **`bake-machine.ts`**: Changed `AuditFinding` import from `./bake.ts` to `./auditor.ts` — this is correct since `AuditFinding` is defined in `auditor.ts`, not `bake.ts`. ✅

- **No new unused imports detected in the diff.** Each import is used.

### Additional observations

1. **`commands/skip.ts` semantic fix for SelectList**: `list.onSelect = (v) => done(v)` → `list.onSelect = (v) => done(v.value)`. The old code passed the whole item object (with `value`, `label`, `description`) to the `done` callback, and then `bake.skipPhase(selected)` would receive an object instead of a string. The new code correctly extracts `.value`. **Important bug fix.**

2. **`commands/skip.ts` arg parsing simplification**: The old code had complex type-checking (`typeof args === "string" ? args : String(args._?.[0] || args[0] || "")`). The new code uses `String(args).trim()` — simpler and correct since `args` is always a string when passed via the pi command system.

3. **`commands/start.ts` fire-and-forget pattern**: The pipeline is now launched without `await`. This is intentional — the handler returns immediately so the TUI stays responsive. Error handling is via `.catch()`. The `onStateChange`/`onStatus`/`onLoader` callbacks handle status updates. This is a significant architectural improvement.

4. **`rpc-agent.ts`**: `cb.resolve()` → `cb.resolve(undefined)` — satisfies TypeScript strict type checking for `PromiseConstructor.resolve`. ✅

5. **`.bake/spec-context.md`**: Full replacement of the spec context (12 phase files deleted, context rewritten). This is the result of running `bake-spec-decompose` — it regenerated the spec from a new raw spec. Not a code concern, but the diff noise is worth noting.

---

## Acceptance Report