# Remediation 1 — 404 Fixes, Auth Gate, Dead Code, Annotation Consistency

## Tasks

- [ ] **Fix internal navigation links (fixes 404 on subpath deployment)**: Replace all `<a href="/x">` internal links with `goto('/x')` in 4 locations: `+layout.svelte:46`, `+page.svelte:175`, `slideshow/+page.svelte:184`, `annotate/[id]/+page.svelte:115`
- [ ] **Make gallery browsable without auth**: Move auth gate from layout-level content blocking to per-action gating. Show gallery content regardless of PAT; only gate write actions (upload, annotate, delete) behind connect prompt.
- [ ] **Remove dead code**: Remove `searchRepo()` from `src/lib/github.js:216-226` and unused `isTransparent` import in `+page.svelte:7`
- [ ] **Fix annotation text rendering inconsistencies**: Fix `AnnotationEditor.svelte:286` text fill to use `fillColor` instead of `strokeColor`; fix `gif-export.js:166` text baseline to use SVG default (alphabetic) instead of `top`
- [ ] **Add edit caption/tags on existing images**: Add edit button in detail modal with inline editor for caption and tags, save via `putFile()` to update JSON metadata
- [ ] **Wire drag-and-drop upload**: Add `ondrop`/`ondragover` handlers to upload area in `+page.svelte`
- [ ] **Add Edit Annotations link from slideshow preview**: Add button in slideshow preview to navigate to annotate page for the currently displayed slide
