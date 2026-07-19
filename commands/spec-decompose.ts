import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LoaderComponent } from "../components/loader.ts";
import { bakeCtx, BAKE_BASE, BAKE_DB_DIR, PHASES_DIR } from "./ctx.ts";

// ── JSON repair helpers for fragile LLM output ─────────────────────────

/**
 * Attempt to fix common JSON issues produced by LLMs:
 * 1. Trailing commas in arrays/objects
 * 2. Unescaped control characters in strings
 * 3. Single-quoted strings instead of double-quoted
 * 4. Missing closing brackets (truncation)
 * 5. Comments (// or /* style)
 */
function repairJSON(raw: string): string {
	let s = raw.trim();

	// Strip markdown code fence if present
	s = s.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

	// Strip any leading text before the first {
	const braceIdx = s.indexOf("{");
	if (braceIdx > 0) s = s.slice(braceIdx);

	// Remove single-line comments (// ...)
	s = s.replace(/\/\/[^\n]*/g, "");

	// Remove multi-line comments (/* ... */)
	s = s.replace(/\/\*[\s\S]*?\*\//g, "");

	// Replace single quotes at string boundaries with double quotes
	// Match: 'key': or : 'value' patterns — conservative to avoid breaking embedded apostrophes
	s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, '"$1":');
	s = s.replace(/"\s*:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, '": "$1"');

	// Remove trailing commas before } or ]
	s = s.replace(/,\s*([}\]])/g, "$1");

	// Attempt to close unclosed structure: count braces
	let depth = 0;
	let inString = false;
	let escaped = false;
	let lastBrace = -1;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (escaped) { escaped = false; continue; }
		if (ch === "\\" && inString) { escaped = true; continue; }
		if (ch === '"' && !escaped) { inString = !inString; continue; }
		if (inString) continue;
		if (ch === "{" || ch === "[") { depth++; lastBrace = i; }
		if (ch === "}" || ch === "]") { depth--; lastBrace = i; }
	}

	// If we're inside an unclosed string, add closing quote
	if (inString) s += '"';

	// Close unclosed braces/brackets in reverse order
	if (depth > 0 && s.length > 0) {
		const closers: string[] = [];
		// Re-scan to determine which closers are needed
		const stack: string[] = [];
		let si = false;
		let se = false;
		for (let i = 0; i < s.length; i++) {
			const ch = s[i];
			if (se) { se = false; continue; }
			if (ch === "\\" && si) { se = true; continue; }
			if (ch === '"' && !se) { si = !si; continue; }
			if (si) continue;
			if (ch === "{") stack.push("}");
			if (ch === "[") stack.push("]");
			if (ch === "}" || ch === "]") {
				if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
			}
		}
		for (let i = stack.length - 1; i >= 0; i--) {
			closers.push(stack[i]);
		}
		s += closers.join("");
	}

	return s;
}

/**
 * Try to parse JSON with repair attempts.
 * Returns parsed object or throws with details if all attempts fail.
 */
