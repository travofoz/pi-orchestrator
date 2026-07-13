# 03_slideshow_and_gif_export

## Objective
Slideshow builder for sequencing images with per-slide duration, in-app preview with pause. GIF export pipeline using gifenc: rasterizes image + annotation overlay (alpha-aware) onto canvas, encodes with per-frame delay, downsizes if oversized. Commits resulting .gif (with type: 'gif' and sourceSlideIds) into /images/ as a gallery entry. Also offers plain download.

## Done When
User can sequence 6–7 annotated images, preview with pause, export a GIF with annotations burned in and transparency respected, and have that GIF land in the gallery as a taggable, linkable entry.
