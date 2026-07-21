/**
 * /bake-doctor — diagnose bake pipeline health.
 *
 * Checks:
 *   • State file consistency (corrupted, stale fields)
 *   • Phase file integrity (all files parseable, no circular deps)
 *   • Event log recent errors
 *   • Rules directory structure
 *   • Workspace state
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	bakeCtx,
	BAKE_BASE,
	BAKE_DB_DIR,
	PHASES_DIR,
	RULES_DIR,
	CONFIG_FILE,
} from "./shared.ts";
import type { BakeState } from "../bake.ts";

interface CheckResult {
	label: string;
	ok: boolean;
	detail?: string;
}

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-doctor", {
		description: "Diagnose bake pipeline health — state, phases, deps, logs",
		handler: async (_args, cmdCtx) => {
			const t = cmdCtx.ui.theme;
			const results: CheckResult[] = [];

			// ── 1. State file ──
			const statePath = path.join(BAKE_DB_DIR, "state.json");
			if (!fs.existsSync(statePath)) {
				results.push({
					label: "State file",
					ok: false,
					detail: "not found at .bake/state.json",
				});
			} else {
				try {
					const raw = fs.readFileSync(statePath, "utf-8");
					const state = JSON.parse(raw) as BakeState;
					const validStatuses = ["idle", "running", "paused", "done", "failed"];
					if (!validStatuses.includes(state.status)) {
						results.push({
							label: "State file",
							ok: false,
							detail: `invalid status: ${state.status}`,
						});
					} else if (
						state.status === "running" &&
						state.activePhases?.length === 0
					) {
						results.push({
							label: "State file",
							ok: false,
							detail: "status=running but no active phases",
						});
					} else {
						results.push({
							label: "State file",
							ok: true,
							detail: `status: ${state.status}`,
						});
					}
				} catch (e: any) {
					results.push({
						label: "State file",
						ok: false,
						detail: `parse error: ${e.message}`,
					});
				}
			}

			// ── 2. Phase files ──
			if (!fs.existsSync(PHASES_DIR)) {
				results.push({
					label: "Phase files",
					ok: false,
					detail: "phases/ directory not found",
				});
			} else {
				const files = fs
					.readdirSync(PHASES_DIR)
					.filter((f) => f.endsWith(".md"));
				if (files.length === 0) {
					results.push({
						label: "Phase files",
						ok: true,
						detail: "0 phase files (empty pipeline)",
					});
				} else {
					let parseErrors = 0;
					const phaseIds: string[] = [];
					for (const f of files) {
						const content = fs.readFileSync(path.join(PHASES_DIR, f), "utf-8");
						const idMatch = content.match(/^## Phase ID\n([^\n]+)/m);
						const id = idMatch ? idMatch[1].trim() : f.replace(/\.md$/, "");
						phaseIds.push(id);
						if (
							!content.includes("## Objective") &&
							!content.includes("## Done When")
						) {
							parseErrors++;
						}
					}

					// Check for circular dependencies via DAG manifest
					const dagPath = path.join(PHASES_DIR, "dag.json");
					if (fs.existsSync(dagPath)) {
						try {
							const dag = JSON.parse(
								fs.readFileSync(dagPath, "utf-8"),
							) as Array<{ id: string; depends_on: string[] }>;
							const visited = new Set<string>();
							const stack = new Set<string>();
							const hasCycle = (id: string): boolean => {
								if (stack.has(id)) return true;
								if (visited.has(id)) return false;
								visited.add(id);
								stack.add(id);
								const entry = dag.find((e) => e.id === id);
								if (entry) {
									for (const dep of entry.depends_on) {
										if (hasCycle(dep)) return true;
									}
								}
								stack.delete(id);
								return false;
							};
							const cycle = dag.some((e) => hasCycle(e.id));
							if (cycle) {
								results.push({
									label: "Phase DAG",
									ok: false,
									detail: "circular dependency detected",
								});
							} else {
								results.push({
									label: "Phase DAG",
									ok: true,
									detail: `${dag.length} phases, no cycles`,
								});
							}
						} catch (e: any) {
							results.push({
								label: "Phase DAG",
								ok: false,
								detail: `parse error: ${e.message}`,
							});
						}
					} else {
						results.push({
							label: "Phase DAG",
							ok: true,
							detail: "no dag.json (sequential mode)",
						});
					}

					if (parseErrors > 0) {
						results.push({
							label: "Phase content",
							ok: false,
							detail: `${parseErrors}/${files.length} files missing Objective/Done When`,
						});
					} else {
						results.push({
							label: "Phase content",
							ok: true,
							detail: `${files.length} files, all valid`,
						});
					}
				}
			}

			// ── 3. Rules directory ──
			const rulesBase = path.join(RULES_DIR, "base");
			if (!fs.existsSync(rulesBase)) {
				results.push({
					label: "Rules (ast-grep)",
					ok: false,
					detail: "rules/base/ not found",
				});
			} else {
				const ruleFiles = fs
					.readdirSync(rulesBase)
					.filter((f) => f.endsWith(".yml"));
				results.push({
					label: "Rules (ast-grep)",
					ok: true,
					detail: `${ruleFiles.length} rule files`,
				});
			}

			// ── 4. Event log ──
			const logPath = path.join(BAKE_DB_DIR, "events.jsonl");
			if (fs.existsSync(logPath)) {
				try {
					const lines = fs
						.readFileSync(logPath, "utf-8")
						.trim()
						.split("\n")
						.filter(Boolean);
					const recent = lines.slice(-20);
					const errors = recent.filter(
						(l) =>
							l.includes("fail") ||
							l.includes("crash") ||
							l.includes("error") ||
							l.includes("breaker"),
					);
					if (errors.length > 0) {
						const errorTypes = errors.map((e) => {
							try {
								return JSON.parse(e).type || "unknown";
							} catch {
								return "parse_error";
							}
						});
						results.push({
							label: "Event log",
							ok: false,
							detail: `${errors.length} recent errors: ${[...new Set(errorTypes)].join(", ")}`,
						});
					} else {
						results.push({
							label: "Event log",
							ok: true,
							detail: `${lines.length} events, no recent errors`,
						});
					}
				} catch {
					results.push({
						label: "Event log",
						ok: false,
						detail: "corrupted events.jsonl",
					});
				}
			} else {
				results.push({
					label: "Event log",
					ok: true,
					detail: "no log (no runs yet)",
				});
			}

			// ── 5. Config ──
			if (fs.existsSync(CONFIG_FILE)) {
				try {
					const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
					results.push({
						label: "Config",
						ok: true,
						detail: `widgetMode: ${cfg.widgetMode ?? "unknown"}`,
					});
				} catch {
					results.push({
						label: "Config",
						ok: false,
						detail: "corrupted config.json",
					});
				}
			} else {
				results.push({ label: "Config", ok: true, detail: "defaults" });
			}

			// ── Render ──
			const lines: string[] = [
				t.bold(t.fg("toolTitle", "Bake Doctor Diagnosis")),
				t.fg("dim", `Working directory: ${BAKE_BASE}`),
				"",
			];

			for (const r of results) {
				const icon = r.ok ? t.fg("success", "✓") : t.fg("error", "✗");
				const label = r.ok ? t.fg("text", r.label) : t.fg("error", r.label);
				const detail = r.ok
					? t.fg("dim", `  ${r.detail ?? ""}`)
					: t.fg("warning", `  ${r.detail ?? ""}`);
				lines.push(`  ${icon} ${label}${detail}`);
			}

			lines.push("", t.fg("dim", "Diagnosis complete."));
			cmdCtx.ui.notify(lines.join("\n"), "info");
		},
	});
}
