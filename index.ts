/**
 * ─═══[ bake ]═══─
 *
 *  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 *  █  bake  —  pi extension for autonomous phase execution   █
 *  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 *
 *  Thin entry point: registers all commands at module level,
 *  then initializes Bake, widget, status line, and loader
 *  callbacks on session_start.
 *
 * ─═══[ CREDITS ]═══─
 *
 *  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 *  █  dehuman@lotek.org  —  #614  —  #2600  #rave  #tracker  █
 *  █  #freebsdhelp #614 #hp #740 #drumandbass  —  EFnet 95-03  █
 *  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 *
 *  dehuman   Lion-gv    Paradyme   Monad      3Jane
 *  Pr0zac    Palmore    Chexbitz   Caz        Badfish
 *  The Wiz   Roy        Mike J     Seth       Tomo
 *  Ewheat RIP           Keebler RIP
 *
 * ─═══[ EOF ]═══─
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

import { Bake } from "./bake.ts";
import { registerAll } from "./commands/index.ts";
import {
	bakeCtx,
	BAKE_BASE,
	WORKSPACE_DIR,
	PHASES_DIR,
	RULES_DIR,
	WIDGET_ID,
	getPhaseList,
	loadConfig,
} from "./commands/ctx.ts";
import { scannerTaper, type ThemeProxy } from "./components/overlay.ts";

// ThemeProxy has {fg, bg} — used by BakeWidget for scannerTaper / phase rendering
type AnimTheme = ThemeProxy;

// ─── Widget component (Component interface — rendered by TUI, no setWidget spam) ───
class BakeWidget implements Component {
	private theme: AnimTheme;
	private phaseList: string[];
	private startTime: number;

	constructor(theme: AnimTheme, phaseList: string[]) {
		this.theme = theme;
		this.phaseList = phaseList;
		this.startTime = Date.now();
	}

	invalidate() {}

	render(width: number): string[] {
		const t = this.theme;
		const cfg = loadConfig();
		if (cfg.widgetMode === "hidden") return [];

		const state = bakeCtx.bake?.stateSnapshot;
		if (!state) return [];
		const allPhases = this.phaseList;
		if (allPhases.length === 0) {
			return [t.fg("dim", "Bake idle. Use /bake-start to begin.")];
		}

		if (cfg.widgetMode === "compact") {
			const parts: string[] = [];
			if (state.currentPhase) {
				const a =
					state.currentAttempt >= 0
						? `(${Math.min(state.currentAttempt + 1, state.maxAttempts)}/${state.maxAttempts})`
						: "";
				parts.push(
					`${t.fg("success", "●")} ${t.fg("accent", state.currentPhase)}${a ? ` ${t.fg("warning", a)}` : ""}`,
				);
			}
			const done = state.completedPhases.length + state.skippedPhases.length;
			const pending = allPhases.length - done;
			if (state.completedPhases.length) parts.push(`${t.fg("success", `✓${state.completedPhases.length}`)}`);
			if (state.skippedPhases.length) parts.push(`${t.fg("warning", `⏸${state.skippedPhases.length}`)}`);
			if (pending > 0) parts.push(`${t.fg("dim", `○${pending}`)}`);
			const label =
				state.status === "idle"
					? t.fg("dim", "idle")
					: state.status === "done"
						? t.fg("success", "done")
						: state.status === "failed"
							? t.fg("error", "failed")
							: t.fg("accent", state.status);
			parts.push(label);
			return [parts.join("  ")];
		}

		// Full mode — time-based scanner header (position from Date.now(), cached phase list)
		const elapsed = (Date.now() - this.startTime) / 1000;
		const scanPos = Math.abs(Math.sin(elapsed * 1.2));
		const header = scannerTaper(width - 2, scanPos, t, "bake");
		const phaseLines = allPhases.map((phase) => {
			if (state.completedPhases.includes(phase)) {
				return ` ${t.fg("success", "✓")} ${t.fg("muted", phase)}`;
			}
			if (state.skippedPhases.includes(phase)) {
				return ` ${t.fg("warning", "⏸")} ${t.fg("muted", phase)}`;
			}
			if (state.currentPhase === phase) {
				const attempt =
					state.currentAttempt >= 0
						? ` (${Math.min(state.currentAttempt + 1, state.maxAttempts)}/${state.maxAttempts})`
						: "";
				return `${t.fg("success", "●")} ${t.fg("accent", phase)}${t.fg("warning", attempt)}`;
			}
			const doneCount = state.completedPhases.length + state.skippedPhases.length;
			const idx = allPhases.indexOf(phase);
			if (idx < doneCount) {
				return ` ${t.fg("dim", "○")} ${t.fg("dim", phase)}`;
			}
			return ` ${t.fg("dim", "○")} ${t.fg("dim", phase)}`;
		});
		return [header, ...phaseLines];
	}
}

export default function (pi: ExtensionAPI) {
	registerAll(pi);

	// ── session_start: one-time init ──
	pi.on("session_start", async (_event, ctx) => {
		bakeCtx.bake = new Bake(BAKE_BASE, WORKSPACE_DIR, RULES_DIR);

		// Ensure workspace dir exists + root symlink
		if (!fs.existsSync(WORKSPACE_DIR)) {
			fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
		}
		const wsLink = path.join(BAKE_BASE, "workspace");
		try {
			if (!fs.existsSync(wsLink)) {
				fs.symlinkSync(WORKSPACE_DIR, wsLink, "dir");
			}
		} catch { /* non-fatal */ }

		if (!fs.existsSync(PHASES_DIR)) {
			fs.mkdirSync(PHASES_DIR, { recursive: true });
		}
		const phLink = path.join(BAKE_BASE, "phases");
		try {
			if (!fs.existsSync(phLink)) {
				fs.symlinkSync(PHASES_DIR, phLink, "dir");
			}
		} catch { /* non-fatal */ }

		// Sanity-check state
		const initial = bakeCtx.bake.stateSnapshot;
		if (!["idle", "done"].includes(initial.status)) {
			const pendingPhases = getPhaseList().filter(
				(p) => !initial.completedPhases.includes(p) && !initial.skippedPhases.includes(p),
			);
			if (pendingPhases.length === 0) bakeCtx.bake.resetState();
		}

		const t = ctx.ui.theme;
		const cachedPhaseList = getPhaseList();

		// ── Working indicator: single red KITT scanner (60ms, independent of TUI render) ──
		const RED_B = "\x1b[38;5;196m";
		const RED_M = "\x1b[38;5;160m";
		const RED_D = "\x1b[38;5;88m";
		const GRN_D = "\x1b[38;5;65m";
		const RST = "\x1b[0m";
		const buildWorkingFrames = (cols: number) => {
			const W = Math.max(8, cols - 3);
			const B = ["⠀", "⡀", "⡠", "⡦", "⡶", "⣶", "⣿"];
			const frames: string[] = [];
			const makeFrame = (spot: number) => {
				const cells: string[] = [];
				for (let i = 0; i < W; i++) {
					const dist = Math.abs(i - Math.round(spot * (W - 1)));
					const b = dist <= 1 ? 6 : dist <= 3 ? 4 : dist <= 6 ? 2 : 0;
					if (dist <= 2) cells.push((dist <= 1 ? RED_B : RED_M) + B[b] + RST);
					else if (dist <= 5) cells.push(RED_D + B[b] + RST);
					else cells.push(GRN_D + B[b] + RST);
				}
				return cells.join("");
			};
			const steps = 25;
			for (let i = 0; i <= steps; i++) frames.push(makeFrame(i / steps));
			for (let i = steps - 1; i >= 0; i--) frames.push(makeFrame(i / steps));
			return frames;
		};
		ctx.ui.setWorkingMessage("");
		ctx.ui.setWorkingIndicator({
			frames: buildWorkingFrames(process.stdout.columns || 80),
			intervalMs: 60,
		});

		// ── Widget as a Component (TUI calls render() on each render cycle) ──
		// No animation timer — widget scanner updates only on user interaction or state changes.
		// This avoids competing with overlays (settings, detail, etc.) for render cycles.
		ctx.ui.setWidget(WIDGET_ID, (tui: TUI, theme: Theme) => {
			// Expose render trigger for config changes, state resets, etc.
			bakeCtx.requestWidgetRender = () => tui.requestRender();

			return new BakeWidget(theme, cachedPhaseList);
		});

		// ── State change handler (simplified — no widget re-set, central timer handles render) ──
		bakeCtx.bake.onStateChange((s) => {
			if (s.status === "done" || s.status === "failed" || s.status === "idle") {
				ctx.ui.setWorkingIndicator();
				ctx.ui.setStatus("bake", t.fg("dim", "⏎ bake ready"));
				if (bakeCtx.closeLoader) {
					bakeCtx.closeLoader();
					bakeCtx.closeLoader = null;
				}
			}
		});

		// ── Status line ──
		bakeCtx.bake.onStatus((msg) => ctx.ui.setStatus("bake", t.fg("accent", t.bold(`● ${msg}`))));
		ctx.ui.setStatus("bake", t.fg("dim", "⏎ bake ready"));

		// ── Loader ──
		bakeCtx.bake.onLoader((show, msg) => {
			bakeCtx.loaderMsg = msg;
			ctx.ui.setStatus("bake", t.fg("accent", t.bold(`● ${msg}`)));
			if (!show && bakeCtx.closeLoader) {
				bakeCtx.closeLoader();
				bakeCtx.closeLoader = null;
			}
		});
	});
}
