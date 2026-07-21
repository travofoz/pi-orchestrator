All files have been verified. Here is the full analysis.

---

## Review

### 1. `components/overlay.ts` — ThemeProxy: `Pick<Theme, "fg" | "bg">`

**Correct — no mismatches found.**

The old `ThemeProxy` was `{ fg: (variant: string, text: string) => string; bg: (variant: string, text: string) => string }` — loose, any string for variant. The new `Pick<Theme, "fg" | "bg">` is stricter: `Theme.fg` demands a `ThemeColor` literal, `Theme.bg` demands a `ThemeBg` literal.

Every consumer passes a full `Theme` instance (from `ui.custom(tui, theme, _kb, done)` or `setWidget(tui, theme)` where `theme: Theme`). Since `Theme` has both `fg` and `bg`, the structural match to `Pick<Theme, "fg" | "bg">` is exact. Files checked:

| File | Passes Theme to? | Calls `theme.fg()` with valid ThemeColor? |
|---|---|---|
| `index.ts` | `new BakeWidget(theme)` | `"success"`, `"accent"`, `"dim"`, `"warning"`, `"error"`, `"muted"` ✓ |
| `commands/config.ts` | `new Overlay(theme, ...)` | `"text"`, `"accent"`, `"muted"`, `"dim"` ✓ |
| `commands/detail.ts` | `new Overlay(theme, ...)` | `"accent"`, `"toolTitle"`, `"dim"`, `"muted"`, `"success"`, `"warning"`, `"error"` ✓ |
| `commands/reset.ts` | `new Overlay(theme, ...)` | `"warning"`, `"text"`, `"muted"` ✓ |
| `commands/rules.ts` | `new Overlay(theme, ...)` | `"text"`, `"accent"`, `"muted"`, `"dim"` ✓ |
| `commands/skip.ts` | `new Overlay(theme, ...)` | `"warning"`, `"text"`, `"muted"`, `"dim"`, `"error"` ✓ |

**Note:** `taperTitle()` in `overlay.ts` still takes a standalone `fg: (v: string, t: string) => string` parameter — not the full `ThemeProxy`. This is dead code (exported, never imported elsewhere), but its looser type is intentional and not a bug.

---

### 2. `lib/phase-writer.ts` — `?? []` narrowing

**Correct.** 

In `writePhaseFiles`:
- `const depsArr = phase.depends_on ?? []` — `phase.depends_on` is `string[] | undefined`, after `?? []` the type is `string[]`. Then `depsArr.length`, `depsArr.join(", ")` work on `string[]`. ✓
- `const planArr = phase.plan ?? []` — `phase.plan` is `string[] | undefined`, narrowed to `string[]`. The `.map((s: string) => ...)` call on the next line operates on `string[]`. ✓

In `writeDagManifest`:
- `depends_on: p.depends_on ?? []` — `DagEntry.depends_on` expects `string[]`, `p.depends_on` is `string[] | undefined`, `?? []` resolves to `string[]`. ✓

No consumer ever sees `string[] | undefined`.

---

### 3. `commands/doctor.ts` — `t.fg("bold", ...)` → `t.bold(...)`

**Correct, and fixes a pre-existing type error.**

The old call `t.fg("bold", t.fg("toolTitle", "Bake Doctor Diagnosis"))` used `"bold"` as a first argument to `Theme.fg()`. Looking at the `ThemeColor` type, `"bold"` is **not** a valid `ThemeColor` literal. So the old code was actually a type error. The new code `t.bold(t.fg("toolTitle", "Bake Doctor Diagnosis"))` correctly delegates bold rendering to `Theme.bold()`.

All other `t.fg()` calls in the file use valid ThemeColor literals:
- `t.fg("toolTitle", ...)` ✓
- `t.fg("dim", ...)` ✓
- `t.fg("success", ...)` ✓
- `t.fg("error", ...)` ✓
- `t.fg("text", ...)` ✓
- `t.fg("warning", ...)` ✓

---

### 4. `commands/skip.ts` — `String(args).trim()`

**Correct — no type issue.**

The `RegisteredCommand.handler` signature is `(args: string, ctx: ExtensionCommandContext) => Promise<void>`, so `args` is typed `string`.

- `String(args)` on a `string` is a no-op identity coercion — redundant but not incorrect.
- `args.trim()` would work directly, but the old defensive code (`typeof args === "string" ? args : String(args._?.[0] || args[0] || "")`) suggests runtime edge cases where pi might pass non-string values. `String(args).trim()` is a reasonable belt-and-suspenders approach for those edge cases.

**Note:** Not a bug. The `String(...)` wrapper adds runtime safety at no type-safety cost. The old pattern `typeof args === "string"` check is gone, but the simpler `String(args)` still handles non-string runtime values gracefully (coercing to string rather than crashing).

---

### 5. `commands/rules.ts` — `bakeCtx` now imported

**Correct.**

`bakeCtx` is imported from `./ctx.ts` (line 15–20):
```ts
import {
    bakeCtx,
    RULES_DIR,
    RULES_STATE_FILE,
    loadRulesState,
    saveRulesState,
    getRuleFiles,
} from "./ctx.ts";
```

... and used (line 60, 82–83):
```ts
bakeCtx.widgetHidden = true;
// ...
bakeCtx.widgetHidden = false;
bakeCtx.requestWidgetRender?.();
```

All imported symbols are verified exports from `commands/ctx.ts`. ✓

---

### 6. `commands/log.ts`, `commands/steer.ts`, `commands/skip.ts` — `usage` field removed

**Correct.**

`registerCommand` accepts `Omit<RegisteredCommand, "name" | "sourceInfo">` which permits only:
- `description?: string`
- `getArgumentCompletions?: (...) => ...`
- `handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>`

All three files now pass only `description` and `handler`:

| File | Fields | Valid? |
|---|---|---|
| `commands/log.ts` | `description`, `handler` | ✓ |
| `commands/steer.ts` | `description`, `handler` | ✓ |
| `commands/skip.ts` | `description`, `handler` | ✓ |

No `usage` field remains in any of the 17 command files. ✓

Some commands (log, steer, skip, spec-decompose) embed usage guidance directly into the `description` string — this is a valid design choice, not a type issue.

---

### 7. `commands/detail.ts` — `ov!` assertions

**Sound — `ov` is always assigned before callback invocation.**

The flow:
1. `let ov: Overlay | null = null;` — declaration
2. `ov = makeOv(scrollOffset);` — synchronous assignment (line after `makeOv` definition)
3. Returned object `{ render: () => ov!.render(w), invalidate: () => ov!.invalidate(), dispose: () => ov!.dispose(), ... }` — returned to `ui.custom()`

Since step 2 runs synchronously before the return in step 3, `ov` is non-null by the time any callback can fire. The `rebuild()` closure also reassigns `ov` synchronously before `tui.requestRender()` triggers another render cycle.

Similarly, `bake!` (line ~363) is sound because `const bake = bakeCtx.bake; if (!bake) return;` at the top of the handler guarantees non-null.

**Note:** `buildBody()` accepts `theme: any` (explicit `any` type on the parameter). This means `theme.fg(...)` and `theme.bold(...)` calls inside `buildBody()` are unchecked by TypeScript. This is pre-existing (not introduced by the diff) and the actual runtime value is always a `Theme` instance, but it would be safer to type this as `Theme`.

---

### No blockers found. All 7 checklist items pass inspection.