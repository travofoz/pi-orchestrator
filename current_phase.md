# Emmy — Build Spec

**Read this whole document before writing any code.** This is a complete spec for an
agent with no prior context on the project. Everything you need is here.

---

## 0. Where this came from

This idea arrived in the half-asleep stretch between sleep and waking, and the first
move was reaching for a phone and hitting the microphone button — not the keyboard —
to talk it through with an AI before coffee, before anything had a chance to knock it
loose.

That distinction is the actual discipline worth keeping, more than anything technical
in this doc: typing is composition, and composition is a lossy compression format —
the moment you start finding words to type, you're already condensing and editing
instead of getting the raw thought out. Talking skips that step. Even so, parts of it
evaporated in real time while trying to get it out — a half-formed idea behaves like
fog, not like a file. The habit to build isn't "have good ideas while waking up." It's:
the instant something half-formed shows up, reach for voice before anything that
forces composition, and talk it out before it's gone.

---

## 1. What this is

Emmy is a personal, lightweight image-hosting and sharing tool. It replaces Imgur for
one person's workflow: upload a screenshot fast, tag it, get a shareable link, and —
its actual differentiating feature — stitch several screenshots into an annotated GIF
for posting to Twitter/X, which caps native image posts at 4 but allows a single GIF
of any sequence length.

It runs entirely on GitHub as infrastructure: a public GitHub repo is the database,
GitHub Pages is the host, and the GitHub REST API (via Octokit) is the only backend
that exists. There is no server, no database, no user accounts beyond the owner's own
GitHub account.

**This is explicitly a single-user, personal tool.** Not a SaaS, not multi-tenant. If
someone else wants it, they fork the repo and run their own instance with their own
token. Do not build any shared/multi-user abstractions — that's out of scope and
would be actively wrong to add.

**There is no public/private toggle and never will be.** Everything uploaded through
this tool is intentionally public — the user already has Google Photos for private
storage. Do not build a visibility setting, a private mode, or gate viewing behind
auth. The GitHub PAT is only ever needed for *write* actions (upload, tag edit,
annotate, export). Browsing/viewing the gallery requires no auth at all.

---

## 2. Non-negotiable technical constraints

- **JavaScript + JSDoc only. No TypeScript, ever.** Use JSDoc comments for IDE type
  hinting. Do not add a `tsconfig.json`, do not use `.ts`/`.tsx` files, do not suggest
  migrating to TypeScript at any point, even partially.
- Stack: **SvelteKit + Vite**, static adapter (`@sveltejs/adapter-static`), deployed
  to GitHub Pages. **DaisyUI** for UI components/styling on top of Tailwind.
- **Octokit.js** for all GitHub API calls (upload, commit, fetch, search).
- No backend server, no database beyond the git repo itself, no ORM.
- Fully client-side. Every feature must work from a static site with a user-supplied
  GitHub PAT — no serverless functions in v1 (see §5 for the one deferred exception).
- **Unix philosophy: do one thing well.** This tool hosts, tags, links, and turns
  screenshots into GIFs. It deliberately does not do AI-powered search, smart
  albums, or content understanding — the owner's Google Photos already covers that
  for the private/full library. Emmy is the public-share layer, not a Photos
  competitor. Do not add AI captioning/tagging/vision features; this is a
  considered scope boundary, not a gap to fill later.

### Auth persistence
- On first connect, the PAT is stored in **localStorage**, not sessionStorage — it
  persists across browser sessions indefinitely ("one and done"), not re-auth every
  time the tab closes. This is a single-user tool; the owner logs in once.
- Provide a "Connect GitHub" flow: explain the required scope (repo write access)
  in plain language, deep-link to GitHub's token creation page with the scope
  pre-selected via URL params if possible (e.g.
  `github.com/settings/tokens/new?scopes=repo&description=Emmy`), then a field to
  paste the generated token back in.
- Document this tradeoff plainly in the UI or README: persisting a write-scoped
  token in localStorage is more exposed to XSS than a session-only token would be.
  Accepted here because this is a single-user tool with a small, owner-controlled
  codebase — not a reason to skip mentioning it.

