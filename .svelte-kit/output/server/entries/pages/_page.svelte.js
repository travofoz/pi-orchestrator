import { a as unsubscribe_stores, n as ensure_array_like, v as escape_html } from "../../chunks/server.js";
import "../../chunks/stores.js";
//#region src/routes/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		/** @type {Array<{ name: string, type: string, path: string, sha: string }>} */
		let images = [];
		$$renderer.push(`<div class="space-y-4"><div class="flex items-center justify-between"><h2 class="text-2xl font-bold">Gallery</h2> <button class="btn btn-primary btn-sm">Refresh</button></div> `);
		if (images.length === 0) {
			$$renderer.push("<!--[2-->");
			$$renderer.push(`<div class="text-center py-12 text-base-content/50"><p class="text-lg">No images yet.</p> <p class="text-sm mt-2">Your /images/ directory is empty or doesn't exist yet.</p></div>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"><!--[-->`);
			const each_array = ensure_array_like(images);
			for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
				let img = each_array[$$index];
				$$renderer.push(`<div class="card bg-base-100 shadow-sm"><div class="card-body p-3"><p class="card-title text-sm truncate">${escape_html(img.name)}</p> <p class="text-xs text-base-content/50 truncate">${escape_html(img.path)}</p></div></div>`);
			}
			$$renderer.push(`<!--]--></div>`);
		}
		$$renderer.push(`<!--]--></div>`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
export { _page as default };
