<script>
	import '../app.css';
	import { goto } from '$app/navigation';
	import { githubToken, githubRepo, isConnected } from '$lib/stores.js';

	/** @type {import('svelte').Snippet} */
	let { children } = $props();

	let showConnectModal = $state(false);
	let tokenInput = $state('');
	let repoInput = $state('');
	let connectError = $state('');

	function openConnectModal() {
		tokenInput = '';
		repoInput = '';
		connectError = '';
		showConnectModal = true;
	}

	// Listen for custom event from child pages that want to trigger connect
	$effect(() => {
		function handler() { openConnectModal(); }
		window.addEventListener('open-connect', handler);
		return () => window.removeEventListener('open-connect', handler);
	});

	function disconnect() {
		githubToken.set(null);
		githubRepo.set(null);
	}

	function addToken() {
		tokenInput = '';
		repoInput = $githubRepo || '';
		connectError = '';
		showConnectModal = true;
	}

	let hasRepoWithoutToken = $derived(!!$githubRepo && !$githubToken);

	function saveConnect(e) {
		e.preventDefault();
		connectError = '';
		if (!repoInput.trim() || !repoInput.trim().includes('/')) {
			connectError = 'Enter a repo in "owner/repo" format.';
			return;
		}
		githubRepo.set(repoInput.trim());
		if (tokenInput.trim()) {
			githubToken.set(tokenInput.trim());
		}
		showConnectModal = false;
	}
</script>

<div class="min-h-screen bg-base-200">
	<!-- Navbar -->
	<div class="navbar bg-base-100 shadow-sm px-4">
		<div class="flex-1">
			<button class="text-xl font-bold cursor-pointer" onclick={() => goto('/')}>Emmy</button>
		</div>
		<div class="flex-none gap-2">
			{#if $githubRepo}
				<span class="text-sm text-base-content/60 hidden sm:inline">
					{$githubRepo}
					{#if !$githubToken}
						<span class="badge badge-ghost badge-xs ml-1">read-only</span>
					{/if}
				</span>
				{#if hasRepoWithoutToken}
					<button class="btn btn-ghost btn-sm" onclick={addToken}>
						Add Token
					</button>
				{/if}
				<button class="btn btn-ghost btn-sm" onclick={disconnect}>
					Disconnect
				</button>
			{:else}
				<button class="btn btn-primary btn-sm" onclick={openConnectModal}>
					Connect GitHub
				</button>
			{/if}
		</div>
	</div>

	<!-- Main content -->
	<main class="p-4 max-w-6xl mx-auto">
		{@render children()}
	</main>
</div>

<!-- Connect Modal -->
{#if showConnectModal}
	<div class="modal modal-open">
		<div class="modal-box">
			<h3 class="font-bold text-lg mb-4">Connect to GitHub</h3>

			<div class="alert alert-info mb-4 text-sm">
				<span>
					<strong>Read-only browsing works without a token.</strong> Just enter a public
					repo name below — no authentication needed to view the gallery.
					<br /><br />
					To upload images, add annotations, or export GIFs, you'll also need a
					GitHub Personal Access Token (classic) with <strong>repo</strong> scope.
					The token is stored in your browser's localStorage and never sent anywhere
					except directly to the GitHub API.
					<br /><br />
					<strong>Security note:</strong> Storing a write-scoped token in localStorage
					is more exposed to XSS attacks than session-only storage would be. This is
					acceptable here because Emmy is a <em>single-user, personal tool</em> — you
					control the entire codebase. Do not use this approach in a multi-user app.
				</span>
			</div>

			{#if connectError}
				<div class="alert alert-error text-sm mb-3">{connectError}</div>
			{/if}

			<form onsubmit={saveConnect}>
				<div class="form-control mb-3">
					<label class="label" for="gh-repo-input">
						<span class="label-text">Repository (owner/repo)</span>
					</label>
					<input
						id="gh-repo-input"
						type="text"
						bind:value={repoInput}
						placeholder="your-username/emmy"
						class="input input-bordered w-full"
					/>
					<label class="label">
						<span class="label-text-alt text-base-content/60">Required. The public repo to browse.</span>
					</label>
				</div>

				<div class="form-control mb-4">
					<label class="label" for="gh-token-input">
						<span class="label-text">GitHub Token <span class="text-base-content/50">(optional for read-only)</span></span>
					</label>
					<input
						id="gh-token-input"
						type="password"
						bind:value={tokenInput}
						placeholder="ghp_... or leave blank to browse"
						class="input input-bordered w-full"
					/>
					<label class="label">
						<span class="label-text-alt">
							<a
								href="https://github.com/settings/tokens/new?scopes=repo&description=Emmy"
								target="_blank"
								rel="noopener noreferrer"
								class="link link-primary text-xs"
							>
								Generate a token on GitHub (opens new tab) →
							</a>
						</span>
					</label>
				</div>

				<div class="modal-action">
					<button type="button" class="btn btn-ghost" onclick={() => (showConnectModal = false)}>Cancel</button>
					<button type="submit" class="btn btn-primary">Connect</button>
				</div>
			</form>
		</div>
	</div>
{/if}
