import { writable, derived } from 'svelte/store';

/**
 * The GitHub Personal Access Token, loaded from localStorage on init.
 * @type {import('svelte/store').Writable<string|null>}
 */
export const githubToken = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('emmy_gh_token') : null
);

// Persist to localStorage whenever the token changes
githubToken.subscribe((value) => {
	if (typeof localStorage !== 'undefined') {
		if (value) {
			localStorage.setItem('emmy_gh_token', value);
		} else {
			localStorage.removeItem('emmy_gh_token');
		}
	}
});

/**
 * The configured GitHub repo in "owner/repo" format.
 * @type {import('svelte/store').Writable<string|null>}
 */
export const githubRepo = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('emmy_gh_repo') : null
);

githubRepo.subscribe((value) => {
	if (typeof localStorage !== 'undefined') {
		if (value) {
			localStorage.setItem('emmy_gh_repo', value);
		} else {
			localStorage.removeItem('emmy_gh_repo');
		}
	}
});

/** True when both token and repo are configured. */
export const isConnected = derived(
	[githubToken, githubRepo],
	([$token, $repo]) => !!$token && !!$repo
);
