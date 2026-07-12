### Remediation 1

## Tasks

- [x] **HARD_CONSTRAINTS: Decouple repo configuration from PAT requirement** — Allow the gallery to be browsed without entering a GitHub PAT. The connect modal must accept a repo name without a token for read-only mode. The `$githubRepo` store must be settable independently of `$githubToken`.
- [x] **HARD_CONSTRAINTS: Allow gallery loading without auth** — `src/routes/+page.svelte` must call `loadGallery()` even when `$githubRepo` is set but `$githubToken` is empty. The `loadGallery()` call must work with a read-only Octokit client (unauthenticated or with a minimal anonymous client) when only browsing public repo data.
- [x] **HARD_CONSTRAINTS: Gate write-only UI behind PAT, not gallery browsing** — The upload, annotate, edit, and delete UI sections must be hidden/gated behind `$isConnected`, but the gallery grid and detail view must render for any visitor who provides a repo name (without a token).
- [x] **BASELINE_REVIEW: Fix deploy workflow branch trigger** — Change `.github/workflows/deploy.yml` branch trigger from `[master]` to `[main, master]` (or `[main]` to match the README) so the Action fires for repos using either naming convention.
- [x] **BASELINE_REVIEW: Make GIF tags user-configurable** — Replace the hardcoded `tags: ['gif']` default in `src/routes/slideshow/+page.svelte` with a user-editable input so tags can be set at export time (or derived from source slide data).
- [x] **BASELINE_REVIEW: Escape shape attribute values in SVG rendering** — In `src/lib/annotations.js` (`renderShapeSVG`), coerce or escape all interpolated attribute values (`x`, `y`, `width`, `height`, `endX`, `endY`, `strokeColor`, `strokeWidth`, `fillColor`, `opacity`) to prevent XSS through `{@html}`. Ensure numeric coordinates are cast to numbers and string color/opacity values are escaped.
- [x] **BASELINE_REVIEW: Replace dynamic import of `getFile` with static import** — In `src/routes/+page.svelte`, move `getFile` from the runtime `await import('$lib/github.js')` call inside `handleEditSave` to the static import block at the top of the file.
- [x] **BASELINE_REVIEW: Guard `handleKeydown` against input element focus** — In `src/lib/components/AnnotationEditor.svelte`, add a guard at the top of `handleKeydown` that returns early when `e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'`, so that Backspace/Delete does not delete a selected shape while the user is editing text in the text input popup.
- [x] **BASELINE_REVIEW: Dismiss text input popup on tool switch** — In `src/lib/components/AnnotationEditor.svelte`, ensure that switching tools (clicking Rectangle, Arrow, Text, etc.) sets `showTextInput = false` so the text input popup is closed.
- [x] **BASELINE_REVIEW: Fix delete button logic inconsistency** — In `src/routes/+page.svelte`, remove the `closeDetail()` call from the modal delete button's `onclick` handler (or restructure the handler) so that `handleDelete`'s internal guard (`if (detailEntry?.id === id) closeDetail()`) is not dead code, and the modal close happens consistently after deletion.

### Remediation 2

## Tasks

- [ ] **Fix touch + mouse event duplication in AnnotationEditor** — Replace separate `onmousedown`/`onmousemove`/`onmouseup` and `ontouchstart`/`ontouchmove`/`ontouchend` handlers in `src/lib/components/AnnotationEditor.svelte` with unified Pointer Events (`onpointerdown`/`onpointermove`/`onpointerup`) or prevent default on touch events to suppress synthesized mouse events, preventing double-firing per gesture on touch devices.

- [ ] **Fix slideshow page auth gating for read-only access** — In `src/routes/slideshow/+page.svelte`, change the `$effect` guard from `if ($githubToken && $githubRepo)` to `if ($githubRepo)` so the slideshow builder loads for repo-only (no token) users, matching the gallery page pattern; keep export gated behind `$isConnected`.

- [ ] **Remove or implement unused `strokeWidth` parameter in `arrowHead()`** — In `src/lib/components/AnnotationEditor.svelte`, either use `strokeWidth` to scale the arrow head size or remove the parameter from the function signature and all call sites.

