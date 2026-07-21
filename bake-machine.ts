/**
 * bake-machine — XState v5 event-driven pipeline orchestration.
 *
 * Two machines:
 *
 *   PhaseMachine  — per-phase: executor → parallel audit → remediate → loop
 *     Events emitted via sendParent:
 *       PHASE_DONE, PHASE_FAILED, PHASE_BLOCKED, PHASE_NEEDS_CTX
 *
 *   BakeMachine   — DAG scheduler: spawns PhaseMachine children as deps clear
 *     Event-driven — each PHASE_DONE triggers spawn of newly-ready phases.
 *     Final states: done | failed (with structured output)
 *
 * ─── Event flow ────────────────────────────────────────────────────
 *
 *   PhaseMachine ──sendParent──▶ BakeMachine
 *     (PHASE_DONE / PHASE_FAILED / PHASE_BLOCKED / PHASE_NEEDS_CTX)
 *
 *   BakeMachine ──sendTo──▶ PhaseMachine (via child ref from snapshot)
 *     (PROVIDE_CONTEXT / ABORT)
 *
 *   Bake ──actor.send──▶ BakeMachine
 *     (START / SKIP_PHASE / RETRY_PHASE / PROVIDE_CONTEXT / STEER / ABORT)
 */

import {
	setup,
	createActor,
	fromPromise,
	waitFor,
	sendParent,
	enqueueActions,
} from "xstate";
import type { PhaseSpec } from "./bake.ts";
import type { AuditFinding } from "./auditor.ts";
import type { RpcAgent } from "./rpc-agent.ts";
import type { EventLog } from "./event-log.ts";
import { runExecutor, type ExecutorResult } from "./bake-executor.ts";
import { runStructuralAudit } from "./auditor.ts";
import { runSemanticAudit, runRemediation } from "./bake-audit.ts";

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Exported types ─────────────────────────────────────────────────

export interface PhaseResult {
	phase: string; // phaseId
	passed: boolean;
	attempts: number;
	findings: AuditFinding[];
}

/** Wired per-run dependencies — passed by closure, not in machine context. */
export interface BakeEnv {
	workspaceDir: string;
	rulesDir: string;
	completedDir: string;
	rpcAgent: RpcAgent;
	getEnabledRules: () => Set<string> | undefined;
	onStatus: (msg: string) => void;
	onLoader: (show: boolean, msg: string) => void;
	log: EventLog;
}

// ─── BakeMachine event types ────────────────────────────────────────

export type BakeEvent =
	| { type: "START" }
	| { type: "PHASE_DONE"; phaseId: string; result: PhaseResult }
	| { type: "PHASE_FAILED"; phaseId: string; result: PhaseResult }
	| { type: "PHASE_BLOCKED"; phaseId: string; reason: string; result: PhaseResult }
	| { type: "PHASE_NEEDS_CTX"; phaseId: string; reason: string }
	| { type: "SKIP_PHASE"; phaseId: string }
	| { type: "RETRY_PHASE"; phaseId: string }
	| { type: "PROVIDE_CONTEXT"; phaseId: string; info: string }
	| { type: "STEER"; message: string }
	| { type: "ABORT" };

interface BakeContext {
	phases: PhaseSpec[];
	completed: Record<string, PhaseResult>;
	skipped: string[]; // phaseIds
	pendingRetry: string[]; // phaseIds
	activePhaseIds: string[];
	waitingPhaseId: string | null;
	pendingSteer: string | null;
	maxAttempts: number;
}

// ─── Phase Machine ───────────────────────────────────────────────────

/**
 * Build a PhaseMachine with all actors wired via closure over env.
 *
 * input:  { spec: PhaseSpec; maxAttempts: number; pendingSteer?: string | null }
 * output: PhaseResult
 *
 * Emits events to parent via sendParent from final states.
 */
