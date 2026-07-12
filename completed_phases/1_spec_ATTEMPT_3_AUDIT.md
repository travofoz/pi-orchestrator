Critic found issues in one or more sub-audits:

## BASELINE_REVIEW

### BASELINE_REVIEW — sample 1/2

Now I have a complete picture of the codebase. Here is my full review.

---

## Code Review: Emmy

### Environment / Platform Correctness

**No Node.js globals found.** All files use only browser APIs: `fetch`, `document.createElement`, `canvas`, `Blob`, `FileReader`, `URL.createObjectURL`, `atob`/`btoa`, `TextEncoder`/`TextDecoder`, `localStorage`, `Image`, `PointerEvent`, etc. No `Buffer`, `process`, `require`, `__dirname`, `__filename`, or `fs` references exist. With `ssr = false` and `prerender` selectively applied, the static SPA setup is consistent. ✅

---

### Hardcoded Values

- **Branch names**: resolved dynamically via `getDefaultBranch()` everywhere — no hardcoded `"main"` or `"master"`. ✅
- **GitHub URLs**: constructed from dynamic `owner`/`repo`/`branch` values. The only static URL is the deep-link to GitHub's token creation page (`github.com/settings/tokens/new?scopes=repo&description=Emmy`) — intentional. ✅
- **GIF tags**: now user-editable via an `<input>` (fixed in Remediation 1). ✅

---

### Security Basics

- **PAT in localStorage**: documented tradeoff in the connect modal with plain-language warning. Single-user tool, acceptable.
- **CORS**: no server-side CORS config (static site). `raw.githubusercontent.com` serves with CORS headers. ✅
- **XSS via `{@html}`**: `renderShapeSVG` in `annotations.js` uses `escapeAttr()` and `escapeXML()` which escape `&`, `"`, `'`, `<`, `>` for attribute values and text content. Numeric coordinates are coerced to numbers. This covers the main injection vectors. ✅
- **`viewBox` injection**: `viewBox="0 0 {entry.width} {entry.height}"` interpolates from JSON metadata (user-controlled in a single-user tool). No cross-user risk given the single-tenant design.
- **No secrets in client code**: PAT comes from user input at runtime, never baked into the bundle. ✅

---

### Framework Footguns

- **Buttons without `type` inside `<form>`**: no `<form>` elements exist anywhere in the Svelte templates. All buttons either have `type="button"` or are standalone. ✅
- **Unhandled promise rejections**: all async event handlers (`handleUpload`, `handleDelete`, `handleEditSave`, `saveAnnotations`, `handleExport`, `loadGallery`) have internal `try/catch`. ✅
- **Loading / error states**: present around every async action (spinner, disabled state, error alert). ✅
- **`{#each}` keys**: gallery items keyed by `entry.id`, shapes keyed by `shape.id`. ✅
- **`onDestroy` cleanup**: present for both the `window` event listener in `+layout.svelte` and the `playInterval` in the slideshow page (fixed in Remediation 2). ✅

---

### Issues Found

#### 1. 🐛 **`setInterval` fixed delay breaks per-slide durations in slideshow preview**

**File:** `src/routes/slideshow/+page.svelte`, function `startPlay()` (line ~86)

```javascript
function startPlay() {
    if (slides.length === 0) return;
    isPlaying = true;
    previewIndex = 0;
    playInterval = setInterval(() => {
      const nextIndex = (previewIndex + 1) % slides.length;
      if (nextIndex === 0) stopPlay();
      else previewIndex = nextIndex;
    }, slides[previewIndex]?.delay || defaultDelay);
}
```

