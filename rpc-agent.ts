/**
 * RPC Agent — long-lived subprocess wrapper for pi --mode rpc.
 *
 * Spawns a single `pi --mode rpc --no-session` subprocess and communicates
 * via JSONL over stdin/stdout. Provides session isolation via `newSession()`
 * (~35ms in-memory reset) and full text collection via `prompt()`.
 *
 * Architecture:
 *   Main pi (bake) ←→ RPC subprocess (pi --mode rpc --no-session)
 *   - new_session per operation for context isolation
 *   - text_delta streaming for real-time output
 *   - agent_settled signals operation completion
 *
 * Protocol:
 *   Send:   {"type":"new_session"} | {"type":"prompt","message":"..."} | {"type":"abort"}
 *   Receive: response, agent_start, message_update (text_delta), agent_end, agent_settled
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface RpcAgentOptions {
	/** Working directory for the RPC subprocess (default: process.cwd()) */
	cwd?: string;
	/** Disable extension loading in subprocess (default: true) */
	noExtensions?: boolean;
	/** Timeout per prompt operation in ms (default: no timeout) */
	promptTimeout?: number;
}

type PromiseCallbacks = {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
};

/**
 * Wraps a long-lived `pi --mode rpc` subprocess.
 *
 * Usage:
 *   const agent = new RpcAgent({ cwd: workspaceDir });
 *   agent.start();
 *   await agent.newSession();
 *   const output = await agent.prompt("Hello");
 *   agent.close();
 */
export class RpcAgent {
	private proc: ChildProcess | null = null;
	private buffer = "";
	private pendingResponse: Map<string, PromiseCallbacks> = new Map();
	/** Listeners for message_update / text_delta events */
	private deltaListeners: Array<(delta: string) => void> = [];
	/** Resolvers waiting for agent_settled (array supports edge case of concurrent waits) */
	private settledResolvers: Array<PromiseCallbacks> = [];
	/** Whether the process has been explicitly started */
	private started = false;
	private options: RpcAgentOptions;

	constructor(options: RpcAgentOptions = {}) {
		this.options = {
			cwd: process.cwd(),
			noExtensions: true,
			...options,
		};
	}

	/**
	 * Start the RPC subprocess. Idempotent — safe to call multiple times.
	 * The subprocess starts in a fresh state, ready for new_session.
	 */
	start(): void {
		if (this.started) return;
		this.started = true;

		const args = ["--mode", "rpc", "--no-session"];
		if (this.options.noExtensions !== false) {
			args.push("--no-extensions");
		}

		this.proc = spawn("pi", args, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: this.options.cwd,
		});

