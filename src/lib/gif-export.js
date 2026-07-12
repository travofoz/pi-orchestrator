/**
 * GIF export pipeline wrapper.
 *
 * Encoder abstraction layer around gifenc — the encoder call is behind this
 * module so it can be swapped later if needed (e.g. for a WebP-based animation
 * format with better compression).
 *
 * The pipeline:
 * 1. For each slide, draw the image + annotation overlay onto a <canvas>
 * 2. Quantize the RGBA pixel data to a palette (gifenc handles this)
 * 3. Encode frames into a GIF with per-frame delays
 * 4. Return a Blob for download or GitHub upload
 */

import { renderAnnotationsSVG, isTransparent } from '$lib/annotations.js';

/** @typedef {import('$lib/annotations.js').AnnotationShape} AnnotationShape */

/**
 * @typedef {object} Slide
 * @property {string} imageUrl - raw.githubusercontent.com URL
 * @property {number} width - image width in pixels
 * @property {number} height - image height in pixels
 * @property {AnnotationShape[]|null} annotations - SVG overlay shapes
 * @property {number} delay - frame delay in milliseconds
 * @property {string} id - image id (for sourceSlideIds tracking)
 */

/**
 * Estimate the output GIF size before encoding, to warn/downscale if needed.
 * This is a rough heuristic: uncompressed frame data × estimated compression ratio.
 *
 * @param {Slide[]} slides
 * @param {number} maxEstimatedMB - threshold to warn at (default 20 MB)
 * @returns {{ willBeLarge: boolean, estimatedMB: number, suggestedScale: number }}
 */
export function estimateGifSize(slides, maxEstimatedMB = 20) {
	if (slides.length === 0) return { willBeLarge: false, estimatedMB: 0, suggestedScale: 1 };

	// Use the first slide's dimensions as representative
	const { width, height } = slides[0];

	// Total raw pixel data across all frames
	const totalPixels = width * height * slides.length;

	// Rough heuristic: GIF compresses UI-like content to about 1-3 bytes per pixel
	// (compared to 4 bytes raw). Use 1.5 bytes/pixel as estimate for screenshots.
	const estimatedBytes = totalPixels * 1.5;
	const estimatedMB = estimatedBytes / (1024 * 1024);

	// If estimated > maxEstimatedMB, suggest downscale proportionally
	let suggestedScale = 1;
	if (estimatedMB > maxEstimatedMB) {
		// Scale down so estimated MB = maxEstimatedMB
		const ratio = Math.sqrt(maxEstimatedMB / estimatedMB);
		suggestedScale = Math.max(0.25, Math.min(1, ratio));
	}

	return {
		willBeLarge: estimatedMB > maxEstimatedMB,
		estimatedMB: Math.round(estimatedMB * 10) / 10,
		suggestedScale: Math.round(suggestedScale * 100) / 100
	};
}

/**
 * Draw a slide frame (image + annotations) onto a canvas.
 * Returns the canvas and its RGBA pixel data.
 *
 * @param {HTMLCanvasElement} canvas - target canvas (will be resized)
 * @param {Slide} slide
 * @param {number} scale - downscale factor (0-1)
 * @returns {Promise<{ canvas: HTMLCanvasElement, rgba: Uint8ClampedArray, width: number, height: number }>}
 */
async function renderFrame(canvas, slide, scale = 1) {
	const w = Math.round(slide.width * scale);
	const h = Math.round(slide.height * scale);
	canvas.width = w;
	canvas.height = h;
	const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

	// Clear with transparent background
	ctx.clearRect(0, 0, w, h);

	// Draw the image
	const img = await loadImage(slide.imageUrl);
	ctx.drawImage(img, 0, 0, w, h);

	// Draw annotations on top if present
	if (slide.annotations && slide.annotations.length > 0) {
		drawAnnotationsOnCanvas(ctx, slide.annotations, slide.width, slide.height, w, h);
	}

	const imageData = ctx.getImageData(0, 0, w, h);
	return { canvas, rgba: imageData.data, width: w, height: h };
}

