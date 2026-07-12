import { S as escape_html, l as html, n as derived, o as stringify, r as ensure_array_like, s as unsubscribe_stores, t as attr_style, x as attr } from "../../chunks/server.js";
import "../../chunks/stores.js";
import "../../chunks/navigation.js";
//#region src/lib/gallery.js
/**
* Filter gallery entries by tag (case-insensitive) and/or search text (in caption/id/tags).
*
* @param {GalleryEntry[]} entries
* @param {object} filters
* @param {string} [filters.tagFilter]
* @param {string} [filters.searchQuery]
* @returns {GalleryEntry[]}
*/
function filterGallery(entries, filters = {}) {
	let result = [...entries];
	if (filters.tagFilter) {
		const tag = filters.tagFilter.toLowerCase();
		result = result.filter((e) => e.tags.some((t) => t.toLowerCase() === tag));
	}
	if (filters.searchQuery) {
		const q = filters.searchQuery.toLowerCase();
		result = result.filter((e) => e.id.toLowerCase().includes(q) || e.caption.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)));
	}
	return result;
}
//#endregion
//#region src/lib/annotations.js
/**
* Default shape styles.
*/
var DEFAULT_STYLES = {
	strokeColor: "#ff0000",
	strokeWidth: 2,
	fillColor: "transparent",
	opacity: 1,
	fontSize: 16,
	fontFamily: "sans-serif"
};
/**
* Check if a color string represents transparency (no fill).
* @param {string} color
* @returns {boolean}
*/
function isTransparent(color) {
	return !color || color === "transparent" || color === "none" || color === "rgba(0,0,0,0)";
}
/**
* Render annotations as SVG markup.
* @param {AnnotationShape[]} annotations
* @param {number} imageWidth
* @param {number} imageHeight
* @returns {string} SVG markup string
*/
function renderAnnotationsSVG(annotations, imageWidth, imageHeight) {
	if (!annotations || annotations.length === 0) return "";
	return annotations.map((shape) => renderShapeSVG(shape)).join("\n");
}
/**
* Render a single shape as an SVG element string.
* @param {AnnotationShape} shape
* @returns {string}
*/
function renderShapeSVG(shape) {
	const style = `stroke="${shape.strokeColor || DEFAULT_STYLES.strokeColor}" stroke-width="${shape.strokeWidth || DEFAULT_STYLES.strokeWidth}" fill="${isTransparent(shape.fillColor) ? "none" : shape.fillColor}" opacity="${shape.opacity ?? DEFAULT_STYLES.opacity}"`;
	switch (shape.type) {
		case "rect": return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" ${style} />`;
		case "arrow": {
			const dx = (shape.endX || 0) - shape.x;
			const dy = (shape.endY || 0) - shape.y;
			const angle = Math.atan2(dy, dx);
			const headLen = Math.min(12, Math.sqrt(dx * dx + dy * dy) * .3);
			const headAngle = Math.PI / 6;
			const x1 = shape.x;
			const y1 = shape.y;
			const x2 = shape.endX || 0;
			const y2 = shape.endY || 0;
			const hx1 = x2 - headLen * Math.cos(angle - headAngle);
			const hy1 = y2 - headLen * Math.sin(angle - headAngle);
			const hx2 = x2 - headLen * Math.cos(angle + headAngle);
			const hy2 = y2 - headLen * Math.sin(angle + headAngle);
			return [`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${style} />`, `<polygon points="${x2},${y2} ${hx1},${hy1} ${hx2},${hy2}" ${style} />`].join("\n");
		}
		case "text": return `<text x="${shape.x}" y="${shape.y}" font-size="${shape.fontSize || DEFAULT_STYLES.fontSize}" font-family="${shape.fontFamily || DEFAULT_STYLES.fontFamily}" ${style}>${escapeXML(shape.text || "")}</text>`;
		case "freehand": return `<path d="${shape.pathData || ""}" ${style} fill="none" />`;
		default: return "";
	}
}
/**
* Escape XML entities for safe SVG text content.
* @param {string} s
* @returns {string}
*/
function escapeXML(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
//#endregion
//#region src/routes/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		/** @type {import('$lib/gallery.js').GalleryEntry[]} */
		let entries = [];
		let tagFilter = "";
		let searchQuery = "";
		let copiedId = "";
		let deletingId = "";
		let allTags = derived(() => [...new Set(entries.flatMap((e) => e.tags))].sort());
		let filteredEntries = derived(() => filterGallery(entries, {
			tagFilter: void 0,
			searchQuery: void 0
		}));
		function formatDate(iso) {
			try {
				return new Date(iso).toLocaleDateString(void 0, {
					year: "numeric",
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit"
				});
			} catch {
				return iso;
			}
		}
		/**
		* Render annotation SVG for embedding in HTML (sanitized).
		* @param {import('$lib/gallery.js').GalleryEntry} entry
		* @returns {string}
		*/
		function annotationOverlaySVG(entry) {
			if (!entry.annotations || !Array.isArray(entry.annotations) || entry.annotations.length === 0) return "";
			return renderAnnotationsSVG(entry.annotations, entry.width, entry.height);
		}
		$$renderer.push(`<div class="space-y-6"><div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"><h2 class="text-2xl font-bold">Gallery</h2> <div class="flex gap-2"><a href="/slideshow" class="btn btn-primary btn-sm">Create GIF</a> <button class="btn btn-ghost btn-sm">Refresh</button></div></div> <div class="collapse collapse-arrow bg-base-100 border border-base-300"><input type="checkbox"/> <div class="collapse-title font-medium">Upload Image</div> <div class="collapse-content">`);
		$$renderer.push("<!--[0-->");
		$$renderer.push(`<div class="flex items-center justify-center w-full"><label for="file-upload" class="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-lg cursor-pointer hover:bg-base-200"><div class="flex flex-col items-center justify-center pt-5 pb-6"><svg class="w-8 h-8 mb-2 text-base-content/50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg> <p class="mb-2 text-sm text-base-content/50"><span class="font-semibold">Click to select</span> or drag and drop</p> <p class="text-xs text-base-content/40">PNG, JPG, JPEG, GIF, WebP</p></div> <input id="file-upload" type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden"/></label></div>`);
		$$renderer.push(`<!--]--></div></div> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <div class="flex flex-col sm:flex-row gap-3"><div class="flex-1"><input type="text"${attr("value", searchQuery)} placeholder="Search by caption, id, or tag..." class="input input-bordered input-sm w-full"/></div> <div class="w-full sm:w-48">`);
		$$renderer.select({
			value: tagFilter,
			class: "select select-bordered select-sm w-full"
		}, ($$renderer) => {
			$$renderer.option({ value: "" }, ($$renderer) => {
				$$renderer.push(`All tags`);
			});
			$$renderer.push(`<!--[-->`);
			const each_array = ensure_array_like(allTags());
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let tag = each_array[$$index];
				$$renderer.option({ value: tag }, ($$renderer) => {
					$$renderer.push(`${escape_html(tag)}`);
				});
			}
			$$renderer.push(`<!--]-->`);
		});
		$$renderer.push(`</div></div> `);
		if (filteredEntries().length === 0) {
			$$renderer.push("<!--[2-->");
			$$renderer.push(`<div class="text-center py-12 text-base-content/50"><p class="text-lg">`);
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`No images yet. Upload one above!`);
			$$renderer.push(`<!--]--></p></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"><!--[-->`);
			const each_array_1 = ensure_array_like(filteredEntries());
			for (let $$index_2 = 0, $$length = each_array_1.length; $$index_2 < $$length; $$index_2++) {
				let entry = each_array_1[$$index_2];
				$$renderer.push(`<div class="card bg-base-100 shadow-sm hover:shadow-md transition-shadow"><figure class="px-3 pt-3 relative"><div class="relative w-full"${attr_style(`aspect-ratio: ${stringify(entry.width)} / ${stringify(entry.height)}; max-height: 160px;`)}><img${attr("src", entry.rawUrl)}${attr("alt", entry.caption || entry.id)} class="rounded object-contain w-full h-full" loading="lazy" style="cursor: pointer;"/> `);
				if (entry.annotations && entry.annotations.length > 0) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<svg${attr("viewBox", `0 0 ${stringify(entry.width)} ${stringify(entry.height)}`)} class="absolute inset-0 w-full h-full pointer-events-none" style="top: 0; left: 0;">${html(annotationOverlaySVG(entry))}</svg>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--></div></figure> <div class="card-body p-3"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><p class="card-title text-sm truncate"${attr("title", entry.id)}>${escape_html(entry.caption || entry.id)}</p> <p class="text-xs text-base-content/50">${escape_html(entry.type)} · ${escape_html(entry.width)}×${escape_html(entry.height)}</p> <p class="text-xs text-base-content/40">${escape_html(formatDate(entry.createdAt))}</p></div></div> `);
				if (entry.tags.length > 0) {
					$$renderer.push("<!--[0-->");
					$$renderer.push(`<div class="flex flex-wrap gap-1 mt-1"><!--[-->`);
					const each_array_2 = ensure_array_like(entry.tags);
					for (let $$index_1 = 0, $$length = each_array_2.length; $$index_1 < $$length; $$index_1++) {
						let tag = each_array_2[$$index_1];
						$$renderer.push(`<span class="badge badge-sm badge-ghost">${escape_html(tag)}</span>`);
					}
					$$renderer.push(`<!--]--></div>`);
				} else $$renderer.push("<!--[-1-->");
				$$renderer.push(`<!--]--> <div class="flex gap-1 mt-2 flex-wrap"><button class="btn btn-ghost btn-xs">${escape_html(copiedId === entry.rawUrl ? "Copied!" : "Copy Link")}</button> <button class="btn btn-ghost btn-xs">Annotate</button> <button class="btn btn-ghost btn-xs">View</button> <button class="btn btn-ghost btn-xs text-error"${attr("disabled", deletingId === entry.id, true)}>${escape_html(deletingId === entry.id ? "Deleting…" : "Delete")}</button></div></div></div>`);
			}
			$$renderer.push(`<!--]--></div>`);
		}
		$$renderer.push(`<!--]--> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></div> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]-->`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
export { _page as default };
