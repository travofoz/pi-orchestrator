/**
 * Annotation data model and SVG rendering utilities.
 *
 * Annotations are stored as an array of shape objects in each image's
 * JSON metadata (the `annotations` field). They are rendered as an SVG
 * overlay on top of the image, keeping them non-destructive — the
 * original raster image is never modified.
 *
 * Each shape has:
 * - type: 'rect' | 'arrow' | 'text' | 'freehand'
 * - Coordinates in image-pixel space (so the overlay scales with the image)
 * - Styling: strokeColor, strokeWidth, fillColor (with alpha), opacity
 */

/** @typedef {'rect'|'arrow'|'text'|'freehand'} ShapeType */

/**
 * @typedef {object} AnnotationShape
 * @property {string} id - unique id per shape
 * @property {ShapeType} type
 * @property {number} x
 * @property {number} y
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [endX] - arrow endpoint
 * @property {number} [endY] - arrow endpoint
 * @property {string} [text] - text content
 * @property {number} [fontSize]
 * @property {string} [fontFamily]
 * @property {string} [pathData] - SVG path data for freehand
 * @property {string} strokeColor
 * @property {number} strokeWidth
 * @property {string} fillColor - can be "transparent" for no fill
 * @property {number} opacity
 */

let shapeCounter = 0;

/**
 * Create a unique shape ID.
 * @returns {string}
 */
export function shapeId() {
	shapeCounter++;
	return `s-${Date.now()}-${shapeCounter}`;
}

/**
 * Default shape styles.
 */
export const DEFAULT_STYLES = {
	strokeColor: '#ff0000',
	strokeWidth: 2,
	fillColor: 'transparent',
	opacity: 1,
	fontSize: 16,
	fontFamily: 'sans-serif'
};

/**
 * Check if a color string represents transparency (no fill).
 * @param {string} color
 * @returns {boolean}
 */
export function isTransparent(color) {
	return !color || color === 'transparent' || color === 'none' || color === 'rgba(0,0,0,0)';
}

/**
 * Convert a color to rgba string, handling transparency.
 * @param {string} color - hex, rgb, rgba, or named color
 * @returns {string}
 */
export function parseColor(color) {
	if (isTransparent(color)) return 'rgba(0,0,0,0)';
	return color;
}

/**
 * Render annotations as SVG markup.
 * @param {AnnotationShape[]} annotations
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @returns {string} SVG markup string
 */
export function renderAnnotationsSVG(annotations, imageWidth, imageHeight) {
	if (!annotations || annotations.length === 0) return '';

	const parts = annotations.map((shape) => renderShapeSVG(shape));
	return parts.join('\n');
}

/**
 * Render a single shape as an SVG element string.
 * @param {AnnotationShape} shape
 * @returns {string}
 */
