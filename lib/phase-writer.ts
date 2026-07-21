/**
 * Phase file I/O — writing phase markdown files, DAG manifests, context,
 * and archiving raw specs.
 *
 * Extracted from spec-decompose.ts to keep command handlers thin and
 * make the file-writing logic independently testable.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface PhaseEntry {
	id?: string;
	name: string;
	summary: string;
	done_when: string;
	depends_on?: string[];
	plan?: string[];
}

export interface DagEntry {
	id: string;
	name: string;
	depends_on: string[];
}

/**
 * Derive a filesystem-safe phase ID from a phase object.
 */
function phaseId(phase: PhaseEntry): string {
	return phase.id || phase.name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Write the DAG manifest (dag.json) for the state machine.
 */
export function writeDagManifest(
	phases: PhaseEntry[],
	phasesDir: string,
): void {
	const manifest: DagEntry[] = phases.map((p) => ({
		id: phaseId(p),
		name: p.name,
		depends_on: p.depends_on ?? [],
	}));
	fs.writeFileSync(
		path.join(phasesDir, "dag.json"),
		JSON.stringify(manifest, null, 2),
		"utf-8",
	);
}

/**
 * Write each phase as a markdown file in the phases directory.
 */
export function writePhaseFiles(phases: PhaseEntry[], phasesDir: string): void {
	for (const phase of phases) {
		const id = phaseId(phase);
		const fileName = id + ".md";
		const depsArr = phase.depends_on ?? [];
		const deps =
			depsArr.length > 0
				? `\n## Depends On\n${depsArr.join(", ")}\n`
				: "\n## Depends On\n(none)\n";
		const planArr = phase.plan ?? [];
		const planSteps =
			planArr.length > 0
				? `\n## Plan\n${planArr.map((s: string) => `- ${s}`).join("\n")}\n`
				: "\n## Plan\n(none)\n";
		const content = [
			`# ${phase.name}`,
			"",
			`## Phase ID`,
			id,
			deps.trim(),
			`## Objective`,
			phase.summary,
			"",
			`## Done When`,
			phase.done_when,
			planSteps.trim(),
		].join("\n");

		fs.writeFileSync(path.join(phasesDir, fileName), content, "utf-8");
	}
}

/**
 * Write the spec context to the .bake database directory.
 */
export function writeContext(context: string, dbDir: string): void {
	fs.writeFileSync(path.join(dbDir, "spec-context.md"), context, "utf-8");
}

/**
 * If the source spec lives inside the phases directory, archive it to
 * prevent the pipeline from trying to execute it as a phase.
 */
export function archiveSpec(specPath: string, dbDir: string): boolean {
	const phasesDir = path.join(dbDir, "phases");
	const resolvedPhases = path.resolve(phasesDir);
	if (specPath.startsWith(resolvedPhases)) {
		const archiveDir = path.join(dbDir, "archive");
		if (!fs.existsSync(archiveDir)) {
			fs.mkdirSync(archiveDir, { recursive: true });
		}
		const dest = path.join(archiveDir, `${path.basename(specPath)}.decomposed`);
		fs.renameSync(specPath, dest);
		return true;
	}
	return false;
}
