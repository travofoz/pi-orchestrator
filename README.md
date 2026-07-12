# Emmy

Personal, lightweight image-hosting and sharing tool. Upload screenshots, tag them,
annotate them, and stitch them into GIFs — all on GitHub infrastructure.

- **No backend server.** Emmy runs entirely on GitHub: the repo is the database,
  GitHub Pages is the host, and the GitHub REST API (via Octokit) is the only
  backend.
- **No database.** Every image lives as a committed file; every image's metadata
  lives as a sibling `.json` file — git history gives you free rollback per image.
- **Single-user, personal tool.** Not a SaaS. Fork the repo and run your own instance.

## Prerequisites

- A **public GitHub repository** to store images (GitHub Pages requires a public
  repo on free plans — everything uploaded is intentionally public).
- A **GitHub Personal Access Token (classic)** with `repo` scope for write actions
  (upload, tag edit, annotate, export). Browsing the gallery requires no auth.

> **Recommendation:** Run this under a separate GitHub account or organization from
> your primary one, so any future flag/throttle on this repo doesn't touch your
> main identity or other repos.

## Setup

1. Fork/create a GitHub repository for your Emmy instance.
2. Get a classic PAT: https://github.com/settings/tokens/new?scopes=repo&description=Emmy
3. Deploy the app to GitHub Pages:
   - Push to `main` — the included workflow (`.github/workflows/deploy.yml`) builds
     and deploys automatically.
   - Enable GitHub Pages in your repo settings (Source: GitHub Actions).
4. Open the deployed site, click **Connect GitHub**, paste your token and repo name.

## Security Note

The GitHub PAT is stored in the browser's `localStorage`, which persists across
sessions indefinitely ("one and done" — no re-auth every time the tab closes).
This is more exposed to XSS than session-only storage would be. This tradeoff is
accepted because Emmy is a single-user, personal tool with a small, owner-controlled
codebase. **Do not use this approach in a multi-user application.**

## Usage

### Upload
Pick or drag an image. Client-side resize/compress keeps repo bloat in check.

### Gallery
Browse all uploaded images, filter by tag, search by caption.

### Annotate
Add arrows, boxes, text to any image. Annotations are stored as SVG overlays —
non-destructive, editable, separate from the raster image.

### GIF Export
Select an ordered sequence of images, set per-slide timing, and export as an
annotated GIF. Perfect for Twitter/X posts that need more than 4 images.

## Tech Stack

- **SvelteKit + Vite** — static site, deployed via `@sveltejs/adapter-static`
- **Octokit.js** — all GitHub API calls
- **DaisyUI** — UI components on top of Tailwind CSS
- **JavaScript + JSDoc** — no TypeScript, ever

## Design Philosophy

Emmy does one thing well: host, tag, link, and turn screenshots into GIFs.
It deliberately does not do AI-powered search, smart albums, or content
understanding — Google Photos already covers that for the owner's full private
library. Emmy is the **public-share layer**, not a Photos competitor.
