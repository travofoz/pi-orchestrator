import { Octokit } from 'octokit';

/**
 * @typedef {import('octokit').Octokit} OctokitInstance
 */

/**
 * Create an Octokit client from a GitHub Personal Access Token.
 * Returns null if no token is provided.
 * @param {string} token - GitHub PAT
 * @returns {OctokitInstance|null}
 */
export function createClient(token) {
	if (!token) return null;
	return new Octokit({ auth: token });
}

/**
 * Parse "owner/repo" string into { owner, repo }.
 * @param {string} repoString
 * @returns {{ owner: string, repo: string }|null}
 */
export function parseRepo(repoString) {
	if (!repoString) return null;
	const parts = repoString.split('/');
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return { owner: parts[0], repo: parts[1] };
}

/**
 * Get the contents of a single file from the repo.
 * Returns decoded content + sha (for updates) if found, null if 404.
 *
 * @param {OctokitInstance} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} path - file path within the repo
 * @returns {Promise<{ content: string, sha: string }|null>}
 */
export async function getFile(octokit, owner, repo, path) {
	try {
		const resp = await octokit.rest.repos.getContent({
			owner,
			repo,
			path
		});
		const data = resp.data;
		if ('content' in data && 'sha' in data) {
			return {
				content: Buffer.from(data.content, 'base64').toString('utf-8'),
				sha: data.sha
			};
		}
		return null; // directory listing, not a file
	} catch (err) {
		if (err.status === 404) return null;
		throw err;
	}
}

/**
 * Create or update a file in the repo.
 * If sha is provided, it updates an existing file; otherwise creates a new one.
 *
 * @param {OctokitInstance} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} path
 * @param {string} content - raw string content (will be base64-encoded)
 * @param {string} message - commit message
 * @param {string} [sha] - sha of existing file (for updates)
 * @returns {Promise<{ sha: string, commit: object }>}
 */
export async function putFile(octokit, owner, repo, path, content, message, sha) {
	const resp = await octokit.rest.repos.createOrUpdateFileContents({
		owner,
		repo,
		path,
		message,
		content: Buffer.from(content, 'utf-8').toString('base64'),
		sha
	});
	return {
		sha: resp.data.content.sha,
		commit: resp.data.commit
	};
}

/**
 * Put a binary file (e.g. image) into the repo.
 * Accepts a base64-encoded string directly.
 *
 * @param {OctokitInstance} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} path
 * @param {string} base64Content - raw base64 content (without data: URL prefix)
 * @param {string} message - commit message
 * @param {string} [sha] - sha of existing file (for updates)
 * @returns {Promise<{ sha: string, commit: object }>}
 */
export async function putBinaryFile(octokit, owner, repo, path, base64Content, message, sha) {
	const resp = await octokit.rest.repos.createOrUpdateFileContents({
		owner,
		repo,
		path,
		message,
		content: base64Content,
		sha
	});
	return {
		sha: resp.data.content.sha,
		commit: resp.data.commit
	};
}

/**
 * List the contents of a directory in the repo.
 * Returns an array of items with name, type, path, sha, etc.
 *
 * @param {OctokitInstance} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} path - directory path
 * @returns {Promise<Array<{ name: string, type: string, path: string, sha: string, size?: number }>>}
 */
export async function listDir(octokit, owner, repo, path) {
	const resp = await octokit.rest.repos.getContent({
		owner,
		repo,
		path
	});
	const data = resp.data;
	if (!Array.isArray(data)) {
		// It's a single file, not a directory
		return [];
	}
	return data.map((item) => ({
		name: item.name,
		type: item.type,
		path: item.path,
		sha: item.sha,
		size: 'size' in item ? item.size : undefined
	}));
}

/**
 * Search the repo for files matching a query.
 * Useful for finding images by tag, etc.
 *
 * @param {OctokitInstance} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} query - GitHub code search query
 * @returns {Promise<Array<{ name: string, path: string, sha: string }>>}
 */
export async function searchRepo(octokit, owner, repo, query) {
	const fullQuery = `repo:${owner}/${repo} ${query}`;
	const resp = await octokit.rest.search.code({
		q: fullQuery
	});
	return resp.data.items.map((item) => ({
		name: item.name,
		path: item.path,
		sha: item.sha
	}));
}

/**
 * Get the SHA of the latest commit on the default branch.
 * Used as a reference for creating blobs/trees if needed.
 *
 * @param {OctokitInstance} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<string|null>}
 */
export async function getLatestCommitSha(octokit, owner, repo) {
	try {
		const resp = await octokit.rest.repos.getCommit({
			owner,
			repo,
			ref: 'HEAD'
		});
		return resp.data.sha;
	} catch {
		// Repo may be empty (no commits yet)
		return null;
	}
}
