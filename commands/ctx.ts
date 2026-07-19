/**
 * Shared mutable context for all bake commands.
 *
 * Module-level state that commands need access to, initialized during
 * session_start in index.ts and read/written by command handlers at runtime.
 *
 * Using a mutable object avoids the need for setter functions — properties
 * are reassigned directly by index.ts and read reactively by handlers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Bake } from "../bake.ts";

// ─── Path constants ──────────────────────────────────────────────────

export const BAKE_BASE = process.cwd();
export const WIDGET_ID = "bake-status";

// Paths derived from BAKE_BASE

export const BAKE_DB_DIR = path.join(BAKE_BASE, ".bake");
export const WORKSPACE_DIR = path.join(BAKE_DB_DIR, "workspace");
export const PHASES_DIR = path.join(BAKE_DB_DIR, "phases");
export const RULES_STATE_FILE = path.join(BAKE_DB_DIR, "rules-state.json");
export const CONFIG_FILE = path.join(BAKE_DB_DIR, "config.json");

/**
 * Resolve the rules directory.
 * Checks in `__dirname/rules` first (dev via symlinks), then BAKE_BASE/rules.
 */
const resolveRulesDir = (): string => {
	const viaDirname = path.join(__dirname, "rules");
	if (fs.existsSync(path.join(viaDirname, "base"))) return viaDirname;
	const viaBase = path.join(BAKE_BASE, "rules");
	if (fs.existsSync(path.join(viaBase, "base"))) return viaBase;
	return viaBase;
};

export const RULES_DIR = resolveRulesDir();

// ─── Types ───────────────────────────────────────────────────────────

export type WidgetMode = "full" | "compact" | "hidden";

export interface BakeConfig {
	widgetMode: WidgetMode;
}

export const DEFAULT_CONFIG: BakeConfig = { widgetMode: "full" };

// ─── Config helpers ──────────────────────────────────────────────────

export const loadConfig = (): BakeConfig => {
	try {
		if (fs.existsSync(CONFIG_FILE)) {
			return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) };
		}
	} catch {
		/* fall through */
	}
	return { ...DEFAULT_CONFIG };
};

export const saveConfig = (cfg: BakeConfig): void => {
	const dir = path.dirname(CONFIG_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
};

// ─── Phase list helper ───────────────────────────────────────────────

export const getPhaseList = (): string[] => {
	if (!fs.existsSync(PHASES_DIR)) return [];
	return fs
		.readdirSync(PHASES_DIR)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.map((f) => f.replace(/\.md$/, ""));
};

// ─── Rules state helpers ─────────────────────────────────────────────

export const loadRulesState = (): Record<string, boolean> => {
	if (!fs.existsSync(RULES_STATE_FILE)) return {};
	try {
		return JSON.parse(fs.readFileSync(RULES_STATE_FILE, "utf-8"));
	} catch {
		return {};
	}
};

export const saveRulesState = (state: Record<string, boolean>): void => {
	const dir = path.dirname(RULES_STATE_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(RULES_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
};

export const getRuleFiles = (): string[] => {
	const baseDir = path.join(RULES_DIR, "base");
	if (!fs.existsSync(baseDir)) return [];
	return fs.readdirSync(baseDir).filter((f) => f.endsWith(".yml")).sort();
};

// ─── Mutable references (set by index.ts session_start, read by commands) ──

export const bakeCtx: {
	bake: Bake | null;
	closeLoader: (() => void) | null;
	loaderMsg: string;
	/** Triggers a TUI re-render (so widget Component picks up new state). Set by widget factory. */
	requestWidgetRender: (() => void) | null;
	/** When true, BakeWidget.render() returns empty (no widget visible). Toggled by overlay commands. */
	widgetHidden: boolean;
	/** Reference to the widget instance, so state change handler can reset scanner timer. */
	widgetRef: { reset: () => void } | null;
} = {
	bake: null,
	closeLoader: null,
	loaderMsg: "",
	requestWidgetRender: null,
	widgetHidden: false,
	widgetRef: null,
};