		this.proc.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString();
			let idx: number;
			while ((idx = this.buffer.indexOf("\n")) !== -1) {
				const line = this.buffer.slice(0, idx);
				this.buffer = this.buffer.slice(idx + 1);
				try {
					const msg = JSON.parse(line);
					this.handleMessage(msg);
				} catch {
					// Skip malformed JSON lines
				}
			}
		});

		this.proc.on("error", (err) => {
			this.proc = null;
			this.started = false;
			const wrapped = new Error(`RPC process spawn error: ${err.message}`);
			for (const [, cb] of this.pendingResponse) {
				cb.reject(wrapped);
			}
			this.pendingResponse.clear();
			const resolvers = this.settledResolvers;
			this.settledResolvers = [];
			for (const cb of resolvers) {
				cb.reject(wrapped);
			}
		});

		this.proc.on("exit", (code, signal) => {
			this.proc = null;
			this.started = false;
			const err = new Error(
				`RPC process exited unexpectedly (code=${code}, signal=${signal})`,
			);
			// Reject any pending promise
			for (const [, cb] of this.pendingResponse) {
				cb.reject(err);
			}
			this.pendingResponse.clear();
			// Reject any pending settled waits — crash means partial output is unreliable
			const resolvers = this.settledResolvers;
			this.settledResolvers = [];
			for (const cb of resolvers) {
				cb.reject(err);
			}
		});
	}

	/**
	 * Ensure the subprocess is running. Restart if crashed.
	 */
	private ensureRunning(): void {
		if (!this.started || !this.proc) {
			this.start();
		}
	}

	/**
	 * Handle an incoming JSON message from the RPC subprocess.
	 */
	private handleMessage(msg: Record<string, unknown>): void {
		const type = msg.type as string;

		if (type === "response") {
			const id = msg.id as string | undefined;
			if (id && this.pendingResponse.has(id)) {
				const { resolve } = this.pendingResponse.get(id)!;
				this.pendingResponse.delete(id);
				resolve(msg);
			}
		}

		if (type === "message_update") {
			const event = msg.assistantMessageEvent as
				| { type: string; delta?: string }
				| undefined;
			if (event?.type === "text_delta" && event.delta) {
				// Fire all delta listeners
				for (const cb of this.deltaListeners) {
					cb(event.delta);
				}
			}
		}

		if (type === "agent_settled") {
			// Fire all settled resolvers
			const resolvers = this.settledResolvers;
			this.settledResolvers = [];
			for (const cb of resolvers) {
				cb.resolve(undefined);
			}
		}
	}

	/**
	 * Send a JSON command to the RPC subprocess and wait for the response.
	 * Automatically assigns an id for correlation.
	 */
	private sendCommand(
		command: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		this.ensureRunning();
		return new Promise((resolve, reject) => {
			const id = String(Date.now()) + "-" + String(Math.random()).slice(2, 8);
			const msg = { ...command, id };
			this.pendingResponse.set(id, { resolve, reject });
			this.proc!.stdin!.write(JSON.stringify(msg) + "\n");
		});
	}

	// ─── Public API ─────────────────────────────────────────────────────

	/**
	 * Reset the session context. Fast (~35ms) — just an in-memory reset,
	 * no extension reload or process spawn.
	 *
	 * Call this between operations to ensure context isolation.
	 */
	async newSession(): Promise<void> {
		const resp = await this.sendCommand({ type: "new_session" });
		if (resp.success !== true) {
			throw new Error(`new_session failed: ${JSON.stringify(resp)}`);
		}
	}

	/**
	 * Send a prompt to the RPC agent and collect the full text output.
	 *
	 * @param text - The prompt text to send
	 * @param onDelta - Optional callback invoked with each text_delta as it arrives
	 * @param options - Optional: { signal?: AbortSignal } for cancellation
	 * @returns The complete text output once agent_settled fires
	 *
	 * The method:
	 *   1. Sends the prompt command
	 *   2. Collects text_delta events into a buffer
	 *   3. Waits for agent_settled
	 *   4. Returns the joined text
	 *
	 * If timeout is set (via options.promptTimeout), the operation is aborted
	 * after the timeout expires.
	 */
	async prompt(
		text: string,
		onDelta?: (delta: string) => void,
		options?: { signal?: AbortSignal },
	): Promise<string> {
		// Fast-fail if already aborted
		if (options?.signal?.aborted) {
			throw new Error("Prompt aborted before start");
		}

		// Register for text deltas
		const deltas: string[] = [];

		const deltaHandler = (delta: string) => {
			deltas.push(delta);
			onDelta?.(delta);
		};
		this.deltaListeners.push(deltaHandler);

		// Set up settled promise
		const settled = new Promise<void>((resolve, reject) => {
			this.settledResolvers.push({ resolve, reject });
		});

		// Wire up AbortSignal
		const onAbort = () => {
			// Send abort to subprocess (best-effort)
			this.abort();
			// Force-reject any pending operations so they don't hang
			const err = new Error("Prompt aborted via signal");
			const resolvers = this.settledResolvers;
			this.settledResolvers = [];
			for (const cb of resolvers) {
				cb.reject(err);
			}
			for (const [, cb] of this.pendingResponse) {
				cb.reject(err);
			}
			this.pendingResponse.clear();
		};

		let abortListener: (() => void) | null = null;
		if (options?.signal) {
			options.signal.addEventListener("abort", onAbort, { once: true });
			abortListener = () =>
				options.signal?.removeEventListener("abort", onAbort);
		}

		try {
			// 1. Send the prompt command and wait for response (accepted)
			const resp = await this.sendCommand({
				type: "prompt",
				message: text,
			});

			if (resp.success !== true) {
				throw new Error(`prompt command rejected: ${JSON.stringify(resp)}`);
			}

			// 2. Wait for agent_settled (with optional timeout)
			if (this.options.promptTimeout && this.options.promptTimeout > 0) {
				const timeout = new Promise<never>((_, reject) => {
					setTimeout(
						() =>
							reject(
								new Error(
									`Prompt timed out after ${this.options.promptTimeout}ms`,
								),
							),
						this.options.promptTimeout,
					);
				});
				await Promise.race([settled, timeout]);
			} else {
				await settled;
			}

			// 3. Return collected text
			return deltas.join("");
		} finally {
			// Clean up listeners
			this.deltaListeners = this.deltaListeners.filter(
				(cb) => cb !== deltaHandler,
			);
			if (abortListener) abortListener();
		}
	}

	/**
	 * Abort the current operation. Call this to cancel a stuck prompt.
	 * After abort, call newSession() to reset before the next prompt.
	 *
	 * Sends the abort message to the subprocess AND force-rejects any
	 * pending promises so callers don't hang even if the subprocess
	 * doesn't respond to the abort.
	 */
	abort(): void {
		if (this.proc?.stdin?.writable) {
			this.proc.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
		}
		// Force-reject any pending operations so they don't hang
		const err = new Error("Aborted by caller");
		const resolvers = this.settledResolvers;
		this.settledResolvers = [];
		for (const cb of resolvers) {
			cb.reject(err);
		}
		for (const [, cb] of this.pendingResponse) {
			cb.reject(err);
		}
		this.pendingResponse.clear();
	}

	/**
	 * Close the RPC subprocess. Call when done (pipeline complete, shutdown).
	 */
	close(): void {
		if (this.proc) {
			this.proc.stdin?.end();
			this.proc = null;
			this.started = false;
		}
	}
}
