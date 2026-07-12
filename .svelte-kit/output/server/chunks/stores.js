import { S as writable, b as derived } from "./server.js";
import "./index-server.js";
//#region src/lib/stores.js
/**
* The GitHub Personal Access Token, loaded from localStorage on init.
* @type {import('svelte/store').Writable<string|null>}
*/
var githubToken = writable(typeof localStorage !== "undefined" ? localStorage.getItem("emmy_gh_token") : null);
githubToken.subscribe((value) => {
	if (typeof localStorage !== "undefined") if (value) localStorage.setItem("emmy_gh_token", value);
	else localStorage.removeItem("emmy_gh_token");
});
/**
* The configured GitHub repo in "owner/repo" format.
* @type {import('svelte/store').Writable<string|null>}
*/
var githubRepo = writable(typeof localStorage !== "undefined" ? localStorage.getItem("emmy_gh_repo") : null);
githubRepo.subscribe((value) => {
	if (typeof localStorage !== "undefined") if (value) localStorage.setItem("emmy_gh_repo", value);
	else localStorage.removeItem("emmy_gh_repo");
});
/** True when both token and repo are configured. */
var isConnected = derived([githubToken, githubRepo], ([$token, $repo]) => !!$token && !!$repo);
//#endregion
export { isConnected as n, githubRepo as t };