function renderShapeSVG(shape) {
	const stroke = escapeAttr(shape.strokeColor, DEFAULT_STYLES.strokeColor);
	const strokeWidth = escapeAttr(shape.strokeWidth, DEFAULT_STYLES.strokeWidth);
	// For text, use strokeColor as fallback fill when fillColor is transparent
	const rawFill = isTransparent(shape.fillColor)
		? (shape.type === 'text' ? (shape.strokeColor || DEFAULT_STYLES.strokeColor) : 'none')
		: (shape.fillColor || 'none');
	const fill = escapeAttr(rawFill);
	const opacity = escapeAttr(shape.opacity, DEFAULT_STYLES.opacity);
	const style = `stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}" opacity="${opacity}"`;

	switch (shape.type) {
		case 'rect':
			return `<rect x="${escapeAttr(shape.x)}" y="${escapeAttr(shape.y)}" width="${escapeAttr(shape.width)}" height="${escapeAttr(shape.height)}" ${style} />`;

		case 'arrow': {
			// Arrow with arrowhead
			const x1 = Number(shape.x) || 0;
			const y1 = Number(shape.y) || 0;
			const x2 = Number(shape.endX) || 0;
			const y2 = Number(shape.endY) || 0;
			const dx = x2 - x1;
			const dy = y2 - y1;
			const angle = Math.atan2(dy, dx);
			const headLen = Math.min(12, Math.sqrt(dx * dx + dy * dy) * 0.3);
			const headAngle = Math.PI / 6;
			const hx1 = x2 - headLen * Math.cos(angle - headAngle);
			const hy1 = y2 - headLen * Math.sin(angle - headAngle);
			const hx2 = x2 - headLen * Math.cos(angle + headAngle);
			const hy2 = y2 - headLen * Math.sin(angle + headAngle);
			return [
				`<line x1="${escapeAttr(x1)}" y1="${escapeAttr(y1)}" x2="${escapeAttr(x2)}" y2="${escapeAttr(y2)}" ${style} />`,
				`<polygon points="${escapeAttr(x2)},${escapeAttr(y2)} ${escapeAttr(hx1)},${escapeAttr(hy1)} ${escapeAttr(hx2)},${escapeAttr(hy2)}" ${style} />`
			].join('\n');
		}

		case 'text':
			// No stroke on text — matches editor SVG behavior.
			// Text is rendered as filled glyphs only, avoiding spurious outlines.
			const textStyle = `stroke="none" fill="${fill}" opacity="${opacity}"`;
			return `<text x="${escapeAttr(shape.x)}" y="${escapeAttr(shape.y)}" font-size="${escapeAttr(shape.fontSize, DEFAULT_STYLES.fontSize)}" font-family="${escapeAttr(shape.fontFamily, DEFAULT_STYLES.fontFamily)}" ${textStyle}>${escapeXML(shape.text || '')}</text>`;

		case 'freehand':
			return `<path d="${escapeAttr(shape.pathData, '')}" ${style} fill="none" />`;

		default:
			return '';
	}
}

/**
 * Escape a value for safe use in an SVG/HTML attribute context.
 * Numeric values are coerced to numbers; string values are escaped
 * to prevent XSS via attribute injection through {@html}.
 *
 * @param {*} val - Value to escape/coerce
 * @param {number|string} [fallback=''] - Fallback if val is null/undefined
 * @returns {string}
 */
function escapeAttr(val, fallback = '') {
	if (val == null) return String(fallback);
	if (typeof val === 'number') return String(val);
	const str = String(val);
	// Escape XML special chars for attribute safety
	return str
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/**
 * Escape XML entities for safe SVG text content (text nodes, not attributes).
 * @param {string} s
 * @returns {string}
 */
function escapeXML(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Create a new rect shape from two corner points.
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {Partial<AnnotationShape>} [style]
 * @returns {AnnotationShape}
 */
export function createRect(x1, y1, x2, y2, style = {}) {
	return {
		id: shapeId(),
		type: 'rect',
		x: Math.min(x1, x2),
		y: Math.min(y1, y2),
		width: Math.abs(x2 - x1),
		height: Math.abs(y2 - y1),
		...DEFAULT_STYLES,
		...style
	};
}

/**
 * Create an arrow shape.
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {Partial<AnnotationShape>} [style]
 * @returns {AnnotationShape}
 */
export function createArrow(x1, y1, x2, y2, style = {}) {
	return {
		id: shapeId(),
		type: 'arrow',
		x: x1,
		y: y1,
		endX: x2,
		endY: y2,
		...DEFAULT_STYLES,
		...style
	};
}

/**
 * Create a text shape.
 * @param {number} x
 * @param {number} y
 * @param {string} text
 * @param {Partial<AnnotationShape>} [style]
 * @returns {AnnotationShape}
 */
export function createText(x, y, text, style = {}) {
	return {
		id: shapeId(),
		type: 'text',
		x,
		y,
		text,
		...DEFAULT_STYLES,
		...style
	};
}

/**
 * Create a freehand path shape.
 * @param {string} pathData - SVG path data
 * @param {Partial<AnnotationShape>} [style]
 * @returns {AnnotationShape}
 */
export function createFreehand(pathData, style = {}) {
	return {
		id: shapeId(),
		type: 'freehand',
		x: 0,
		y: 0,
		pathData,
		...DEFAULT_STYLES,
		...style
	};
}

/**
 * Serialize annotations to JSON for storage in the metadata file.
 * Filters out empty annotations arrays.
 * @param {AnnotationShape[]|null} annotations
 * @returns {object[]|null}
 */
export function serializeAnnotations(annotations) {
	if (!annotations || annotations.length === 0) return null;
	return annotations.map((a) => ({ ...a }));
}
