<script>
	import { githubToken, githubRepo } from '$lib/stores.js';
	import { createClient, parseRepo, listDir } from '$lib/github.js';

	/** @type {Array<{ name: string, type: string, path: string, sha: string }>} */
	let images = $state([]);
	let loading = $state(false);
	let error = $state('');

	$effect(() => {
		if ($githubToken && $githubRepo) {
			loadGallery();
		}
	});

	async function loadGallery() {
		loading = true;
		error = '';
		try {
			const octokit = createClient($githubToken);
			const parsed = parseRepo($githubRepo);
			if (!octokit || !parsed) return;

			const items = await listDir(octokit, parsed.owner, parsed.repo, 'images');
			// Filter to only JSON metadata files for display
			images = items.filter((item) => item.name.endsWith('.json'));
		} catch (err) {
			if (err.status === 404) {
				// /images/ directory doesn't exist yet
				images = [];
			} else {
				error = err.message || 'Failed to load gallery';
			}
		} finally {
			loading = false;
		}
	}
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<h2 class="text-2xl font-bold">Gallery</h2>
		<button class="btn btn-primary btn-sm" onclick={loadGallery}>
			Refresh
		</button>
	</div>

	{#if loading}
		<div class="flex justify-center py-12">
			<span class="loading loading-spinner loading-lg"></span>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if images.length === 0}
		<div class="text-center py-12 text-base-content/50">
			<p class="text-lg">No images yet.</p>
			<p class="text-sm mt-2">Your /images/ directory is empty or doesn't exist yet.</p>
		</div>
	{:else}
		<div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
			{#each images as img}
				<div class="card bg-base-100 shadow-sm">
					<div class="card-body p-3">
						<p class="card-title text-sm truncate">{img.name}</p>
						<p class="text-xs text-base-content/50 truncate">{img.path}</p>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
