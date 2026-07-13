/**
 * Hybrid auditor: ast-grep for structural checks + LLM for semantic checks.
 *
 * Structural checks run first (deterministic, ~50ms).
 * Semantic checks (structured checklist) run only if structural passes.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface AuditFinding {
	check: number;
	detail: string;
	rule?: string;
	source: "ast-grep" | "llm";
}

export interface AuditResult {
	passed: boolean;
	findings: AuditFinding[];
}

const RULES_DIR = path.join(__dirname, "rules");

/**
 * Run ast-grep structural checks against the workspace.
 * Returns findings for any violations.
 */
export function runStructuralAudit(workspacePath: string): AuditFinding[] {
	if (!fs.existsSync(RULES_DIR)) return [];

	const baseDir = path.join(RULES_DIR, "base");
	if (!fs.existsSync(baseDir)) return [];

	const findings: AuditFinding[] = [];
	const rules = fs.readdirSync(baseDir).filter((f) => f.endsWith(".yml"));

	for (const ruleFile of rules) {
		const rulePath = path.join(baseDir, ruleFile);
		try {
			const output = execSync(`sg scan -r "${rulePath}" "${workspacePath}" 2>&1`, {
				encoding: "utf-8",
				timeout: 30000,
			});
			if (output) {
				// ast-grep found violations
				const lines = output.trim().split("\n").filter((l) => l.startsWith("  "));
				findings.push({
					check: 0,
					detail: `${ruleFile.replace(".yml", "")}:\n${lines.join("\n")}`,
					rule: ruleFile,
					source: "ast-grep",
				});
			}
		} catch (err: any) {
			// sg exits non-zero when it finds issues but also on errors
			// Check if stderr has actual violations
			const output = err.stdout || err.message || "";
			const lines = output.trim().split("\n").filter((l) => l.startsWith("  ") || l.includes("error["));
			if (lines.length > 0) {
				findings.push({
					check: 0,
					detail: `${ruleFile.replace(".yml", "")}:\n${lines.join("\n")}`,
					rule: ruleFile,
					source: "ast-grep",
				});
			}
		}
	}

	return findings;
}

/**
 * Structured LLM audit prompt. Returns the prompt to send to the auditor sub-agent.
 * Model fills in PASS/FAIL per check and returns JSON.
 */
export function buildSemanticAuditPrompt(workspacePath: string): string {
	return `Audit the codebase at ${workspacePath} against these checks using your tools.

Output exactly one PASS or FAIL per line (8 lines), then RESULT: PASS or RESULT: ISSUES, then a JSON block with a "failures" array.

CHECKS:
1. All async $effect calls guard state mutations with a destroyed flag (set in onDestroy, checked after each await)
2. Files using $effect with async work import onDestroy from 'svelte'
3. Upload success message is stored before clearUpload() call (not after)
4. Blob URL for download uses deferred revocation (setTimeout, not synchronous after a.click())
5. No placeholder/stub implementations (TODO, FIXME, pass, return null)
6. Error paths in async functions show meaningful error messages (not just re-thrown or swallowed)
7. No hardcoded secrets, tokens, or API keys in source
8. Exported functions have JSDoc or equivalent type annotations

For each FAIL, include the file path and what's wrong.`;
}

/**
 * Parse the LLM audit output into a structured result.
 */
export function parseSemanticAuditOutput(output: string): AuditResult {
	const findings: AuditFinding[] = [];

	// Extract the JSON failures block
	const jsonMatch = output.match(/\{[\s\S]*"failures"[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			if (parsed.failures && Array.isArray(parsed.failures)) {
				for (const f of parsed.failures) {
					findings.push({
						check: f.check || 0,
						detail: f.detail || "",
						source: "llm",
					});
				}
			}
		} catch {
			// JSON parse failed — fall back to line-by-line
		}
	}

	// If no JSON found, check for RESULT: ISSUES via line parsing
	if (findings.length === 0) {
		const lines = output.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.startsWith("FAIL")) {
				// Extract check number and detail
				const checkMatch = trimmed.match(/^FAIL\s*(?:\*\*Check\s*(\d+)\*\*)?\s*[—\-–]?\s*(.*)/);
				findings.push({
					check: checkMatch ? Number(checkMatch[1]) || 0 : 0,
					detail: checkMatch?.[2] || trimmed,
					source: "llm",
				});
			}
		}
	}

	const hasIssues = output.includes("RESULT: ISSUES") || output.includes("RESULT: FAIL");
	return {
		passed: !hasIssues && findings.length === 0,
		findings,
	};
}
