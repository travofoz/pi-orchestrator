import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			// GitHub Pages serves from a subpath if the repo name isn't the root domain.
			// Set GITHUB_REPOSITORY env var (e.g. "user/emmy") to use a subpath; otherwise
			// defaults to "" (root). Docs: https://kit.svelte.dev/docs/adapter-static
			pages: 'build',
			assets: 'build',
			fallback: '404.html',
			precompress: false,
			strict: true
		}),
		paths: {
			// If deployed to a subpath (user.github.io/emmy), set the base here.
			// The GitHub Pages deploy workflow writes the repo name into this file
			// before building. Default "" means serving from root (custom domain or org page).
			base: process.env.GITHUB_REPOSITORY
				? '/' + process.env.GITHUB_REPOSITORY.split('/')[1]
				: ''
		}
	}
};

export default config;