/**
 * Draw annotation shapes onto a canvas context.
 * This respects transparent fill — fill is only applied if the fillColor
 * is not "transparent"/"none"/"rgba(0,0,0,0)".
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {AnnotationShape[]} annotations
 * @param {number} origWidth - original image width (for coordinate scaling)
 * @param {number} origHeight - original image height
 * @param {number} canvasWidth - current canvas width
 * @param {number} canvasHeight - current canvas height
 */
function drawAnnotationsOnCanvas(ctx, annotations, origWidth, origHeight, canvasWidth, canvasHeight) {
	const sx = canvasWidth / origWidth;
	const sy = canvasHeight / origHeight;

	for (const shape of annotations) {
		ctx.save();
		ctx.globalAlpha = shape.opacity ?? 1;
		ctx.strokeStyle = shape.strokeColor || '#ff0000';
		ctx.lineWidth = (shape.strokeWidth || 2) * Math.min(sx, sy);

		const hasFill = !isTransparent(shape.fillColor);
		if (hasFill) {
			ctx.fillStyle = shape.fillColor;
		}

		switch (shape.type) {
			case 'rect': {
				const x = shape.x * sx;
				const y = shape.y * sy;
				const w = (shape.width || 0) * sx;
				const h = (shape.height || 0) * sy;
				if (hasFill) ctx.fillRect(x, y, w, h);
				ctx.strokeRect(x, y, w, h);
				break;
			}
			case 'arrow': {
				const x1 = shape.x * sx;
				const y1 = shape.y * sy;
				const x2 = (shape.endX || 0) * sx;
				const y2 = (shape.endY || 0) * sy;
				ctx.beginPath();
				ctx.moveTo(x1, y1);
				ctx.lineTo(x2, y2);
				ctx.stroke();
				// Arrowhead
				const angle = Math.atan2(y2 - y1, x2 - x1);
				const headLen = Math.min(12, Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) * 0.3) * Math.min(sx, sy);
				const ha = Math.PI / 6;
				const hx1 = x2 - headLen * Math.cos(angle - ha);
				const hy1 = y2 - headLen * Math.sin(angle - ha);
				const hx2 = x2 - headLen * Math.cos(angle + ha);
				const hy2 = y2 - headLen * Math.sin(angle + ha);
				ctx.beginPath();
				ctx.moveTo(x2, y2);
				ctx.lineTo(hx1, hy1);
				ctx.lineTo(hx2, hy2);
				ctx.closePath();
				if (hasFill) ctx.fill();
				ctx.stroke();
				break;
			}
			case 'text': {
				const x = shape.x * sx;
				const y = shape.y * sy;
				const fontSize = (shape.fontSize || 16) * Math.min(sx, sy);
				ctx.font = `${fontSize}px ${shape.fontFamily || 'sans-serif'}`;
				ctx.textBaseline = 'alphabetic';
				// Fill text only (no stroke) — matches editor SVG behavior.
				// When fillColor is transparent, render in strokeColor for
				// clean text-with-no-background appearance.
				if (isTransparent(shape.fillColor)) {
					ctx.fillStyle = shape.strokeColor;
				} else {
					ctx.fillStyle = shape.fillColor;
				}
				ctx.fillText(shape.text || '', x, y);
				break;
			}
			case 'freehand': {
				// Parse SVG path data and draw
				const pathData = shape.pathData || '';
				const commands = pathData.match(/[ML]\s*[\d\s.-]+/g) || [];
				ctx.beginPath();
				let first = true;
				for (const cmd of commands) {
					const parts = cmd.trim().split(/[\s,]+/);
					const op = parts[0];
					const coords = parts.slice(1).map(Number);
					if (op === 'M' && coords.length >= 2) {
						if (first) {
							ctx.moveTo(coords[0] * sx, coords[1] * sy);
							first = false;
						}
					} else if (op === 'L' && coords.length >= 2) {
						ctx.lineTo(coords[0] * sx, coords[1] * sy);
					}
				}
				ctx.stroke();
				break;
			}
		}
		ctx.restore();
	}
}

