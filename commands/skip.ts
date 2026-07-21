import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, SelectList } from "@earendil-works/pi-tui";
import { Overlay } from "../components/overlay.ts";
import { bakeCtx, getPhaseList } from "./ctx.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-skip", {
		description:
			"Skip a phase. With no args, opens a picker. Usage: /bake-skip <phase-name>",
		handler: async (args, cmdCtx) => {
			const bake = bakeCtx.bake;
			if (!bake) return;
			const t = cmdCtx.ui.theme;
			const state = bake.stateSnapshot;

			// If a phase name is given directly, skip it
			if (args) {
				const phaseName = String(args).trim();
				if (phaseName) {
					bake.skipPhase(phaseName);
					cmdCtx.ui.notify(t.fg("warning", `Skipped: ${phaseName}`), "info");
				} else {
					cmdCtx.ui.notify(
						t.fg("error", "Usage: /bake-skip <phase-name>"),
						"info",
					);
				}
				return;
			}

			// Otherwise show a picker of uncompleted phases
			const allPhases = getPhaseList();
			const pending = allPhases.filter(
				(p) =>
					!state.completedPhases.includes(p) &&
					!state.skippedPhases.includes(p),
			);
			if (pending.length === 0) {
				cmdCtx.ui.notify(t.fg("dim", "No phases to skip"), "info");
				return;
			}

			const items = pending.map((p) => ({
				value: p,
				label: p === state.currentPhase ? `${p} (current)` : p,
				description:
					p === state.currentPhase ? "Currently running phase" : undefined,
			}));

			let selected: string | null = null;
			bakeCtx.widgetHidden = true;
			try {
				selected = await cmdCtx.ui.custom<string | null>(
					(tui, theme, _kb, done) => {
						const ov = new Overlay(theme, { title: "Skip Phase" });

						const list = new SelectList(items, Math.min(items.length, 10), {
							selectedPrefix: (s) => theme.fg("warning", s),
							selectedText: (s) => theme.fg("text", s),
							description: (s) => theme.fg("muted", s),
							scrollInfo: (s) => theme.fg("dim", s),
							noMatch: (s) => theme.fg("error", s),
						});
						list.onSelect = (v) => done(v.value);
						list.onCancel = () => done(null);
						ov.addBody(list);
						ov.addFooter("↑↓ navigate  ·  enter skip  ·  esc cancel");

						return {
							render: (w) => ov.render(w),
							invalidate: () => ov.invalidate(),
							handleInput: (data) => list.handleInput(data),
							dispose: () => ov.dispose(),
						};
					},
					{ overlay: true },
				);
			} finally {
				bakeCtx.widgetHidden = false;
				bakeCtx.requestWidgetRender?.();
			}

			if (selected) {
				bake.skipPhase(selected);
				cmdCtx.ui.notify(t.fg("warning", `Skipped: ${selected}`), "info");
			}
		},
	});
}
