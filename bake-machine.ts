/**
 * bake-machine — XState v5 orchestration for the bake pipeline.
 *
 * Two typed machines using setup() + createMachine:
 *
 *   PhaseMachine — per-phase: executor → parallel audit → remediate → loop
 *     input:  { spec: PhaseSpec }
 *     output: PhaseResult  { passed, attempts, findings }
 *
 *   BakeMachine  — parent DAG: idle → running → done | failed
 *     spawns PhaseMachine children per ready batch
 *
 * ─── Integration ──────────────────────────────────────────────────
 *
 *   Bake.runPipeline() calls runBakePipeline() which:
 *     1. Creates the BakeMachine
 *     2. createActor → start → send START
 *     3. waitFor(done|failed) → returns { passed, results }
 *     4. Bake maps results → BakeState for UI
 *
 * ─── Hierarchy ────────────────────────────────────────────────────
 *
 *   IDLE ──START──▶ RUNNING
 *                    │  batch loop:
 *                    │    computeReady() → spawnChild(PhaseMachine)
 *                    │    waitFor() each → aggregate
 *                    │    any fail → return false, parent→failed
 *                    │  all pass → return true, parent→done
 *                    │
 *                    │  PhaseMachine states:
 *                    │    EXECUTING
 *                    │    AUDITING (parallel)
 *                    │      ├─ structural (ast-grep)
 *                    │      └─ semantic (LLM)
 *                    │    REMEDIATING ──▶ loop
 *                    │    COMPLETED / FAILED (final, output: PhaseResult)
 */

import { setup, createActor, fromPromise, waitFor } from "xstate";
import type { PhaseSpec } from "./bake.ts";
import type { AuditFinding } from "./auditor.ts";
import type { RpcAgent } from "./rpc-agent.ts";
import type { EventLog } from "./event-log.ts";
import { runExecutor, type ExecutorResult } from "./bake-executor.ts";
import { runStructuralAudit } from "./auditor.ts";
import { runSemanticAudit, runRemediation } from "./bake-audit.ts";

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Internal types (not exported; BakePhaseResult wraps these) ──────

export interface PhaseResult {
	phase: string;
	passed: boolean | "paused";
	attempts: number;
	findings: AuditFinding[];
}

export interface BakeEnv {
	workspaceDir: string;
	rulesDir: string;
	completedDir: string;
	rpcAgent: RpcAgent;
	getEnabledRules: () => Set<string> | undefined;
	onStatus: (msg: string) => void;
	onLoader: (show: boolean, msg: string) => void;
	log: EventLog;
	pendingSteer: () => string | null;
	/**
	 * Called by the XState PROVIDE_CONTEXT action to set steering guidance
	 * through Bake state instead of reassigning the env getter.
	 */
	provideContext: (info: string) => void;
	/**
	 * Atomically consume a retry request for the given phaseId.
	 * Returns true if a retry was pending (and now consumed).
	 */
	consumeRetry: (phaseId: string) => boolean;
	/** Check whether a phase name has been externally skipped (via /bake-skip). */
	isSkipped: (phaseName: string) => boolean;
	maxAttempts: number;
	/**
	 * Called after each batch completes with the current progress.
	 * Bake uses this to update BakeState for the UI widget.
	 */
	onProgress?: (completed: number, total: number, active: string[]) => void;
}

// ─── Phase Machine ───────────────────────────────────────────────────

/**
 * Build a typed, ready-to-run PhaseMachine with all actors wired via closure.
 * input: { spec: PhaseSpec }
 * output: PhaseResult
 *
 * Actors are declared directly in setup() (not via provide()) so that XState
 * v5's TActors type parameter is inferred and src:"execute" resolves correctly.
 */