- [ ] **Fix GIF export text annotation rendering mismatch** — Align `drawAnnotationsOnCanvas` in `src/lib/gif-export.js` with the editor SVG template and gallery SVG overlay so text annotations render identically across all three paths; address double-rendering (fill + stroke with same color) for transparent-fill text and spurious stroke outline for filled text.

- [ ] **Convert unnecessary dynamic imports to static imports** — In `src/lib/upload.js` and `src/lib/gif-export.js`, replace dynamic `import()` of local modules (`./github.js`, `./upload.js`) with top-level static imports to eliminate async failure modes with no code-splitting benefit.

- [ ] **Clean up slideshow play interval on component destroy** — In `src/routes/slideshow/+page.svelte`, import `onDestroy` from `'svelte'` and add a cleanup callback that clears `playInterval` when the component is unmounted, preventing memory leak and stale state mutations.

- [ ] **Remove dead code: `getLatestCommitSha`** — Delete the exported `getLatestCommitSha` function in `src/lib/github.js` (lines 214-228) since it is never imported anywhere in `src/`, reducing maintenance surface and unnecessary API calls.

- [ ] **Deduplicate `arrowHead` logic** — Export the arrowhead triangle calculation from `src/lib/annotations.js` and import it in `src/lib/components/AnnotationEditor.svelte`, replacing the duplicated `arrowHead` function, so arrow rendering is maintained in one canonical location.

### Remediation 3

## Tasks

- [ ] **Fix `setInterval` fixed delay breaking per-slide durations in slideshow preview** — `src/routes/slideshow/+page.svelte` `startPlay()` captures `slides[0]?.delay` once at interval creation; all subsequent slides play at that fixed rate. Replace `setInterval` with recursive `setTimeout` that reads `slides[previewIndex]?.delay` on every tick.
- [ ] **Revoke previous blob URL on file re-select and re-drop** — `src/routes/+page.svelte` `handleFileSelect` and `ondrop` call `URL.createObjectURL(file)` without revoking any prior `uploadPreview`. Call `URL.revokeObjectURL(uploadPreview)` before overwriting it in both handlers.
- [ ] **Eliminate duplicate `estimateGifSize` call in GIF export** — `src/lib/gif-export.js` `exportAndCommitGIF` calls `encodeGIF` (which internally estimates size) and then calls `estimateGifSize` again for metadata dimensions. Derive effective dimensions from `encodeGIF`'s return value or pass the effective scale back instead of re-estimating.
- [ ] **Replace `||` with `??` in `effectiveScale` fallback** — `src/lib/gif-export.js` line ~310: `const effectiveScale = scale || estimateGifSize(...)` treats `0` (a falsy but valid value) as absent. Change to `scale ?? estimateGifSize(...)`.
- [ ] **Remove vestigial `e.preventDefault()` in `saveConnect`** — `src/routes/+layout.svelte` `saveConnect` calls `e.preventDefault()` but is wired to a `<button type="button">` with no `<form>` parent, making the call a no-op. Either remove the parameter and `e.preventDefault()`, or wrap the modal content in `<form onsubmit={saveConnect}>` to make keyboard submission work.
- [ ] **Wrap connect modal in `<form>` for keyboard submission** — `src/routes/+layout.svelte` lines 94–168: the repo/token inputs and Connect button are not inside a `<form>`, so pressing Enter does nothing. Wrap inputs and button in `<form onsubmit={saveConnect}>` (or handle the submit event) to enable keyboard submission and fix the related UX/accessibility gap.
- [ ] **Centralize `raw.githubusercontent.com` URL construction into a shared utility** — `src/lib/gallery.js:67`, `src/lib/upload.js:213`, `src/lib/gif-export.js:329`, and `src/routes/annotate/[id]/+page.svelte:55` each hand-assemble `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/images/${filename}` without URL-encoding branch or filename. Extract a `rawFileUrl(owner, repo, branch, path)` utility that applies `encodeURIComponent` to branch and path segments, and use it in all four locations.
- [ ] **Deduplicate `arrowHead` geometry between `gif-export.js` and `annotations.js`** — `src/lib/gif-export.js` contains its own inline arrowhead calculation with canvas scaling; import the base geometry from `src/lib/annotations.js` and apply canvas scaling separately instead of maintaining a duplicate implementation.