/**
 * Load an image into an HTMLImageElement.
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(url) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
		img.src = url;
	});
}

/**
 * Encode an array of slides into a GIF Blob.
 *
 * @param {Slide[]} slides - ordered slides for the GIF
 * @param {object} [options]
 * @param {number} [options.scale] - downscale factor (0-1), auto-calculated if not set
 * @param {number} [options.maxColors] - max palette colors (default 256)
 * @param {number} [options.repeat] - loop count (0 = loop forever, default 0)
 * @returns {Promise<Blob>}
 */
export async function encodeGIF(slides, options = {}) {
	if (slides.length === 0) throw new Error('No slides to encode');

	const { GIFEncoder, quantize, applyPalette } = await import('gifenc');

	const maxColors = options.maxColors || 256;
	const repeat = options.repeat ?? 0;

	// Determine scale
	let scale = options.scale;
	if (!scale) {
		const estimate = estimateGifSize(slides, 20);
		scale = estimate.suggestedScale;
	}

	// Create a reusable canvas
	const canvas = document.createElement('canvas');

	// Render all frames first (we need all palettes to decide the global one later)
	// Actually, gifenc supports per-frame local palettes, so each frame can have its own.
	// But for better quality, we could quantize all frames together. Let's use local palettes
	// per frame which is simpler and works well for screenshots.

	const encoder = GIFEncoder({ auto: true });
	let isFirst = true;

	for (let i = 0; i < slides.length; i++) {
		const slide = slides[i];
		const { rgba, width, height } = await renderFrame(canvas, slide, scale);

		// Quantize RGBA data to palette
		const palette = quantize(rgba, maxColors, {
			format: 'rgb565',
			clearAlpha: true,
			clearAlphaColor: 0,
			clearAlphaThreshold: 128
		});

		// Apply palette to get indexed pixel data
		const indexData = applyPalette(rgba, palette, 'rgb565');

		// Write frame
		encoder.writeFrame(indexData, width, height, {
			palette: isFirst ? palette : palette, // Always provide palette for local color table
			delay: slide.delay,
			repeat,
			transparent: false,
			dispose: 1 // Clear to background before drawing next frame
		});

		isFirst = false;
	}

	encoder.finish();
	const gifBytes = encoder.bytes();

	return new Blob([gifBytes], { type: 'image/gif' });
}

/**
 * Export a GIF and upload to GitHub as a new gallery entry.
 *
 * @param {import('octokit').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {Slide[]} slides
 * @param {object} options
 * @param {string[]} [options.tags]
 * @param {string} [options.caption]
 * @param {number} [options.scale]
 * @returns {Promise<{ id: string, gifUrl: string, blob: Blob }>}
 */
export async function exportAndCommitGIF(octokit, owner, repo, slides, options = {}) {
	const { tags = [], caption = '', scale } = options;
	const { putBinaryFile, putFile, getDefaultBranch } = await import('./github.js');
	const branch = await getDefaultBranch(octokit, owner, repo);
	const { generateImageId, buildMetadata, blobToBase64 } = await import('./upload.js');

	const id = generateImageId();
	const gifFilename = `${id}.gif`;
	const jsonFilename = `${id}.gif.json`;
	const gifPath = `images/${gifFilename}`;
	const jsonPath = `images/${jsonFilename}`;

	// Encode the GIF
	const blob = await encodeGIF(slides, { scale });

	// Get the first slide's dimensions for metadata
	const { width, height } = slides[0];

	// Use the scaled dimensions
	const effectiveScale = scale || estimateGifSize(slides, 20).suggestedScale;
	const scaledWidth = Math.round(width * effectiveScale);
	const scaledHeight = Math.round(height * effectiveScale);

	// Upload GIF
	const base64 = await blobToBase64(blob);
	await putBinaryFile(octokit, owner, repo, gifPath, base64, `Export GIF ${id}`);

	const gifUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${gifPath}`;

	// Build metadata with sourceSlideIds
	const sourceSlideIds = slides.map((s) => s.id);
	const metadata = buildMetadata(
		id,
		gifFilename,
		'gif',
		tags,
		caption,
		scaledWidth,
		scaledHeight,
		null,
		sourceSlideIds
	);

	await putFile(octokit, owner, repo, jsonPath, metadata, `Add metadata for ${gifFilename}`);

	return { id, gifUrl, blob };
}