function phaseMachine(env: BakeEnv) {
	return setup({
		types: {} as {
			input: { spec: PhaseSpec };
			context: {
				spec: PhaseSpec;
				attempt: number;
				maxAttempts: number;
				findings: AuditFinding[];
				concerns: string[];
				blockReason: string | null;
			};
			events: { type: "ABORT" } | { type: "PROVIDE_CONTEXT"; info: string };
			output: PhaseResult;
		},
		actors: {
			execute: fromPromise<
				ExecutorResult,
				{ spec: PhaseSpec; attempt: number; steer: string | null }
			>(async ({ input }) =>
				runExecutor(input.spec, input.attempt, input.steer, {
					workspaceDir: env.workspaceDir,
					rpcAgent: env.rpcAgent,
					log: env.log,
					onStatus: env.onStatus,
					onLoader: env.onLoader,
				}),
			),
			structural: fromPromise<AuditFinding[]>(async () =>
				runStructuralAudit(
					env.workspaceDir,
					env.rulesDir,
					env.getEnabledRules(),
				),
			),
			semantic: fromPromise<AuditFinding[]>(async () =>
				runSemanticAudit({
					workspaceDir: env.workspaceDir,
					rpcAgent: env.rpcAgent,
					onStatus: env.onStatus,
					onLoader: env.onLoader,
					log: env.log,
				}),
			),
			remediate: fromPromise<
				boolean,
				{ spec: PhaseSpec; findings: AuditFinding[]; attempt: number }
			>(async ({ input }) =>
				runRemediation(
					input.spec,
					input.findings,
					input.attempt,
					env.maxAttempts,
					{
						workspaceDir: env.workspaceDir,
						rpcAgent: env.rpcAgent,
						log: env.log,
						onStatus: env.onStatus,
						onLoader: env.onLoader,
					},
				),
			),
		},
	}).createMachine({
		id: "phase",
		initial: "executing",
		context: ({ input }) => ({
			spec: input.spec,
			attempt: 0,
			maxAttempts: env.maxAttempts,
			findings: [],
			concerns: [],
			blockReason: null,
		}),
		states: {
			executing: {
				invoke: {
					src: "execute",
					input: ({ context }) => ({
						spec: context.spec,
						attempt: context.attempt,
						steer: env.pendingSteer(),
					}),
					onDone: [
						{
							guard: ({ event }) => event.output.status === "BLOCKED",
							target: "failed",
							actions: ({ context, event }) => {
								context.blockReason =
									event.output.blockReason ?? "No reason given";
								env.log.append("executor_blocked", {
									phase: context.spec.phaseId,
									reason: context.blockReason,
								});
							},
						},
						{
							guard: ({ event }) => event.output.status === "NEEDS_CONTEXT",
							target: "contextWait",
							actions: ({ context, event }) => {
								context.blockReason =
									event.output.blockReason ?? "No details given";
								env.log.append("executor_needs_context", {
									phase: context.spec.phaseId,
									reason: context.blockReason,
								});
							},
						},
						{
							// DONE or DONE_WITH_CONCERNS → auditing
							target: "auditing",
							actions: ({ context, event }) => {
								if (
									event.output.status === "DONE_WITH_CONCERNS" &&
									event.output.concerns
								) {
									context.concerns = event.output.concerns;
									env.log.append("executor_concerns", {
										phase: context.spec.phaseId,
										concerns: event.output.concerns,
									});
								}
							},
						},
					],
					onError: {
						target: "remediating",
						actions: ({ context }) => {
							context.attempt++;
						},
					},
				},
			},

			/** Operator needs to provide info to unblock this phase. */
			contextWait: {
				on: {
					PROVIDE_CONTEXT: {
						target: "executing",
						actions: ({ context, event }) => {
							context.blockReason = null;
							env.provideContext(event.info);
						},
					},
					ABORT: { target: "failed" },
				},
			},

			auditing: {
				type: "parallel",
				states: {
					structural: {
						initial: "running",
						states: {
							running: {
								invoke: {
									src: "structural",
									onDone: [
										{
											guard: ({ event }) => event.output.length === 0,
											target: "pass",
										},
										{
											target: "fail",
											actions: ({ context, event }) => {
												context.findings.push(...event.output);
											},
										},
									],
									onError: { target: "fail" },
								},
							},
							pass: { type: "final" },
							fail: { type: "final" },
						},
					},
					semantic: {
						initial: "running",
						states: {
							running: {
								invoke: {
									src: "semantic",
									onDone: [
										{
											guard: ({ event }) => event.output.length === 0,
											target: "pass",
										},
										{
											target: "fail",
											actions: ({ context, event }) => {
												context.findings.push(...event.output);
											},
										},
									],
									onError: {
										target: "fail",
										actions: ({ context, event }) => {
											context.findings.push({
												check: 0,
												detail: `Semantic audit crashed: ${(event.error as Error)?.message || "unknown error"}. The audit did not complete.`,
												source: "llm",
											});
										},
									},
								},
							},
							pass: { type: "final" },
							fail: { type: "final" },
						},
					},
				},
				onDone: [
					{
						guard: ({ context }) => context.findings.length === 0,
						target: "completed",
					},
					{ target: "remediating" },
				],
			},

			remediating: {
				invoke: {
					src: "remediate",
					input: ({ context }) => ({
						spec: context.spec,
						findings: context.findings,
						attempt: context.attempt,
					}),
					onDone: [
						{
							guard: ({ event }) => event.output === true,
							target: "executing",
							actions: ({ context }) => {
								context.attempt++;
								context.findings = [];
							},
						},
						{ target: "failed" },
					],
					onError: { target: "failed" },
				},
			},

			completed: {
				type: "final",
				output: ({ context }) => ({
					phase: context.spec.phaseId,
					passed: true as const,
					attempts: context.attempt + 1,
					findings: context.findings,
				}),
			},
			failed: {
				type: "final",
				output: ({ context }) => ({
					phase: context.spec.phaseId,
					passed: false as const,
					attempts: context.attempt + 1,
					findings: context.findings,
				}),
			},
		},
	});
}