function phaseMachine(env: BakeEnv) {
	return setup({
		types: {} as {
			input: {
				spec: PhaseSpec;
				maxAttempts: number;
				pendingSteer?: string | null;
			};
			context: {
				spec: PhaseSpec;
				attempt: number;
				maxAttempts: number;
				findings: AuditFinding[];
				concerns: string[];
				blockReason: string | null;
				pendingSteer: string | null;
			};
			events:
				| { type: "ABORT" }
				| { type: "PROVIDE_CONTEXT"; info: string };
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
				{
					spec: PhaseSpec;
					findings: AuditFinding[];
					attempt: number;
					maxAttempts: number;
				}
			>(async ({ input }) =>
				runRemediation(
					input.spec,
					input.findings,
					input.attempt,
					input.maxAttempts,
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
			maxAttempts: input.maxAttempts,
			findings: [],
			concerns: [],
			blockReason: null,
			pendingSteer: input.pendingSteer ?? null,
		}),
		states: {
			executing: {
				invoke: {
					src: "execute",
					input: ({ context }) => ({
						spec: context.spec,
						attempt: context.attempt,
						steer: context.pendingSteer,
					}),
					onDone: [
						{
							guard: ({ event }) => event.output.status === "BLOCKED",
							target: "blocked",
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
						actions: ({
							context,
							event,
						}) => {
							context.blockReason = null;
							context.pendingSteer = event.info;
							env.log.append("context_provided", {
								phase: context.spec.phaseId,
							});
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
						maxAttempts: context.maxAttempts,
					}),
					onDone: [
						{
							guard: ({ event }) => event.output === true,
							target: "executing",
							actions: ({ context }) => {
								context.attempt++;
								context.findings = [];
								context.pendingSteer = null;
							},
						},
						{ target: "failed" },
					],
					onError: { target: "failed" },
				},
			},

			completed: {
				type: "final",
				entry: sendParent(({ context }) => ({
					type: "PHASE_DONE",
					phaseId: context.spec.phaseId,
					result: {
						phase: context.spec.phaseId,
						passed: true as const,
						attempts: context.attempt + 1,
						findings: context.findings,
					},
				})),
				output: ({ context }) => ({
					phase: context.spec.phaseId,
					passed: true as const,
					attempts: context.attempt + 1,
					findings: context.findings,
				}),
			},

			blocked: {
				type: "final",
				entry: sendParent(({ context }) => ({
					type: "PHASE_BLOCKED",
					phaseId: context.spec.phaseId,
					reason: context.blockReason ?? "Blocked",
					result: {
						phase: context.spec.phaseId,
						passed: false as const,
						attempts: context.attempt + 1,
						findings: context.findings,
					},
				})),
				output: ({ context }) => ({
					phase: context.spec.phaseId,
					passed: false as const,
					attempts: context.attempt + 1,
					findings: context.findings,
				}),
			},

			failed: {
				type: "final",
				entry: sendParent(({ context }) => ({
					type: "PHASE_FAILED",
					phaseId: context.spec.phaseId,
					result: {
						phase: context.spec.phaseId,
						passed: false as const,
						attempts: context.attempt + 1,
						findings: context.findings,
					},
				})),
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

// ─── Bake Machine ───────────────────────────────────────────────────

/**
 * Build the BakeMachine — event-driven DAG scheduler.
 *
 * Spawns PhaseMachine children as their dependency phases complete.
 * Transitions to done/failed when all phases settle.
 * Logs every event for audit trail and crash recovery.
 */
function createBakeMachine(
	phases: PhaseSpec[],
	env: BakeEnv,
	maxAttempts: number,
) {
	const pm = phaseMachine(env);

	return setup({
		types: {} as {
			context: BakeContext;
			events: BakeEvent;
			input: { phases: PhaseSpec[]; maxAttempts: number };
			output: { passed: boolean; results: Record<string, PhaseResult> };
		},
		actors: {
			phase: pm,
		},
		actions: {
			// ── Scheduling ──────────────────────────────────────────────

			spawnReady: enqueueActions(({ enqueue, context }) => {
				const ready = context.phases.filter(
					(p) =>
						!context.completed[p.phaseId] &&
						!context.skipped.includes(p.phaseId) &&
						!context.activePhaseIds.includes(p.phaseId) &&
						p.dependsOn.every(
							(d) =>
								context.completed[d] || context.skipped.includes(d),
						),
				);
				if (ready.length === 0) return;

				const steer = context.pendingSteer;
				for (const spec of ready) {
					enqueue.spawnChild("phase", {
						id: spec.phaseId,
						input: {
							spec,
							maxAttempts: context.maxAttempts,
							pendingSteer: steer,
						},
					});
				}
				enqueue.assign({
					activePhaseIds: [
						...context.activePhaseIds,
						...ready.map((r) => r.phaseId),
					],
					pendingSteer: steer ? null : context.pendingSteer,
				});
				env.log.append("phases_spawned", {
					phases: ready.map((r) => r.phaseId),
				});
			}),

			// ── Event handlers ──────────────────────────────────────────

			recordPhaseDone: enqueueActions(({ enqueue, context, event }) => {
				if (event.type !== "PHASE_DONE") return;
				if (context.completed[event.phaseId]) return; // stale

				const newCompleted = {
					...context.completed,
					[event.phaseId]: event.result,
				};
				const remaining = context.activePhaseIds.filter(
					(id) => id !== event.phaseId,
				);

				// Spawn newly-ready phases whose deps just cleared
				const ready = context.phases.filter(
					(p) =>
						!newCompleted[p.phaseId] &&
						!context.skipped.includes(p.phaseId) &&
						!remaining.includes(p.phaseId) &&
						p.dependsOn.every(
							(d) =>
								newCompleted[d] || context.skipped.includes(d),
						),
				);
				const steer = context.pendingSteer;
				for (const spec of ready) {
					enqueue.spawnChild("phase", {
						id: spec.phaseId,
						input: {
							spec,
							maxAttempts: context.maxAttempts,
							pendingSteer: steer,
						},
					});
				}
				enqueue.assign({
					completed: newCompleted,
					activePhaseIds: [
						...remaining,
						...ready.map((r) => r.phaseId),
					],
					pendingSteer:
						steer && ready.length > 0
							? null
							: context.pendingSteer,
				});
				env.log.append("phase_done", {
					phase: event.phaseId,
					spawned: ready.map((r) => r.phaseId),
				});
			}),

			archivePassedPhase: ({ context, event }) => {
				if (event.type !== "PHASE_DONE") return;
				if (!event.result.passed) return;
				const spec = context.phases.find(
					(p) => p.phaseId === event.phaseId,
				);
				if (spec) archivePhaseFile(spec, env.completedDir);
			},

			handlePhaseFailed: enqueueActions(
				({ enqueue, context, event }) => {
					if (event.type !== "PHASE_FAILED") return;
					if (context.completed[event.phaseId]) return; // stale

					// Retry was queued for this phase — don't record as failed
					if (context.pendingRetry.includes(event.phaseId)) {
						enqueue.assign({
							pendingRetry: context.pendingRetry.filter(
								(id) => id !== event.phaseId,
							),
							activePhaseIds: context.activePhaseIds.filter(
								(id) => id !== event.phaseId,
							),
						});
						env.log.append("phase_retried", {
							phase: event.phaseId,
						});
						return;
					}

					enqueue.assign({
						completed: {
							...context.completed,
							[event.phaseId]: event.result,
						},
						activePhaseIds: context.activePhaseIds.filter(
							(id) => id !== event.phaseId,
						),
					});
					env.log.append("phase_failed", {
						phase: event.phaseId,
						attempts: event.result.attempts,
					});
				},
			),

			handlePhaseBlocked: enqueueActions(
				({ enqueue, context, event }) => {
					if (event.type !== "PHASE_BLOCKED") return;
					if (context.completed[event.phaseId]) return; // stale

					enqueue.assign({
						completed: {
							...context.completed,
							[event.phaseId]: event.result,
						},
						activePhaseIds: context.activePhaseIds.filter(
							(id) => id !== event.phaseId,
						),
					});
					env.log.append("phase_blocked", {
						phase: event.phaseId,
						reason: event.reason,
					});
				},
			),

			markSkipped: enqueueActions(
				({ enqueue, context, event, self }) => {
					if (event.type !== "SKIP_PHASE") return;
					if (context.skipped.includes(event.phaseId)) return;

					// Stop child actor if it's still running
					const childRef =
						self.getSnapshot().children[event.phaseId];
					if (childRef) enqueue.stopChild(childRef);

					enqueue.assign({
						skipped: [...context.skipped, event.phaseId],
						activePhaseIds: context.activePhaseIds.filter(
							(id) => id !== event.phaseId,
						),
					});
					env.log.append("phase_skipped", {
						phase: event.phaseId,
					});
				},
			),

			markRetry: enqueueActions(({ enqueue, context, event, self }) => {
				if (event.type !== "RETRY_PHASE") return;

				// Stop child actor if it's still running
				const childRef = self.getSnapshot().children[event.phaseId];
				if (childRef) enqueue.stopChild(childRef);

				// Cascade: find all phases that transitively depend on the
				// retried phase and remove them from completed too, so they
				// re-run naturally as the DAG re-executes.
				const cascadeSet = new Set<string>();
				const stack = [event.phaseId];
				while (stack.length > 0) {
					const cur = stack.pop()!;
					if (cascadeSet.has(cur)) continue;
					cascadeSet.add(cur);
					for (const p of context.phases) {
						if (
							p.dependsOn.includes(cur) &&
							!cascadeSet.has(p.phaseId)
						) {
							stack.push(p.phaseId);
						}
					}
				}

				// Remove cascaded phases from completed
				const newCompleted = { ...context.completed };
				for (const id of cascadeSet) {
					delete newCompleted[id];
				}

				enqueue.assign({
					completed: newCompleted,
					pendingRetry: [
						...context.pendingRetry,
						event.phaseId,
					],
					activePhaseIds: context.activePhaseIds.filter(
						(id) => !cascadeSet.has(id),
					),
				});
				env.log.append("retry_queued", {
					phase: event.phaseId,
					cascade: [...cascadeSet].filter(
						(id) => id !== event.phaseId,
					),
				});
			}),

			storeCtxWaiter: enqueueActions(({ enqueue, context, event }) => {
				if (event.type !== "PHASE_NEEDS_CTX") return;
				enqueue.assign({ waitingPhaseId: event.phaseId });
				env.log.append("awaiting_context", {
					phase: event.phaseId,
					reason: event.reason,
				});
			}),

			forwardContext: enqueueActions(({ enqueue, self, event }) => {
				if (event.type !== "PROVIDE_CONTEXT") return;
				const childRef =
					self.getSnapshot().children[event.phaseId];
				if (childRef) {
					enqueue.sendTo(childRef, {
						type: "PROVIDE_CONTEXT",
						info: event.info,
					});
				}
				enqueue.assign({ waitingPhaseId: null });
				env.log.append("context_forwarded", {
					phase: event.phaseId,
				});
			}),

			storeSteer: enqueueActions(({ enqueue, context, event }) => {
				if (event.type !== "STEER") return;
				enqueue.assign({ pendingSteer: event.message });
				env.log.append("steer_stored", { message: event.message });
			}),
		},
		guards: {
			allDone: ({ context }) =>
				context.phases.every(
					(p) =>
						context.completed[p.phaseId] ||
						context.skipped.includes(p.phaseId),
				),

			anyFailed: ({ context }) =>
				Object.values(context.completed).some(
					(r) => r.passed === false,
				),

			dagDeadlocked: ({ context }) => {
				const remaining = context.phases.filter(
					(p) =>
						!context.completed[p.phaseId] &&
						!context.skipped.includes(p.phaseId),
				);
				if (remaining.length === 0) return false;
				// Deadlocked if no remaining phase has all its deps satisfied
				return remaining.every(
					(p) =>
						!p.dependsOn.every(
							(d) =>
								context.completed[d] ||
								context.skipped.includes(d),
						),
				);
			},
		},
	}).createMachine({
		id: "bake",
		initial: "idle",
		context: ({ input }) => ({
			phases: input.phases,
			completed: {},
			skipped: [],
			pendingRetry: [],
			activePhaseIds: [],
			waitingPhaseId: null,
			pendingSteer: null,
			maxAttempts: input.maxAttempts,
		}),
		states: {
			idle: {
				on: { START: "running" },
			},

			/** Main scheduling loop — spawns phases as deps clear. */
			running: {
				entry: "spawnReady",
				on: {
					PHASE_DONE: {
						actions: ["recordPhaseDone", "archivePassedPhase"],
						target: "running",
					},
					PHASE_FAILED: {
						actions: "handlePhaseFailed",
						target: "running",
					},
					// BLOCKED is unrecoverable — stop the pipeline immediately
					PHASE_BLOCKED: {
						actions: "handlePhaseBlocked",
						target: "failed",
					},
					PHASE_NEEDS_CTX: {
						actions: "storeCtxWaiter",
						target: "awaitingCtx",
					},
					// Self-transition: re-run spawnReady on entry
					SKIP_PHASE: {
						actions: "markSkipped",
						target: "running",
					},
					RETRY_PHASE: {
						actions: "markRetry",
						target: "running",
					},
					STEER: { actions: "storeSteer" },
					ABORT: { target: "failed" },
				},
				always: [
					{ guard: "anyFailed", target: "failed" },
					{ guard: "allDone", target: "done" },
					{ guard: "dagDeadlocked", target: "failed" },
				],
			},

			/** Waiting for human context via PROVIDE_CONTEXT. */
			awaitingCtx: {
				on: {
					PROVIDE_CONTEXT: {
						actions: "forwardContext",
						target: "running",
					},
					// Other phases can still complete while we wait
					PHASE_DONE: {
						actions: ["recordPhaseDone", "archivePassedPhase"],
					},
					PHASE_FAILED: { actions: "handlePhaseFailed" },
					PHASE_BLOCKED: { actions: "handlePhaseBlocked" },
					SKIP_PHASE: {
						actions: "markSkipped",
						target: "running",
					},
					RETRY_PHASE: {
						actions: "markRetry",
						target: "running",
					},
					STEER: { actions: "storeSteer" },
					ABORT: { target: "failed" },
				},
				always: [
					{ guard: "anyFailed", target: "failed" },
					{ guard: "allDone", target: "done" },
					{ guard: "dagDeadlocked", target: "failed" },
				],
			},

			done: {
				type: "final",
				output: ({ context }) => ({
					passed: true,
					results: context.completed,
				}),
			},

			failed: {
				type: "final",
				output: ({ context }) => ({
					passed: false,
					results: context.completed,
				}),
			},
		},
	});
}

// ─── Public API ─────────────────────────────────────────────────────

/** Shape of the BakeMachine context exposed to the Bake shell class. */
export interface BakeContextSnapshot {
	completed: Record<string, PhaseResult>;
	skipped: string[];
	activePhaseIds: string[];
	waitingPhaseId: string | null;
}

/** Minimal actor interface — no xstate internals leaked to callers. */
export interface BakeMachineActor {
	send(event: BakeEvent): void;
	subscribe(observer: {
		next?: (snapshot: {
			context: BakeContextSnapshot;
			status: string;
			output?: { passed: boolean; results: Record<string, PhaseResult> };
		}) => void;
		error?: (err: unknown) => void;
	}): { unsubscribe: () => void };
	start(): void;
	stop(): void;
	getSnapshot(): {
		context: BakeContextSnapshot;
		status: string;
		output?: { passed: boolean; results: Record<string, PhaseResult> };
	};
}

/**
 * Create and start a BakePipeline actor.
 *
 * Returns the actor reference and a promise that resolves to the pipeline
 * output. The actor is already started with the START event sent.
 */
export function startBakePipeline(
	phases: PhaseSpec[],
	env: BakeEnv,
	maxAttempts: number,
): {
	actor: BakeMachineActor;
	done: Promise<{ passed: boolean; results: Record<string, PhaseResult> }>;
} {
	const machine = createBakeMachine(phases, env, maxAttempts);
	const actor = createActor(machine, {
		input: { phases, maxAttempts },
	});

	actor.start();
	actor.send({ type: "START" });

	const done = waitFor(actor, (s) => s.status === "done").then(
		(s) =>
			s.output as {
				passed: boolean;
				results: Record<string, PhaseResult>;
			},
	);

	// Return via the clean interface — no xstate types exposed
	return { actor: actor as unknown as BakeMachineActor, done };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function archivePhaseFile(spec: PhaseSpec, completedDir: string): void {
	const dest = path.join(completedDir, `${spec.phaseId}_PASS.md`);
	try {
		fs.copyFileSync(spec.filePath, dest);
		fs.unlinkSync(spec.filePath);
	} catch (err: any) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw err;
		}
	}
}
