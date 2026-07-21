/**
 * Audit & Remediation — structural/semantic checks + fix cycles.
 *
 * Extracted from Bake.runSemanticAudit() and Bake.runRemediation()
 * for module separation. Takes all dependencies explicitly.
 */

import type { AuditFinding } from "./auditor.ts";
import {
	buildSemanticAuditPrompt,
	parseSemanticAuditOutput,
} from "./auditor.ts";
import type { RpcAgent } from "./rpc-agent.ts";
import type { EventLog } from "./event-log.ts";
import type { PhaseSpec } from "./bake.ts";
import type { ExecutorDeps } from "./bake-executor.ts";

/**
 * Run a semantic audit: invoke the LLM via RPC with the structured checklist.
 *
 * @returns Array of findings (empty = pass).
 * @throws On RPC failure so the XState machine routes to onError (never silently passes).
 */
export async function runSemanticAudit(deps: {
	workspaceDir: string;
	rpcAgent: RpcAgent;
	onStatus: (msg: string) => void;
	onLoader: (show: boolean, msg: string) => void;
	log: EventLog;
}): Promise<AuditFinding[]> {
	const prompt = buildSemanticAuditPrompt(deps.workspaceDir);

	deps.onStatus?.("Audit: semantic check (LLM)");
	deps.onLoader?.(true, "Audit: semantic check (LLM)");

	// Fresh context for audit
	await deps.rpcAgent.newSession();

	let previewBuf = "";
	let lastStatusUpdate = 0;
	const output = await deps.rpcAgent.prompt(prompt, (delta) => {
		previewBuf += delta;
		const now = Date.now();
		if (now - lastStatusUpdate > 300) {
			lastStatusUpdate = now;
			const preview = previewBuf.trimEnd().slice(-80).replace(/\n/g, " ");
			deps.onStatus?.(`Audit (LLM)  ➜ ${preview}`);
		}
	});

	deps.log.append("semantic_audit_complete", { outputLength: output.length });
	const auditResult = parseSemanticAuditOutput(output);
	return auditResult.findings;
}

/**
 * Generate and run a remediation cycle via RPC.
 *
 * Builds a task list from findings and runs the executor in remediation
 * mode. Returns true if remediation was applied (loop should retry audit),
 * false if it should circuit-break.
 */
export async function runRemediation(
	phase: PhaseSpec,
	findings: AuditFinding[],
	currentAttempt: number,
	maxAttempts: number,
	deps: ExecutorDeps,
): Promise<boolean> {
	deps.log.append("remediation_start", {
		phase: phase.name,
		attempt: currentAttempt,
		findings: findings.length,
	});

	// Build remediation spec from findings
	const findingItems = findings
		.map((f, i) => {
			const prefix = f.source === "ast-grep" ? "[ast-grep]" : "[audit]";
			return `${i + 1}. ${prefix} ${f.detail}`;
		})
		.join("\n");

	const remediationSpec = `# Remediation ${currentAttempt + 1}: ${phase.name}\n\n## Tasks\n\n${findingItems}\n\nFix each of the above issues. After fixing, run the build to verify.`;

	// Run executor with remediation focus
	const executorPrompt = `The following issues were found in the project at ${deps.workspaceDir}. Fix each one specifically.\n\n${remediationSpec}\n\nAfter fixing each issue, commit with a descriptive message. Run build/lint/test to verify.\n\nUse ast-grep (sg) to verify your fixes structurally. For example: sg scan -r rules/ . to scan for regressions, or sg -p '<pattern>' . to check specific patterns before committing.`;

	deps.onStatus?.(`Remediation: ${phase.name} (attempt ${currentAttempt + 1})`);
	deps.onLoader?.(
		true,
		`Remediation: ${phase.name} (attempt ${currentAttempt + 1})`,
	);

	try {
		// Fresh context for remediation
		await deps.rpcAgent.newSession();

		let previewBuf = "";
		let lastStatusUpdate = 0;
		const output = await deps.rpcAgent.prompt(executorPrompt, (delta) => {
			previewBuf += delta;
			const now = Date.now();
			if (now - lastStatusUpdate > 300) {
				lastStatusUpdate = now;
				const preview = previewBuf.trimEnd().slice(-80).replace(/\n/g, " ");
				deps.onStatus?.(`Remediation: ${phase.name}  ➜ ${preview}`);
			}
		});

		deps.log.append("remediation_complete", {
			attempt: currentAttempt,
			outputLength: output.length,
		});

		// Check if we've exceeded max attempts
		if (currentAttempt + 1 >= maxAttempts) {
			deps.log.append("circuit_breaker_reached", {
				phase: phase.name,
				attempts: currentAttempt + 1,
			});
			return false;
		}

		return true;
	} catch (err: any) {
		deps.log.append("remediation_crash", { error: err.message });
		return false;
	}
}