---

## 3. Data model

One image = one committed image file + one JSON metadata file, same base name,
committed together.

```
/images/
  2026-07-11-a1b2c3.png
  2026-07-11-a1b2c3.json
  2026-07-11-a1b2c3.gif        <- GIF exports live here too, same pattern
  2026-07-11-a1b2c3.gif.json
```

Metadata JSON shape (adjust as needed, but keep it flat and simple):

```json
{
  "id": "2026-07-11-a1b2c3",
  "filename": "2026-07-11-a1b2c3.png",
  "type": "image",
  "createdAt": "2026-07-11T14:22:00Z",
  "tags": ["screenshot", "app-flow"],
  "caption": "",
  "width": 1200,
  "height": 800,
  "annotations": null,
  "sourceSlideIds": null
}
```

- `type` is `"image"` or `"gif"`.
- `annotations` holds the SVG overlay JSON for that image (see Phase 3), or `null`.
- `sourceSlideIds` (GIF entries only) lists the image ids that were combined to
  produce this GIF, in order — this is what gives you rollback/traceability on GIF
  exports for free, same idea as the metadata-JSON-per-image pattern.

**Why JSON-per-image instead of one big index file:** git history on each file gives
free rollback per image without touching unrelated entries. Do not collapse this into
a single monolithic `gallery.json` — that defeats the whole point of the design.

---

## 4. Phases

Build and ship these in order. Each phase should be independently working and
committable — don't let phase boundaries blur into one giant unreviewable commit.

### Phase 0 — Scaffold

- SvelteKit + Vite project, static adapter, DaisyUI + Tailwind configured.
- GitHub Pages deploy workflow (`.github/workflows/deploy.yml`).
- "Connect GitHub" flow per §2: deep-link to token creation with scope pre-selected,
  paste-back field, store in localStorage (persists indefinitely — no re-auth on
  tab close). Gallery itself is fully browsable with zero auth; the connect flow
  only gates write actions.
- Octokit client wrapper module (`src/lib/github.js`) with functions for: get file,
  put file (create/update), list directory contents, search repos/code (used later).

**Done when:** app loads, accepts a PAT, and can list the contents of `/images/` in
the configured repo.

### Phase 1 — Upload + gallery read

- Upload flow: pick/drop an image → client-side resize/compress if oversized (avoid
  unbounded repo bloat — pick a sane max dimension, e.g. 2000px longest edge, and
  compress) → generate id → commit image file + JSON metadata file together via
  Octokit.
- Gallery view: fetch and render all entries under `/images/`. Decide and implement
  one of:
  - **(a)** GitHub Action that rebuilds a generated `index.json` on push, gallery
    reads that one file, or
  - **(b)** client fetches the directory listing + all JSON files directly via API.
  Pick (a) if you want fewer client-side API calls (better for repeat visits,
  avoids rate limits); pick (b) if you want zero CI complexity. Either is
  acceptable — document which one you chose and why in a code comment.
- Tag filter and basic search (client-side, filter over the loaded metadata — no
  need for anything fancier at this scale).
- Direct link: raw file URL (`raw.githubusercontent.com/...`) shown/copyable per
  image.

**Done when:** user can upload an image, see it appear in the gallery, filter by tag,
and copy a working direct link.

### Phase 2 — Annotation layer

- Per-image annotation editor: arrows, boxes, text, freehand if easy — stored as an
  **SVG overlay**, saved into that image's JSON `annotations` field, separate from
  the raster image itself. Non-destructive: re-opening the editor loads the same
  editable shapes back.
- **Boxes and text must support transparent fill** — outline-only boxes and
  text-with-no-background, not just solid-filled shapes. This is a real requirement,
  not a nice-to-have; alpha-aware rendering, not just an opaque rect option.
- Render the overlay live on top of the image in both the editor and the gallery
  detail view.

**Done when:** user can annotate an image with arrows/boxes/text, toggle
transparent vs filled on boxes/text, save, and reload the same annotations later.

