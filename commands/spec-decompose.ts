import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tryParseJSON } from "../lib/json-utils.ts";
import { buildDecomposePrompt, buildReadmePrompt } from "../lib/prompts.ts";
import {
	writeDagManifest,
	writePhaseFiles,
	writeContext,
	archiveSpec,
} from "../lib/phase-writer.ts";
import { bakeCtx, BAKE_BASE, BAKE_DB_DIR, PHASES_DIR } from "./ctx.ts";

/**
 * Handler for /bake-spec-decompose.
 *
 * Orchestrates the decompose flow:
 * 1. Validate args → read spec
 * 2. Call LLM with decompose prompt (status + notify, no custom overlay)
 * 3. Parse/repair JSON response
 * 4. Write phase files, DAG manifest, context
 * 5. Archive source spec if needed
 * 6. Fire-and-forget README generation
 */
async function handleDecompose(
	args: string | undefined,
	cmdCtx: any,
): Promise<void> {
	const bake = bakeCtx.bake;
	if (!bake) {
		cmdCtx.ui.notify(
			cmdCtx.ui.theme.fg("error", "Bake not initialized"),
			"info",
		);
		return;
	}
	const t = cmdCtx.ui.theme;

	if (!args) {
		cmdCtx.ui.notify(
			t.fg("error", "Usage: /bake-spec-decompose <path>"),
			"info",
		);
		return;
	}

	const specPath = path.resolve(args);
	if (!fs.existsSync(specPath)) {
		cmdCtx.ui.notify(t.fg("error", `File not found: ${specPath}`), "info");
		return;
	}

	const specContent = fs.readFileSync(specPath, "utf-8");
	const decomposePrompt = buildDecomposePrompt(specContent);

	cmdCtx.ui.setStatus("bake", t.fg("accent", "○ Decomposing spec..."));

	cmdCtx.ui.notify(
		t.fg("dim", "Decomposing spec via LLM (may take a moment)"),
		"info",
	);

	try {
		const output = await bake.runPrompt(decomposePrompt, "Decompose");

		// Extract JSON from LLM output (strip fences, trim)
		let jsonStr = output.trim();
		jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
		const firstBrace = jsonStr.indexOf("{");
		const lastBrace = jsonStr.lastIndexOf("}");
		if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
			jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
		}

		const rawLogPath = path.join(
			BAKE_BASE,
			".bake",
			"decompose-raw-output.txt",
		);

		let decomposition: any;
		try {
			decomposition = tryParseJSON(jsonStr, rawLogPath);
		} catch (parseErr: any) {
			cmdCtx.ui.notify(t.fg("error", `Decompose: ${parseErr.message}`), "info");
			return;
		}

		if (!fs.existsSync(PHASES_DIR)) {
			fs.mkdirSync(PHASES_DIR, { recursive: true });
		}

		writeDagManifest(decomposition.phases, PHASES_DIR);
		writePhaseFiles(decomposition.phases, PHASES_DIR);

		if (decomposition.context) {
			writeContext(decomposition.context, BAKE_DB_DIR);
		}

		const archived = archiveSpec(specPath, BAKE_DB_DIR);
		if (archived) {
			cmdCtx.ui.notify(
				t.fg("dim", "Raw spec archived to .bake/archive/"),
				"info",
			);
		}

		cmdCtx.ui.notify(
			t.fg(
				"success",
				`${decomposition.phases.length} phases written to phases/`,
			),
			"info",
		);

		// Fire-and-forget README generation
		if (decomposition.context) {
			generateReadme(
				bake,
				decomposition.context,
				decomposition.phases,
				t,
				cmdCtx,
			);
		}
	} catch (err: any) {
		cmdCtx.ui.notify(t.fg("error", `Decompose failed: ${err.message}`), "info");
	} finally {
		cmdCtx.ui.setStatus("bake", t.fg("dim", "⏎ bake ready"));
	}
}

/**
 * Fire-and-forget: generate a README.md from the spec context.
 * Errors are logged as warnings, never thrown.
 */
async function generateReadme(
	bake: any,
	context: string,
	phases: any[],
	t: any,
	cmdCtx: any,
): Promise<void> {
	bake.setLoader(true, "Generating README...");

	const readmePrompt = buildReadmePrompt(context, phases);

	bake
		.runPrompt(readmePrompt, "README")
		.then((readmeContent: string) => {
			const cleaned = readmeContent.replace(/^```[a-z]*\n?|```$/gm, "").trim();
			fs.writeFileSync(
				path.join(BAKE_BASE, "README.md"),
				cleaned + "\n",
				"utf-8",
			);
			cmdCtx.ui.notify(t.fg("success", "README.md generated"), "info");
		})
		.catch((err: any) => {
			cmdCtx.ui.notify(
				t.fg("warning", `README generation skipped: ${err.message}`),
				"info",
			);
		})
		.finally(() => {
			bake.setLoader(false, "");
		});
}

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-spec-decompose", {
		description:
			"Decompose a raw spec file into clean phase files. Usage: /bake-spec-decompose <path>",
		handler: handleDecompose,
	});
}