// ─── Main entry point ────────────────────────────────────────────────

/**
 * Run the full DAG pipeline with XState orchestration.
 *
 * This runs the DAG batch loop directly (not inside an XState actor)
 * because XState v5's fromPromise does not provide spawnChild in its
 * callback — the scheduling loop must use createActor directly.
 *
 * Steps:
 *   1. Build a single PhaseMachine with actors wired via closure
 *   2. DAG loop: computeReady batch → createActor for each → waitFor done
 *   3. Aggregate results per batch → return passed + results map
 */
export async function runBakePipeline(
	phases: PhaseSpec[],
	env: BakeEnv,
): Promise<{ passed: boolean; results: Record<string, PhaseResult> }> {
	const completedMap: Record<string, PhaseResult> = {};
	const skipped = new Set<string>();

	// Build the wired phase machine (actors wired in setup() via closure)
	const pm = phaseMachine(env);

	const isReady = (p: PhaseSpec): boolean => {
		if (completedMap[p.phaseId] || skipped.has(p.phaseId)) return false;
		return p.dependsOn.every((d) => completedMap[d] || skipped.has(d));
	};

	const allDone = (): boolean =>
		phases.every((p) => completedMap[p.phaseId] || skipped.has(p.phaseId));

	while (!allDone()) {
		const ready = phases.filter(isReady);
		if (ready.length === 0) {
			const stuck = phases.filter(
				(p) => !completedMap[p.phaseId] && !skipped.has(p.phaseId),
			);
			env.log.append("dag_deadlock", { phases: stuck.map((p) => p.phaseId) });
			return { passed: false, results: completedMap };
		}

		env.onStatus?.(`Active: ${ready.map((p) => p.name).join(", ")}`);

		// Create child phase machine actors with createActor (not spawnChild)
		const children = ready.map((r) => createActor(pm, { input: { spec: r } }));

		// Start all children
		children.forEach((c) => c.start());

		// Wait for all to reach final state
		const batchResults = await Promise.allSettled(
			children.map((c) =>
				waitFor(c, (s) => s.status === "done").then(
					(s) => s.output as PhaseResult,
				),
			),
		);

		// Sync external skips (from /bake-skip during batch execution) into local set
		for (const phase of phases) {
			if (env.isSkipped(phase.name)) {
				skipped.add(phase.phaseId);
			}
		}

		// Aggregate
		let batchFailed = false;
		for (let i = 0; i < batchResults.length; i++) {
			const r = batchResults[i];
			const p = ready[i];

			// Phase was externally skipped — don't treat as failure
			if (env.isSkipped(p.name)) {
				skipped.add(p.phaseId);
				env.log.append("phase_externally_skipped", { phase: p.phaseId });
				continue;
			}

			if (r.status === "rejected") {
				// Retry requested for this phase — re-queue by skipping completedMap
				if (env.consumeRetry(p.phaseId)) {
					env.log.append("phase_retry", { phase: p.phaseId });
					continue;
				}
				completedMap[p.phaseId] = {
					phase: p.phaseId,
					passed: false,
					attempts: 0,
					findings: [],
				};
				batchFailed = true;
				env.log.append("phase_crash", {
					phase: p.phaseId,
					error: String(r.reason),
				});
			} else {
				const result = r.value;
				if (result.passed !== true) {
					// Retry requested for this phase — re-queue by skipping completedMap
					if (env.consumeRetry(p.phaseId)) {
						env.log.append("phase_retry", { phase: p.phaseId });
						continue;
					}
					// Phase was externally skipped during execution
					if (env.isSkipped(p.name)) {
						skipped.add(p.phaseId);
						env.log.append("phase_externally_skipped", { phase: p.phaseId });
						continue;
					}
				}
				completedMap[p.phaseId] = result;
				if (result.passed === true) {
					env.log.append("phase_pass", { phase: p.phaseId });
					archivePhaseFile(p, env.completedDir);
				} else {
					batchFailed = true;
					env.log.append("phase_fail", {
						phase: p.phaseId,
						attempts: result.attempts,
					});
				}
			}
		}

		// Notify parent of progress
		const doneCount = Object.keys(completedMap).length;
		env.onProgress?.(
			doneCount,
			phases.length,
			ready.map((r) => r.name),
		);

		if (batchFailed) return { passed: false, results: completedMap };
	}

	return { passed: true, results: completedMap };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function archivePhaseFile(spec: PhaseSpec, completedDir: string): void {
	const dest = path.join(completedDir, `${spec.phaseId}_PASS.md`);
	try {
		fs.copyFileSync(spec.filePath, dest);
		fs.unlinkSync(spec.filePath);
	} catch (err: any) {
		// ENOENT means already archived by a sibling — other errors propagate
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw err;
		}
	}
}
