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

	function disconnect() {
		githubToken.set(null);
		githubRepo.set(null);
	}

	function saveConnect(e) {
		e.preventDefault();
		connectError = '';
		if (!tokenInput.trim()) {
			connectError = 'Token is required.';
			return;
		}
		if (!repoInput.trim() || !repoInput.trim().includes('/')) {
			connectError = 'Enter a repo in "owner/repo" format.';
			return;
		}
		githubToken.set(tokenInput.trim());
		githubRepo.set(repoInput.trim());
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
			{#if $isConnected}
				<span class="text-sm text-base-content/60 hidden sm:inline">
					{$githubRepo}
				</span>
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
		{#if !$isConnected}
			<div class="hero min-h-[60vh]">
				<div class="hero-content text-center">
					<div class="max-w-md">
						<h1 class="text-4xl font-bold mb-4">Emmy</h1>
						<p class="text-base-content/70 mb-6">
							Lightweight image hosting and sharing for GitHub.
							Upload screenshots, tag them, annotate, and stitch them into GIFs.
						</p>
						<button class="btn btn-primary btn-lg" onclick={openConnectModal}>
							Connect GitHub to get started
						</button>
					</div>
				</div>
			</div>
		{:else}
			{@render children()}
		{/if}
	</main>
</div>

<!-- Connect Modal -->
{#if showConnectModal}
	<div class="modal modal-open">
		<div class="modal-box">
			<h3 class="font-bold text-lg mb-4">Connect to GitHub</h3>

			<div class="alert alert-info mb-4 text-sm">
				<span>
					Emmy uses a GitHub Personal Access Token (classic) with
					<strong>repo</strong> scope to read and write files in your repository.
					The token is stored in your browser's localStorage and never sent anywhere
					except directly to the GitHub API.
					<br /><br />
					<strong>Security note:</strong> Storing a write-scoped token in localStorage
					is more exposed to XSS attacks than session-only storage would be. This is
					acceptable here because Emmy is a <em>single-user, personal tool</em> — you
					control the entire codebase. Do not use this approach in a multi-user app.
				</span>
			</div>

			<a
				href="https://github.com/settings/tokens/new?scopes=repo&description=Emmy"
				target="_blank"
				rel="noopener noreferrer"
				class="link link-primary text-sm mb-4 inline-block"
			>
				Generate a token on GitHub (opens new tab) →
			</a>

			{#if connectError}
				<div class="alert alert-error text-sm mb-3">{connectError}</div>
			{/if}

			<div class="form-control mb-3">
				<label class="label" for="gh-token-input">
					<span class="label-text">GitHub Token</span>
				</label>
				<input
					id="gh-token-input"
					type="password"
					bind:value={tokenInput}
					placeholder="ghp_..."
					class="input input-bordered w-full"
				/>
			</div>

			<div class="form-control mb-4">
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
			</div>

			<div class="modal-action">
				<button type="button" class="btn btn-ghost" onclick={() => (showConnectModal = false)}>Cancel</button>
				<button type="button" class="btn btn-primary" onclick={saveConnect}>Connect</button>
			</div>
		</div>
	</div>
{/if}
