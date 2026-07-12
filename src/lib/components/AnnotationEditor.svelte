<script>
	import { createRect, createArrow, createText, createFreehand, shapeId, DEFAULT_STYLES, isTransparent } from '$lib/annotations.js';

	/** @type {import('$lib/annotations.js').AnnotationShape[]} */
	let { shapes = $bindable([]), imageWidth, imageHeight, imageUrl, readonly = false } = $props();

	let activeTool = $state('select'); // 'select' | 'rect' | 'arrow' | 'text' | 'freehand'
	let selectedId = $state(null);
	let drawing = $state(false);
	let startX = $state(0);
	let startY = $state(0);
	let currentShape = $state(null);
	let textInput = $state('');
	let textInputPos = $state({ x: 0, y: 0 });
	let showTextInput = $state(false);

	// Style controls
	let strokeColor = $state(DEFAULT_STYLES.strokeColor);
	let strokeWidth = $state(DEFAULT_STYLES.strokeWidth);
	let fillColor = $state(DEFAULT_STYLES.fillColor);
	let fillEnabled = $state(false);

	/** @type {SVGSVGElement|null} */
	let svgEl = $state(null);

	/**
	 * Get mouse/touch coordinates relative to the SVG overlay.
	 */
	function getCoords(e) {
		if (!svgEl) return { x: 0, y: 0 };
		const rect = svgEl.getBoundingClientRect();
		const clientX = e.touches?.[0]?.clientX ?? e.clientX;
		const clientY = e.touches?.[0]?.clientY ?? e.clientY;
		// Scale from display pixels to image pixels
		const scaleX = imageWidth / rect.width;
		const scaleY = imageHeight / rect.height;
		return {
			x: (clientX - rect.left) * scaleX,
			y: (clientY - rect.top) * scaleY
		};
	}

	function handlePointerDown(e) {
		if (readonly) return;
		const { x, y } = getCoords(e);

		// Dismiss text input popup when starting any canvas interaction
		showTextInput = false;

		if (activeTool === 'text') {
			// Place text at click position
			textInputPos = { x, y };
			textInput = '';
			showTextInput = true;
			return;
		}

		if (activeTool === 'select') {
			// Select shape under cursor
			selectedId = findShapeAt(x, y);
			return;
		}

		drawing = true;
		startX = x;
		startY = y;

		if (activeTool === 'freehand') {
			currentShape = { id: shapeId(), type: 'freehand', x, y, pathData: `M ${x} ${y}`, ...getCurrentStyles() };
		}
	}

	function handlePointerMove(e) {
		if (!drawing || !currentShape) return;
		const { x, y } = getCoords(e);

		if (activeTool === 'rect') {
			currentShape = createRect(startX, startY, x, y, getCurrentStyles());
		} else if (activeTool === 'arrow') {
			currentShape = createArrow(startX, startY, x, y, getCurrentStyles());
		} else if (activeTool === 'freehand') {
			currentShape.pathData += ` L ${x} ${y}`;
		}
	}

	function handlePointerUp(e) {
		if (!drawing) return;
		drawing = false;

		if (currentShape && activeTool !== 'select') {
			// Only add if shape has meaningful size
			if (activeTool === 'freehand' || (currentShape.width > 2 || currentShape.height > 2)) {
				shapes = [...shapes, currentShape];
			} else if (activeTool === 'arrow') {
				const dx = (currentShape.endX || 0) - currentShape.x;
				const dy = (currentShape.endY || 0) - currentShape.y;
				if (Math.sqrt(dx * dx + dy * dy) > 5) {
					shapes = [...shapes, currentShape];
				}
			}
		}
		currentShape = null;
	}

	function commitText() {
		if (textInput.trim()) {
			const shape = createText(textInputPos.x, textInputPos.y, textInput.trim(), getCurrentStyles());
			shapes = [...shapes, shape];
		}
		showTextInput = false;
		textInput = '';
	}

	function getCurrentStyles() {
		return {
			strokeColor,
			strokeWidth,
			fillColor: fillEnabled ? fillColor : 'transparent'
		};
	}

	function findShapeAt(x, y) {
		const tolerance = 5;
		for (let i = shapes.length - 1; i >= 0; i--) {
			const s = shapes[i];
			if (s.type === 'rect') {
				const r = { x: s.x, y: s.y, w: s.width || 0, h: s.height || 0 };
				if (x >= r.x - tolerance && x <= r.x + r.w + tolerance && y >= r.y - tolerance && y <= r.y + r.h + tolerance) return s.id;
			} else if (s.type === 'text') {
				if (Math.abs(x - s.x) < 30 + (s.text?.length || 0) * (s.fontSize || 16) * 0.5 && Math.abs(y - s.y) < (s.fontSize || 16) + 10) return s.id;
			} else if (s.type === 'arrow') {
				// Point-to-line distance
				const dist = pointToLineDist(x, y, s.x, s.y, s.endX || 0, s.endY || 0);
				if (dist < tolerance + (s.strokeWidth || 2)) return s.id;
			} else if (s.type === 'freehand') {
				// Approximate hit-test on path
				if (Math.abs(x - s.x) < 50 && Math.abs(y - s.y) < 50) return s.id;
			}
		}
		return null;
	}

	function pointToLineDist(px, py, x1, y1, x2, y2) {
		const dx = x2 - x1;
		const dy = y2 - y1;
		const len = Math.sqrt(dx * dx + dy * dy);
		if (len === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
		const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (len * len)));
		const nearX = x1 + t * dx;
		const nearY = y1 + t * dy;
		return Math.sqrt((px - nearX) ** 2 + (py - nearY) ** 2);
	}

	function deleteSelected() {
		if (selectedId) {
			shapes = shapes.filter((s) => s.id !== selectedId);
			selectedId = null;
		}
	}

	function getFillColor(shape) {
		if (isTransparent(shape.fillColor)) return 'none';
		return shape.fillColor;
	}

	/** @param {import('$lib/annotations.js').AnnotationShape} shape */
	function getShapeOpacity(shape) {
		return shape.opacity ?? 1;
	}

	// Keyboard shortcut: Delete selected shape
	function handleKeydown(e) {
		// Don't delete shapes when user is typing in an input or textarea
		const tag = /** @type {Element} */ (e.target).tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA') return;

		if (e.key === 'Delete' || e.key === 'Backspace') {
			deleteSelected();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="space-y-3">
	<!-- Toolbar -->
	{#if !readonly}
		<div class="flex flex-wrap items-center gap-2 p-2 bg-base-200 rounded-lg">
			<button
				class="btn btn-sm {activeTool === 'select' ? 'btn-primary' : 'btn-ghost'}"
				onclick={() => { activeTool = 'select'; showTextInput = false; }}
				title="Select / Move"
			>↖</button>
			<button
				class="btn btn-sm {activeTool === 'rect' ? 'btn-primary' : 'btn-ghost'}"
				onclick={() => { activeTool = 'rect'; showTextInput = false; }}
				title="Rectangle"
			>□</button>
			<button
				class="btn btn-sm {activeTool === 'arrow' ? 'btn-primary' : 'btn-ghost'}"
				onclick={() => { activeTool = 'arrow'; showTextInput = false; }}
				title="Arrow"
			>→</button>
			<button
				class="btn btn-sm {activeTool === 'text' ? 'btn-primary' : 'btn-ghost'}"
				onclick={() => { activeTool = 'text'; showTextInput = false; }}
				title="Text"
			>T</button>
			<button
				class="btn btn-sm {activeTool === 'freehand' ? 'btn-primary' : 'btn-ghost'}"
				onclick={() => { activeTool = 'freehand'; showTextInput = false; }}
				title="Freehand"
			>✎</button>

			<div class="divider divider-horizontal mx-1"></div>

			<label class="flex items-center gap-1 text-xs">
				Stroke
				<input type="color" bind:value={strokeColor} class="w-6 h-6 rounded cursor-pointer" />
			</label>
			<label class="flex items-center gap-1 text-xs">
				Width
				<input type="range" min="1" max="10" bind:value={strokeWidth} class="range range-xs w-16" />
			</label>
			<label class="flex items-center gap-1 text-xs">
				<input type="checkbox" bind:checked={fillEnabled} class="checkbox checkbox-xs" />
				Fill
			</label>
			{#if fillEnabled}
				<input type="color" bind:value={fillColor} class="w-6 h-6 rounded cursor-pointer" />
			{/if}

			{#if selectedId}
				<div class="divider divider-horizontal mx-1"></div>
				<button class="btn btn-error btn-xs" onclick={deleteSelected}>Delete</button>
			{/if}
		</div>
	{/if}

	<!-- Canvas area -->
	<div class="relative inline-block max-w-full">
		<img
			src={imageUrl}
			alt="Image to annotate"
			style="width: 100%; height: auto; max-width: {imageWidth}px; display: block;"
			draggable="false"
		/>
		<svg
			bind:this={svgEl}
			viewBox="0 0 {imageWidth} {imageHeight}"
			style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; cursor: {activeTool === 'select' ? 'default' : 'crosshair'};"
			onmousedown={handlePointerDown}
			onmousemove={handlePointerMove}
			onmouseup={handlePointerUp}
			onmouseleave={handlePointerUp}
			ontouchstart={handlePointerDown}
			ontouchmove={handlePointerMove}
			ontouchend={handlePointerUp}
		>
			<!-- Existing shapes -->
			{#each shapes as shape (shape.id)}
				{#if shape.type === 'rect'}
					<rect
						x={shape.x}
						y={shape.y}
						width={shape.width}
						height={shape.height}
						stroke={shape.strokeColor}
						stroke-width={shape.strokeWidth}
						fill={getFillColor(shape)}
						opacity={getShapeOpacity(shape)}
						class={shape.id === selectedId ? 'annotation-selected' : ''}
					/>
				{:else if shape.type === 'arrow'}
					<g opacity={getShapeOpacity(shape)}>
						<line
							x1={shape.x} y1={shape.y}
							x2={shape.endX} y2={shape.endY}
							stroke={shape.strokeColor}
							stroke-width={shape.strokeWidth}
						/>
						<polygon
							points={arrowHead(shape.x, shape.y, shape.endX || 0, shape.endY || 0, shape.strokeWidth || 2)}
							fill={shape.strokeColor}
						/>
					</g>
				{:else if shape.type === 'text'}
					<text
						x={shape.x}
						y={shape.y}
						font-size={shape.fontSize || 16}
						font-family={shape.fontFamily || 'sans-serif'}
						fill={isTransparent(shape.fillColor) ? shape.strokeColor : shape.fillColor}
						opacity={getShapeOpacity(shape)}
						class={shape.id === selectedId ? 'annotation-selected' : ''}
					>{shape.text}</text>
				{:else if shape.type === 'freehand'}
					<path
						d={shape.pathData}
						stroke={shape.strokeColor}
						stroke-width={shape.strokeWidth}
						fill="none"
						opacity={getShapeOpacity(shape)}
						class={shape.id === selectedId ? 'annotation-selected' : ''}
					/>
				{/if}
			{/each}

			<!-- Current drawing shape (while dragging) -->
			{#if currentShape}
				{#if currentShape.type === 'rect'}
					<rect
						x={currentShape.x}
						y={currentShape.y}
						width={currentShape.width}
						height={currentShape.height}
						stroke={currentShape.strokeColor}
						stroke-width={currentShape.strokeWidth}
						fill={getFillColor(currentShape)}
						opacity={0.7}
					/>
				{:else if currentShape.type === 'arrow'}
					<g opacity={0.7}>
						<line
							x1={currentShape.x} y1={currentShape.y}
							x2={currentShape.endX} y2={currentShape.endY}
							stroke={currentShape.strokeColor}
							stroke-width={currentShape.strokeWidth}
						/>
						<polygon
							points={arrowHead(currentShape.x, currentShape.y, currentShape.endX || 0, currentShape.endY || 0, currentShape.strokeWidth || 2)}
							fill={currentShape.strokeColor}
						/>
					</g>
				{:else if currentShape.type === 'freehand'}
					<path
						d={currentShape.pathData}
						stroke={currentShape.strokeColor}
						stroke-width={currentShape.strokeWidth}
						fill="none"
						opacity={0.7}
					/>
				{/if}
			{/if}
		</svg>

		<!-- Text input popup -->
		{#if showTextInput}
			<div
				class="absolute bg-base-100 p-2 shadow-lg rounded border z-10"
				style="left: {textInputPos.x / imageWidth * 100}%; top: {textInputPos.y / imageHeight * 100}%; transform: translate(-50%, -100%);"
			>
				<input
					type="text"
					bind:value={textInput}
					placeholder="Enter text..."
					class="input input-bordered input-sm"
					onkeydown={(e) => { if (e.key === 'Enter') commitText(); if (e.key === 'Escape') showTextInput = false; }}
					autofocus
				/>
				<div class="flex gap-1 mt-1">
					<button class="btn btn-primary btn-xs" onclick={commitText}>Add</button>
					<button class="btn btn-ghost btn-xs" onclick={() => (showTextInput = false)}>Cancel</button>
				</div>
			</div>
		{/if}
	</div>
</div>

<script context="module">
	/**
	 * Compute arrowhead polygon points.
	 * @param {number} x1
	 * @param {number} y1
	 * @param {number} x2
	 * @param {number} y2
	 * @param {number} strokeWidth
	 * @returns {string}
	 */
	function arrowHead(x1, y1, x2, y2, strokeWidth) {
		const angle = Math.atan2(y2 - y1, x2 - x1);
		const headLen = Math.min(12, Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) * 0.3);
		const headAngle = Math.PI / 6;
		const hx1 = x2 - headLen * Math.cos(angle - headAngle);
		const hy1 = y2 - headLen * Math.sin(angle - headAngle);
		const hx2 = x2 - headLen * Math.cos(angle + headAngle);
		const hy2 = y2 - headLen * Math.sin(angle + headAngle);
		return `${x2},${y2} ${hx1},${hy1} ${hx2},${hy2}`;
	}
</script>

<style>
	.annotation-selected {
		outline: 2px dashed #00aaff;
		outline-offset: 2px;
	}

	svg text.annotation-selected {
		outline: 2px dashed #00aaff;
		outline-offset: 2px;
	}
</style>
