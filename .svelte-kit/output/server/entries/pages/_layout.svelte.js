import { c as store_get, m as escape_html, u as unsubscribe_stores } from "../../chunks/internal.js";
import { n as isConnected, t as githubRepo } from "../../chunks/stores.js";
//#region src/routes/+layout.svelte
function _layout($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		/** @type {import('svelte').Snippet} */
		let { children } = $$props;
		$$renderer.push(`<div class="min-h-screen bg-base-200"><div class="navbar bg-base-100 shadow-sm px-4"><div class="flex-1"><button class="text-xl font-bold cursor-pointer">Emmy</button></div> <div class="flex-none gap-2">`);
		if (store_get($$store_subs ??= {}, "$isConnected", isConnected)) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span class="text-sm text-base-content/60 hidden sm:inline">${escape_html(store_get($$store_subs ??= {}, "$githubRepo", githubRepo))}</span> <button class="btn btn-ghost btn-sm">Disconnect</button>`);
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<button class="btn btn-primary btn-sm">Connect GitHub</button>`);
		}
		$$renderer.push(`<!--]--></div></div> <main class="p-4 max-w-6xl mx-auto">`);
		children($$renderer);
		$$renderer.push(`<!----></main></div> `);
		$$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]-->`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
export { _layout as default };
