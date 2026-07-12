<script>
	import { goto } from '$app/navigation';
	import { githubToken, githubRepo } from '$lib/stores.js';
	import { fetchGallery } from '$lib/gallery.js';
	import { createClient, parseRepo } from '$lib/github.js';
	import { encodeGIF, estimateGifSize, exportAndCommitGIF } from '$lib/gif-export.js';
	import { renderAnnotationsSVG } from '$lib/annotations.js';

	/** @type {import('$lib/gallery.js').GalleryEntry[]} */
	let allEntries = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Slide builder
	/** @type {Array<{ entry: import('$lib/gallery.js').GalleryEntry, delay: number }>} */
	let slides = $state([]);

	// Preview
	let previewIndex = $state(0);
	let isPlaying = $state(false);
	let playInterval = $state(null);

	// Export
	let exporting = $state(false);
	let exportError = $state('');
	let exportSuccess = $state('');
	let defaultDelay = $state(2500); // ms
	let scaleFactor = $state(1);

	// Available images (non-GIF entries)
	let availableImages = $derived(allEntries.filter((e) => e.type === 'image'));

	// Selected entry in the "add" dropdown
	let selectedEntryId = $state('');

	$effect(() => {
		if ($githubToken && $githubRepo) {
			loadEntries();
		}
	});

	async function loadEntries() {
		loading = true;
		error = '';
		try {
			allEntries = await fetchGallery($githubToken, $githubRepo);
		} catch (err) {
			error = err.message || 'Failed to load gallery';
		} finally {
			loading = false;
		}
	}

	function addSlide() {
		if (!selectedEntryId) return;
		const entry = availableImages.find((e) => e.id === selectedEntryId);
		if (!entry) return;
		// Don't add duplicates
		if (slides.some((s) => s.entry.id === entry.id)) return;
		slides = [...slides, { entry, delay: defaultDelay }];
		selectedEntryId = '';
	}

	function removeSlide(index) {
		slides = slides.filter((_, i) => i !== index);
		if (previewIndex >= slides.length) previewIndex = Math.max(0, slides.length - 1);
	}

	function moveSlide(from, to) {
		if (to < 0 || to >= slides.length) return;
		const newSlides = [...slides];
		const [moved] = newSlides.splice(from, 1);
		newSlides.splice(to, 0, moved);
		slides = newSlides;
	}

	function togglePlay() {
		if (isPlaying) {
			stopPlay();
		} else {
			startPlay();
		}
	}

	function startPlay() {
		if (slides.length === 0) return;
		isPlaying = true;
		previewIndex = 0;
		playInterval = setInterval(() => {
			const nextIndex = (previewIndex + 1) % slides.length;
			if (nextIndex === 0) stopPlay(); // Stop after one loop
			else previewIndex = nextIndex;
		}, slides[previewIndex]?.delay || defaultDelay);
	}

	function stopPlay() {
		isPlaying = false;
		if (playInterval) {
			clearInterval(playInterval);
			playInterval = null;
		}
	}

	// Estimate size
	let sizeEstimate = $derived(
		slides.length > 0
			? estimateGifSize(
					slides.map((s) => ({
						imageUrl: s.entry.rawUrl,
						width: s.entry.width,
						height: s.entry.height,
						annotations: s.entry.annotations,
						delay: s.delay,
						id: s.entry.id
					})),
					20
				)
			: { willBeLarge: false, estimatedMB: 0, suggestedScale: 1 }
	);

	async function handleExport() {
		if (slides.length === 0) return;
		exporting = true;
		exportError = '';
		exportSuccess = '';

		try {
			const octokit = createClient($githubToken);
			const parsed = parseRepo($githubRepo);
			if (!octokit || !parsed) {
				exportError = 'GitHub not connected.';
				return;
			}

			const slideData = slides.map((s) => ({
				imageUrl: s.entry.rawUrl,
				width: s.entry.width,
				height: s.entry.height,
				annotations: s.entry.annotations || null,
				delay: s.delay,
				id: s.entry.id
			}));

			const result = await exportAndCommitGIF(octokit, parsed.owner, parsed.repo, slideData, {
				tags: ['gif'],
				caption: `GIF from ${slides.length} slides`,
				scale: scaleFactor
			});

			exportSuccess = `GIF exported: ${result.gifUrl}`;

			// Offer download too
			const a = document.createElement('a');
			a.href = URL.createObjectURL(result.blob);
			a.download = `${result.id}.gif`;
			a.click();
			URL.revokeObjectURL(a.href);
		} catch (err) {
			exportError = err.message || 'Export failed';
		} finally {
			exporting = false;
		}
	}

	function formatDelay(ms) {
		return (ms / 1000).toFixed(1) + 's';
	}

	/**
	 * Render annotation SVG markup for the overlay.
	 * @param {import('$lib/gallery.js').GalleryEntry} entry
	 * @returns {string}
	 */
	function annotationSVG(entry) {
		if (!entry.annotations || !Array.isArray(entry.annotations) || entry.annotations.length === 0) return '';
		return renderAnnotationsSVG(entry.annotations, entry.width, entry.height);
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<a href="/" class="btn btn-ghost btn-sm">← Back</a>
			<h2 class="text-2xl font-bold">Slideshow Builder</h2>
		</div>
	</div>

	{#if loading}
		<div class="flex justify-center py-12">
			<span class="loading loading-spinner loading-lg"></span>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else}
		<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
			<!-- Left: Available images + add panel -->
			<div class="lg:col-span-1 space-y-4">
				<div class="card bg-base-100 shadow-sm">
					<div class="card-body p-4">
						<h3 class="font-semibold mb-2">Add Slides</h3>
						<div class="flex gap-2">
							<select
								bind:value={selectedEntryId}
								class="select select-bordered select-sm flex-1"
							>
								<option value="">Select an image...</option>
								{#each availableImages as entry}
									<option value={entry.id} disabled={slides.some((s) => s.entry.id === entry.id)}>
										{entry.caption || entry.id} ({entry.tags.join(', ')})
									</option>
								{/each}
							</select>
							<button class="btn btn-primary btn-sm" onclick={addSlide} disabled={!selectedEntryId}>Add</button>
						</div>

						<div class="mt-4">
							<label class="label">
								<span class="label-text">Default slide duration</span>
							</label>
							<input
								type="range"
								min="500"
								max="10000"
								step="100"
								bind:value={defaultDelay}
								class="range range-xs"
							/>
							<div class="flex justify-between text-xs text-base-content/50 mt-1">
								<span>0.5s</span>
								<span>{formatDelay(defaultDelay)}</span>
								<span>10s</span>
							</div>
						</div>

						<div class="mt-4">
							<label class="label">
								<span class="label-text">Export scale: {scaleFactor}x</span>
							</label>
							<input
								type="range"
								min="0.25"
								max="1"
								step="0.05"
								bind:value={scaleFactor}
								class="range range-xs"
							/>
							<div class="flex justify-between text-xs text-base-content/50 mt-1">
								<span>0.25x</span>
								<span>1x</span>
							</div>
						</div>

						{#if sizeEstimate.willBeLarge}
							<div class="alert alert-warning text-sm mt-2">
								Estimated GIF size: ~{sizeEstimate.estimatedMB} MB. Consider reducing scale or number of slides.
							</div>
						{/if}
					</div>
				</div>
			</div>

			<!-- Right: Slides list + preview -->
			<div class="lg:col-span-2 space-y-4">
				<!-- Slides list -->
				<div class="card bg-base-100 shadow-sm">
					<div class="card-body p-4">
						<h3 class="font-semibold mb-2">Slides ({slides.length})</h3>

						{#if slides.length === 0}
							<p class="text-sm text-base-content/50 py-4 text-center">
								Add images from the left panel to build your slideshow.
							</p>
						{:else}
							<div class="space-y-2 max-h-96 overflow-y-auto">
								{#each slides as slide, i}
									<div class="flex items-center gap-3 p-2 bg-base-200 rounded-lg {i === previewIndex ? 'ring-2 ring-primary' : ''}">
										<span class="text-sm font-mono w-6 text-center">{i + 1}</span>
										<img
											src={slide.entry.rawUrl}
											alt={slide.entry.id}
											class="w-12 h-12 rounded object-cover"
										/>
										<div class="flex-1 min-w-0">
											<p class="text-sm truncate">{slide.entry.caption || slide.entry.id}</p>
											<p class="text-xs text-base-content/50">{slide.entry.width}&times;{slide.entry.height}</p>
										</div>
										<input
											type="number"
											bind:value={slide.delay}
											class="input input-bordered input-xs w-20"
											min="100"
											max="30000"
											step="100"
											title="Delay in ms"
										/>
										<div class="flex gap-1">
											<button class="btn btn-ghost btn-xs" onclick={() => moveSlide(i, i - 1)} disabled={i === 0}>↑</button>
											<button class="btn btn-ghost btn-xs" onclick={() => moveSlide(i, i + 1)} disabled={i === slides.length - 1}>↓</button>
											<button class="btn btn-ghost btn-xs text-error" onclick={() => removeSlide(i)}>✕</button>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>

				<!-- Preview -->
				{#if slides.length > 0}
					<div class="card bg-base-100 shadow-sm">
						<div class="card-body p-4">
							<h3 class="font-semibold mb-2">Preview</h3>
							<div class="relative bg-base-300 rounded flex items-center justify-center" style="min-height: 200px;">
								<img
									src={slides[previewIndex].entry.rawUrl}
									alt={slides[previewIndex].entry.id}
									class="max-w-full max-h-96 rounded"
									style="max-height: 400px; object-fit: contain;"
								/>
								{#if slides[previewIndex].entry.annotations && slides[previewIndex].entry.annotations.length > 0}
									<svg
										viewBox="0 0 {slides[previewIndex].entry.width} {slides[previewIndex].entry.height}"
										class="absolute inset-0 w-full h-full pointer-events-none"
									>
										{@html annotationSVG(slides[previewIndex].entry)}
									</svg>
								{/if}
								<!-- Slide number badge -->
								<div class="absolute bottom-2 right-2 badge badge-lg">
									{previewIndex + 1} / {slides.length}
								</div>
								<!-- Duration badge -->
								<div class="absolute bottom-2 left-2 badge badge-ghost">
									{formatDelay(slides[previewIndex].delay)}
								</div>
							</div>

							<div class="flex gap-2 mt-3 justify-center">
								<button class="btn btn-sm" onclick={() => previewIndex = Math.max(0, previewIndex - 1)} disabled={previewIndex === 0 || isPlaying}>
									◀ Previous
								</button>
								<button class="btn btn-sm {isPlaying ? 'btn-warning' : 'btn-primary'}" onclick={togglePlay}>
									{isPlaying ? '⏸ Pause' : '▶ Play'}
								</button>
								<button class="btn btn-sm" onclick={() => { if (previewIndex < slides.length - 1) previewIndex++; }} disabled={previewIndex === slides.length - 1 || isPlaying}>
									Next ▶
								</button>
							</div>
						</div>
					</div>
				{/if}

				<!-- Export -->
				{#if slides.length > 0}
					<div class="card bg-base-100 shadow-sm">
						<div class="card-body p-4">
							<h3 class="font-semibold mb-2">Export</h3>
							{#if exportError}
								<div class="alert alert-error text-sm mb-2">{exportError}</div>
							{/if}
							{#if exportSuccess}
								<div class="alert alert-success text-sm mb-2">{exportSuccess}</div>
							{/if}
							<div class="flex gap-2">
								<button
									class="btn btn-primary"
									onclick={handleExport}
									disabled={exporting || slides.length === 0}
								>
									{#if exporting}
										<span class="loading loading-spinner loading-xs"></span>
									{/if}
									Export &amp; Upload GIF
								</button>
							</div>
							<p class="text-xs text-base-content/50 mt-2">
								The GIF will be committed to /images/ and appear in your gallery.
							</p>
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
