<script>
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import AnnotationEditor from '$lib/components/AnnotationEditor.svelte';
	import { onDestroy } from 'svelte';
	import { githubToken, githubRepo } from '$lib/stores.js';
	import { createClient, parseRepo, getFile, putFile, getDefaultBranch, rawFileUrl } from '$lib/github.js';

	let id = $derived($page.params.id);

	let loading = $state(true);
	let error = $state('');
	let saving = $state(false);

	/** @type {import('$lib/gallery.js').GalleryEntry|null} */
	let entry = $state(null);

	/** @type {import('$lib/annotations.js').AnnotationShape[]} */
	let shapes = $state([]);

	let imageUrl = $state('');
	let destroyed = $state(false);

	onDestroy(() => {
		destroyed = true;
	});

	$effect(() => {
		if (id && $githubToken && $githubRepo) {
			loadImage();
		}
	});

	async function loadImage() {
		loading = true;
		error = '';
		try {
			const octokit = createClient($githubToken);
			const parsed = parseRepo($githubRepo);
			if (!octokit || !parsed) {
				if (!destroyed) error = 'GitHub not connected.';
				return;
			}

			const { owner, repo } = parsed;
			const branch = await getDefaultBranch(octokit, owner, repo);

			// Read the JSON metadata file
			const jsonPath = `images/${id}.json`;
			const result = await getFile(octokit, owner, repo, jsonPath);
			if (!result) {
				if (!destroyed) error = `Metadata not found for ${id}`;
				return;
			}

			const data = JSON.parse(result.content);
			if (!destroyed) {
				entry = {
					...data,
					jsonPath,
					imagePath: `images/${data.filename}`,
					rawUrl: rawFileUrl(owner, repo, branch, `images/${data.filename}`),
					_sha: result.sha // store sha for updating
				};

				imageUrl = entry.rawUrl;

				// Load annotations
				if (data.annotations && Array.isArray(data.annotations)) {
					shapes = data.annotations;
				}
			}
		} catch (err) {
			if (!destroyed) error = err.message || 'Failed to load image';
		} finally {
			if (!destroyed) loading = false;
		}
	}

	async function saveAnnotations() {
		if (!entry) return;
		saving = true;
		error = '';

		try {
			const octokit = createClient($githubToken);
			const parsed = parseRepo($githubRepo);
			if (!octokit || !parsed) return;

			const updatedMetadata = {
				...entry,
				annotations: shapes.length > 0 ? shapes.map((s) => ({ ...s })) : null
			};
			delete updatedMetadata._sha;
			delete updatedMetadata.jsonPath;
			delete updatedMetadata.imagePath;
			delete updatedMetadata.rawUrl;

			const jsonContent = JSON.stringify(updatedMetadata, null, 2);

			await putFile(
				octokit, parsed.owner, parsed.repo,
				entry.jsonPath,
				jsonContent,
				`Update annotations for ${entry.filename}`,
				entry._sha
			);

			// Go back to gallery
			goto('/');
		} catch (err) {
			error = err.message || 'Failed to save annotations';
		} finally {
			saving = false;
		}
	}
</script>

<div class="space-y-4">
	<!-- Navigation -->
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<button class="btn btn-ghost btn-sm" onclick={() => goto('/')}>← Back</button>
			<h2 class="text-xl font-bold">
				Annotate: {entry?.caption || entry?.id || id}
			</h2>
		</div>
		<div class="flex gap-2">
			<button class="btn btn-primary btn-sm" onclick={saveAnnotations} disabled={saving || loading}>
				{#if saving}
					<span class="loading loading-spinner loading-xs"></span>
				{/if}
				Save
			</button>
		</div>
	</div>

	{#if loading}
		<div class="flex justify-center py-12">
			<span class="loading loading-spinner loading-lg"></span>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if entry}
		<AnnotationEditor
			bind:shapes
			imageWidth={entry.width}
			imageHeight={entry.height}
			imageUrl={imageUrl}
		/>
	{/if}
</div>
