import { b as writable, v as derived } from "./internal.js";
import "./exports.js";
import "./client.js";
//#region src/lib/stores.js
/**
* The GitHub Personal Access Token, loaded from localStorage on init.
* @type {import('svelte/store').Writable<string|null>}
*/
var githubToken = writable(typeof localStorage !== "undefined" ? localStorage.getItem("emmy_gh_token") : null);
githubToken.subscribe((value) => {
	if (typeof localStorage !== "undefined") try {
		if (value) localStorage.setItem("emmy_gh_token", value);
		else localStorage.removeItem("emmy_gh_token");
	} catch {}
});
/**
* The configured GitHub repo in "owner/repo" format.
* @type {import('svelte/store').Writable<string|null>}
*/
var githubRepo = writable(typeof localStorage !== "undefined" ? localStorage.getItem("emmy_gh_repo") : null);
githubRepo.subscribe((value) => {
	if (typeof localStorage !== "undefined") try {
		if (value) localStorage.setItem("emmy_gh_repo", value);
		else localStorage.removeItem("emmy_gh_repo");
	} catch {}
});
/** True when both token and repo are configured. */
var isConnected = derived([githubToken, githubRepo], ([$token, $repo]) => !!$token && !!$repo);
//#endregion
export { isConnected as n, githubRepo as t };