function tryParseJSON(raw: string, logPath: string): any {
	// First attempt: direct parse
	try {
		return JSON.parse(raw);
	} catch {
		// Save original for debugging
		fs.writeFileSync(logPath, raw, "utf-8");
	}

	// Second attempt: repair and parse
	const repaired = repairJSON(raw);
	try {
		const parsed = JSON.parse(repaired);
		return parsed;
	} catch (e: any) {
		// Save repaired version too for comparison
		fs.writeFileSync(
			logPath.replace(/\.txt$/, "-repaired.txt"),
			repaired,
			"utf-8",
		);
		throw new Error(
			`JSON parse error after repair: ${e.message}. Raw output saved to ${logPath}`,
		);
	}
}

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-spec-decompose", {
		description: "Decompose a raw spec file into clean phase files",
		usage: "<path-to-raw-spec>",
		handler: async (args, cmdCtx) => {
			const bake = bakeCtx.bake;
			if (!bake) {
				cmdCtx.ui.notify(cmdCtx.ui.theme.fg("error", "Bake not initialized"), "info");
				return;
			}
			const t = cmdCtx.ui.theme;
			if (!args) {
				cmdCtx.ui.notify(t.fg("error", "Usage: /bake-spec-decompose <path>"), "info");
				return;
			}
			const specPath = path.resolve(args);
			if (!fs.existsSync(specPath)) {
				cmdCtx.ui.notify(t.fg("error", `File not found: ${specPath}`), "info");
				return;
			}

			const specContent = fs.readFileSync(specPath, "utf-8");

			// Truncate ultra-long specs to avoid LLM output truncation
			const MAX_SPEC_LENGTH = 16000;
			const truncated =
				specContent.length > MAX_SPEC_LENGTH
					? specContent.slice(0, MAX_SPEC_LENGTH) +
						"\n\n[... TRUNCATED: spec too large, keeping first ~16KB for reliable decomposition]"
					: specContent;

			const decomposePrompt = `You are decomposing a technical specification into discrete, actionable phases for an autonomous coding agent.

Output a valid JSON object with NO markdown wrapping, NO code fences, NO commentary before or after. Just raw JSON.

The JSON must match this TypeScript type exactly:
{
  "phases": Array<{ "name": string, "summary": string, "done_when": string }>,
  "context": string
}

Guidelines:
- Each phase name should be prefixed with a 2-digit number and underscore (e.g., "01_wifi_lifecycle")
- "summary" is a one-line objective
- "done_when" is the acceptance criteria (1-2 sentences)
- "context" captures everything else: narrative, philosophy, out-of-scope items, operational notes, hardware constraints — anything that doesn't belong in a single phase
- Generate 6-15 phases depending on spec complexity
- Do NOT truncate — produce the complete JSON
- IMPORTANT: Escape all double-quotes inside strings with backslash

Raw spec:
${truncated}`;

			cmdCtx.ui.setStatus("bake", t.fg("accent", "○ Decomposing spec..."));

			// ── Show LoaderComponent overlay ──
			let loaderDone: (() => void) | null = null;
			let aborted = false;
			bakeCtx.loaderMsg = "Decomposing spec...";

			const loaderP = cmdCtx.ui.custom(
				(tui, theme, _kb, done) => {
					loaderDone = () => {
						try {
							done(undefined);
						} catch {
							/* already closed */
						}
					};
					const comp = new LoaderComponent(tui, theme.fg.bind(theme), theme.bg.bind(theme), () => bakeCtx.loaderMsg);

					return {
						render: (w: number) => comp.render(w),
						invalidate: () => {},
						handleInput: (data: string) => {
							if (data === "escape" || data === "q") {
								aborted = true;
								bake?.abort();
							}
						},
						dispose: () => {
							comp.dispose();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						margin: 1,
					},
				},
			);

			try {
				const output = await bake.runPrompt(decomposePrompt, "Decompose");

				// Try to extract JSON from the output
				let jsonStr = output.trim();

				// Strip markdown code fences if the LLM wrapped the JSON despite instructions
				jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

				// If output doesn't start with {, find the first { and use from there
				const firstBrace = jsonStr.indexOf("{");
				const lastBrace = jsonStr.lastIndexOf("}");
				if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
					jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
				}

				const rawLogPath = path.join(BAKE_BASE, ".bake", "decompose-raw-output.txt");

				let decomposition: any;
				try {
					decomposition = tryParseJSON(jsonStr, rawLogPath);
				} catch (parseErr: any) {
					cmdCtx.ui.notify(
						t.fg("error", `Decompose: ${parseErr.message}`),
						"info",
					);
					return;
				}
				if (!fs.existsSync(PHASES_DIR)) fs.mkdirSync(PHASES_DIR, { recursive: true });
				for (const phase of decomposition.phases) {
					const fileName = phase.name.replace(/[^a-zA-Z0-9_-]/g, "_") + ".md";
					const content = `# ${phase.name}\n\n## Objective\n${phase.summary}\n\n## Done When\n${phase.done_when}\n`;
					fs.writeFileSync(path.join(PHASES_DIR, fileName), content, "utf-8");
				}
				if (decomposition.context) {
					fs.writeFileSync(
						path.join(BAKE_DB_DIR, "spec-context.md"),
						decomposition.context,
						"utf-8",
					);
				}
				// If the source spec was inside PHASES_DIR, archive it so the pipeline won't try to execute it
				const resolvedPhases = path.resolve(PHASES_DIR);
				if (specPath.startsWith(resolvedPhases)) {
					const archiveDir = path.join(BAKE_DB_DIR, "archive");
					if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
					const dest = path.join(archiveDir, `${path.basename(specPath)}.decomposed`);
					fs.renameSync(specPath, dest);
					cmdCtx.ui.notify(t.fg("dim", `Raw spec archived to .bake/archive/`), "info");
				}

				cmdCtx.ui.notify(t.fg("success", `${decomposition.phases.length} phases written to phases/`), "info");

				// ── Generate a README from the spec context (non-blocking) ──
				if (decomposition.context) {
					bakeCtx.loaderMsg = "Generating README...";
					bake.setLoader(true, "Generating README...");

					const readmePrompt = `You are a technical writer for an open-source project.
Write a README.md for the project described below.

Context:
${decomposition.context}

Phases:
${decomposition.phases.map((p: any) => `- ${p.name}: ${p.summary}`).join("\n")}

Output ONLY markdown, no extra commentary. The README should include:
- Project name and purpose (one-liner)
- What it does (2-3 sentences)
- Quick start / usage
- Architecture overview (bullets)
- License (MIT)

Write it clean, direct, no fluff.`;

					// Fire and forget — don't block the compose flow
					bake
						.runPrompt(readmePrompt, "README")
						.then((readmeContent: string) => {
							const cleaned = readmeContent.replace(/^```[a-z]*\n?|```$/gm, "").trim();
							fs.writeFileSync(path.join(BAKE_BASE, "README.md"), cleaned + "\n", "utf-8");
							cmdCtx.ui.notify(t.fg("success", "README.md generated"), "info");
						})
						.catch((err: any) => {
							cmdCtx.ui.notify(t.fg("warning", `README generation skipped: ${err.message}`), "info");
						})
						.finally(() => {
							bake.setLoader(false, "");
						});
				}
			} catch (err: any) {
				if (aborted) {
					cmdCtx.ui.notify(t.fg("warning", "Decompose aborted"), "info");
				} else {
					cmdCtx.ui.notify(t.fg("error", `Decompose failed: ${err.message}`), "info");
				}
			} finally {
				if (loaderDone) {
					loaderDone();
					loaderDone = null;
				}
				loaderP.catch(() => {});
				cmdCtx.ui.setStatus("bake", t.fg("dim", "⏎ bake ready"));
			}
		},
	});
}