### Phase 3 — Slideshow builder + GIF export

- Slideshow builder: pick an ordered sequence of images (target scale: ~6–7 images,
  don't over-engineer for hundreds), set a per-slide duration (default ~2–3 sec,
  editable), preview as an in-app player that can pause mid-play to inspect/edit a
  slide's annotations.
- GIF export pipeline:
  1. For each slide, draw the image onto a `<canvas>`, then draw the annotation
     overlay on top, **rasterized with alpha support** (respecting the transparent
     fill requirement from Phase 2) — annotations must be burned into the frame
     since GIF has no overlay/layer concept.
  2. Feed the sequence of canvas frames + per-frame delay into a JS GIF encoder.
     Use **gifenc** (better palette quantization for sharp UI/text edges than
     gif.js's fixed 256-color palette — this matters because the primary content is
     screenshots, not photos). Keep the encoder call behind a small wrapper module
     so it's swappable later if needed.
  3. Before encoding, if total resolution × frame count looks like it'll produce an
     oversized file, downscale and/or warn the user — GIFs don't interframe-compress
     like video, so a handful of full-res screenshots can get large fast.
  4. On export, commit the resulting `.gif` back into `/images/` as its own entry
     (with `type: "gif"` and `sourceSlideIds` set), so it gets a tag, a direct link,
     and shows up in the gallery like any other asset. Also offer a plain download.

**Done when:** user can sequence 6–7 annotated images, preview with pause, export a
GIF with annotations burned in and transparency respected, and have that GIF land in
the gallery as a taggable, linkable entry.

---

## 5. Explicitly out of scope for this build (v2 / deferred, do not implement)

Do not build these. They are documented here only so you don't accidentally start
down these paths while reasoning about "what would a complete version need."

- **AI-powered tagging, captioning, or content search.** Rejected by design, not
  deferred — see the Unix-philosophy note in §2. Google Photos already does this
  for the owner's full library; Emmy is deliberately just the public-share layer.
- **Comments with visitor identity.** Would require GitHub OAuth, which needs a
  client-secret exchange that can't happen from static JS — i.e. a serverless
  function, real infra this project deliberately avoids. If this is ever wanted,
  the answer is embedding **giscus** (GitHub Discussions-backed, OAuth already
  solved elsewhere), not a custom-built Worker + Issues mapping.
- **Per-image OG preview pages** (so raw links unfurl into image cards on
  Twitter/Slack/Discord via `og:image` meta tags). Not needed for the GIF-attach
  workflow, which uses native media upload, not a link at all.
- Any multi-user, shared-account, or permissions system.
- A private/public visibility toggle of any kind.

---

## 6. Operational caveats — surface these to the user, don't just silently note them

- **GitHub Pages requires a public repo** on free/non-Enterprise plans — everything
  uploaded is public, which matches the design intent (see §1), but the agent
  building this should not add any UI implying otherwise.
- **Bandwidth/abuse risk is about traffic volume, not which feature exists.**
  GitHub's Acceptable Use Policy allows throttling, suspension, or repo deletion if
  usage is judged excessive relative to other users (typically with advance notice).
  This is a personal/moderate-traffic tool, not a CDN. If a comment or docstring
  needs to reference this, keep it factual and brief — don't build any enforcement
  logic around it, it's just user awareness.
- **Recommend the user run this under a separate GitHub account or organization**
  from their primary one, so any future flag/throttle on this repo doesn't touch
  their main identity or other repos. This can be a line in the README, not code.

---

## 7. Notes for the implementing agent

- Keep each phase's diff reviewable. Don't refactor earlier phases while
  implementing later ones unless something is actually broken.
- Favor small, composable modules (`src/lib/github.js`, `src/lib/gif-export.js`,
  `src/lib/annotations.js`, etc.) over one large file — this will be picked up and
  continued by other agent runs across sessions, so legibility matters more than
  cleverness.
- If you hit a design decision not covered here, make the simplest choice
  consistent with the constraints in §2 and §5, note the choice in a code comment,
  and move on — don't block on it.