`setInterval` evaluates its delay argument **once** at creation time — it captures `slides[0]?.delay` (the first slide's delay, since `previewIndex` was just set to 0). All subsequent slides play at that same fixed interval regardless of their individual `delay` settings.

The UI lets users configure per-slide delays (range slider + per-slide number input), and those delays **are** correctly passed to `gifenc` during export, so they work in the output GIF. But the in-app preview ignores them.

**Fix:** Use recursive `setTimeout` that reads `slides[previewIndex]?.delay` on each tick, or restart `setInterval` with the next slide's delay on every tick.

---

#### 2. 🟡 **Blob URL leak on file re-select in gallery upload**

**File:** `src/routes/+page.svelte`
- `handleFileSelect` (line ~70) — creates `URL.createObjectURL(file)` for preview without revoking any previous blob URL
- The `ondrop` handler (line ~268) — same issue

If a user selects/drops a file, then selects/drops another without clicking Cancel (which triggers `clearUpload()` and revokes the old URL), the previous blob URL is orphaned. The memory is freed on page navigation, but within a session these can accumulate.

**Fix:** In both handlers, call `URL.revokeObjectURL(uploadPreview)` before overwriting it.

---

#### 3. 🟡 **`estimateGifSize` computed twice during GIF export**

**File:** `src/lib/gif-export.js`

- `exportAndCommitGIF` calls `encodeGIF(slides, { scale })` (line ~307), which internally calls `estimateGifSize` to auto-determine scale if none provided.
- Then on line ~310, `exportAndCommitGIF` calls `estimateGifSize` **again** to get `suggestedScale` for metadata dimensions.

When `scale` is provided by the user (always the case from the UI slider), the first call in `encodeGIF` uses it directly (no auto-compute), but the second call in `exportAndCommitGIF` still re-runs the estimation.

**Fix:** Compute dimensions from `encodeGIF`'s return value, or pass the effective scale back from `encodeGIF`, or compute dimensions from the first slide directly rather than re-estimating.

---

#### 4. 🟡 **`scale || autoCompute` uses `||` instead of `??`**

**File:** `src/lib/gif-export.js`, line ~310

```javascript
const effectiveScale = scale || estimateGifSize(slides, 20).suggestedScale;
```

If `scale` is ever explicitly `0` (a valid falsy value), `||` would incorrectly override it with the auto-computed value. Currently unreachable from the UI (slider min = 0.25), but a latent bug.

**Fix:** Use `??` (nullish coalescing): `const effectiveScale = scale ?? estimateGifSize(slides, 20).suggestedScale;`

---

#### 5. 🟡 **Vestigial `e.preventDefault()` in `saveConnect`**

**File:** `src/routes/+layout.svelte`, line ~43

```javascript
function saveConnect(e) {
    e.preventDefault();
    // ...
}
```

Called from `<button type="button" onclick={saveConnect}>`. There is no `<form>` element anywhere in the modal, so `e.preventDefault()` on a `MouseEvent` from a button click is a no-op. Harmless, but indicates the handler was written expecting a `<form>` submission context that was later removed.

**Fix:** Either wrap the modal content in `<form onsubmit={saveConnect}>` and let `e.preventDefault()` serve its purpose, or remove the parameter and the `e.preventDefault()` call.

---

### Remediation 2 Task Status (verification)

Since several Remediation 2 tasks were mentioned as unchecked, I verified them against the current code:

| Task | Status |
|------|--------|
| Pointer Events (touch+mouse dedup) | ✅ **Done** — `onpointerdown`/`onpointermove`/`onpointerup` used throughout |
| Slideshow auth gating | ✅ **Done** — `$effect` guarded by `if ($githubRepo)` without token requirement |
| `strokeWidth` in `arrowHead()` | ✅ **Done** — `headLen = baseLen * (1 + (strokeWidth - 2) * 0.15)` uses the parameter |
| GIF export text rendering | ✅ **Appears aligned** — all three paths fill without stroke, and transparent fill falls back to `strokeColor` |
| Dynamic imports → static | ✅ **Done** — `upload.js` and `gif-export.js` use static `import` for local modules |
| `onDestroy` in slideshow | ✅ **Done** — `onDestroy` clears `playInterval` |
| `getLatestCommitSha` dead code | ✅ **Done** — function no longer exists in `github.js` |
| Deduplicate `arrowHead` in gif-export.js | ❌ **Still open** — `gif-export.js` has its own inline arrowhead calculation with canvas scaling; could share the base geometry from `annotations.js` and apply scaling separately |

---

**RESULT: ISSUES**


### BASELINE_REVIEW — sample 2/2

I've now done a thorough review of every file in `src/`. Let me compile my findings.

---

## Code Review Results

### Issues Found

**1. Connect modal lacks `<form>` — no keyboard submission, dead `preventDefault()` call**

- **File:** `src/routes/+layout.svelte` (lines 94–168)
- **Details:** The connect modal's inputs and buttons are not wrapped in a `<form>` element. The `saveConnect` function calls `e.preventDefault()` (a form-submit idiom), but it's wired to a `<button type="button" onclick={saveConnect}>` — where `preventDefault()` is a no-op.  
  Because there's no `<form>`, pressing Enter inside the repo/token inputs does nothing. Users must click the "Connect" button every time. This is an accessibility and UX issue, and the dead `e.preventDefault()` call suggests the form structure was intended but not completed.

**2. `raw.githubusercontent.com` URL pattern duplicated across four files**

- **Files:**  
  `src/lib/gallery.js:67`  
  `src/lib/upload.js:213`  
  `src/lib/gif-export.js:329`  
  `src/routes/annotate/[id]/+page.svelte:55`
- **Details:** The URL `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/images/${filename}` is hand-assembled in four separate locations. No URL-encoding is applied to the branch name or filename. If a branch ever contained characters like `#` or `?`, the URL would be malformed. A shared utility function (`rawFileUrl(owner, repo, branch, path)`) would centralize and fix this.

**3. `URL.createObjectURL` leak on re-selection/drop without prior revoke**

- **File:** `src/routes/+page.svelte` (drop handler around line 39, `handleFileSelect` around line 52)
- **Details:** When a file is selected or dropped, `uploadPreview = URL.createObjectURL(file)` is called. If a user drops/selects a second file without first calling `clearUpload()` (which revokes the existing URL), the previous object URL leaks until the page is navigated away or reloaded. Minor memory leak, not a correctness issue at single-user scale.

### Everything Else Is Clean

I checked every file for:

| Category | Status |
|---|---|
| **Environment/platform** — no Node-only globals (`Buffer`, `process`, `require`, `__dirname`, `fs`) in `src/` | ✅ Clean — all browser APIs guarded with `typeof` checks where needed |
| **Dynamic imports that should be static** | ✅ Clean — the one remaining `await import('gifenc')` is inside `encodeGIF`, which is a legitimate code-splitting boundary; all local module imports are static |
| **Hardcoded values** (`getLatestCommitSha`, tokens, API keys, branch names) | ✅ Clean — no dead functions; repo/branch/token are all user-supplied or fetched dynamically |
| **XSS in SVG `{@html}`** — `renderShapeSVG` attribute/text escaping | ✅ Clean — `escapeAttr` and `escapeXML` properly sanitize all interpolated content |
| **`<button>` inside `<form>` without `type`** (implicit submit) | ✅ Clean — no `<button>` without `type` lives inside a `<form>` |
| **Unhandled promise rejections** | ✅ Clean — every async function called from a template/reactive context catches its own errors internally |
| **Missing error/loading states** | ✅ Clean — upload, edit, delete, export, annotation save all have error + loading states |
| **Event listener / interval cleanup** | ✅ Clean — `onDestroy` clears the slideshow interval; `$effect` returns cleanup for the `open-connect` listener |
| **PointerEvent unification** (prevents mouse+touch double-fire) | ✅ Clean — already using `onpointerdown/onpointermove/onpointerup` |
| **Text annotation rendering consistency** (SVG vs canvas) | ✅ Clean — all three paths (editor SVG, gallery SVG, canvas) agree on fill-color logic for text |
| **`arrowHead` deduplication** | ✅ Clean — imported from `$lib/annotations.js` in the editor |
| **Slideshow page auth gating** | ✅ Clean — guard is `if ($githubRepo)`, not `if ($githubToken && $githubRepo)` |
| **CORS for canvas-based GIF export** | ✅ `crossOrigin = 'anonymous'` is set; `raw.githubusercontent.com` serves CORS headers in practice |

RESULT: ISSUES
