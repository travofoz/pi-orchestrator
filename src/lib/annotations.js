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
	const stroke = shape.strokeColor || DEFAULT_STYLES.strokeColor;
	const strokeWidth = shape.strokeWidth || DEFAULT_STYLES.strokeWidth;
	// For text, use strokeColor as fallback fill when fillColor is transparent
	const fill = isTransparent(shape.fillColor)
		? (shape.type === 'text' ? stroke : 'none')
		: shape.fillColor;
	const opacity = shape.opacity ?? DEFAULT_STYLES.opacity;
	const style = `stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}" opacity="${opacity}"`;

	switch (shape.type) {
		case 'rect':
			return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" ${style} />`;

		case 'arrow': {
			// Arrow with arrowhead
			const dx = (shape.endX || 0) - shape.x;
			const dy = (shape.endY || 0) - shape.y;
			const angle = Math.atan2(dy, dx);
			const headLen = Math.min(12, Math.sqrt(dx * dx + dy * dy) * 0.3);
			const headAngle = Math.PI / 6;
			const x1 = shape.x;
			const y1 = shape.y;
			const x2 = shape.endX || 0;
			const y2 = shape.endY || 0;
			const hx1 = x2 - headLen * Math.cos(angle - headAngle);
			const hy1 = y2 - headLen * Math.sin(angle - headAngle);
			const hx2 = x2 - headLen * Math.cos(angle + headAngle);
			const hy2 = y2 - headLen * Math.sin(angle + headAngle);
			return [
				`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${style} />`,
				`<polygon points="${x2},${y2} ${hx1},${hy1} ${hx2},${hy2}" ${style} />`
			].join('\n');
		}

		case 'text':
			return `<text x="${shape.x}" y="${shape.y}" font-size="${shape.fontSize || DEFAULT_STYLES.fontSize}" font-family="${shape.fontFamily || DEFAULT_STYLES.fontFamily}" ${style}>${escapeXML(shape.text || '')}</text>`;

		case 'freehand':
			return `<path d="${shape.pathData || ''}" ${style} fill="none" />`;

		default:
			return '';
	}
}

/**
 * Escape XML entities for safe SVG text content.
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
