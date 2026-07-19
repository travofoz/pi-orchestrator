import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import { Overlay } from "../components/overlay.ts";
import { bakeCtx } from "./ctx.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-reset", {
		description: "Reset bake state — wipes workspace, completed phases, and event log",
		handler: async (_args, cmdCtx) => {
			const bake = bakeCtx.bake;
			if (!bake) return;
			const t = cmdCtx.ui.theme;

			bakeCtx.widgetHidden = true;
			let confirmed = false;
			try {
			confirmed = await cmdCtx.ui.custom<boolean>(
				(tui, theme, _kb, done) => {
					const ov = new Overlay(theme, { title: "⚠ Reset Bake Pipeline" });

					ov.addBody(new Text(theme.fg("warning", "This will destroy:"), 1, 0));
					ov.addBody(new Text(theme.fg("text", "  • All phase files"), 2, 0));
					ov.addBody(new Text(theme.fg("text", "  • Workspace (build artifacts, node_modules)"), 2, 0));
					ov.addBody(new Text(theme.fg("text", "  • Completed phase archives"), 2, 0));
					ov.addBody(new Text(theme.fg("text", "  • Event log"), 2, 0));
					ov.addBody(new Text(theme.fg("text", "  • Pipeline state"), 2, 0));
					ov.addBody(new Text(theme.fg("text", "  • Decomposed spec archive"), 2, 0));
					ov.addBody(new Text(theme.fg("text", "  • Spec context"), 2, 0));
					ov.addBody(new Spacer(1));
					ov.addBody(
						new Text(
							theme.fg("muted", "Git is untouched."),
							1,
							0,
						),
					);
					ov.addFooter("enter confirm  ·  any other key  cancel");

					return {
						render: (w) => ov.render(w),
						invalidate: () => ov.invalidate(),
						handleInput: (data: string) => {
							if (data === "enter" || data === "\r" || data === "\n" || data === "y") {
								done(true);
							} else {
								done(false);
							}
						},
						dispose: () => ov.dispose(),
					};
				},
				{ overlay: true },
			);
			} finally {
				bakeCtx.widgetHidden = false;
				bakeCtx.requestWidgetRender?.();
			}

			if (!confirmed) {
				cmdCtx.ui.notify(t.fg("dim", "Reset cancelled"), "info");
				return;
			}

			bake.clean();
			cmdCtx.ui.setStatus("bake", t.fg("dim", "⏎ bake ready"));
			bakeCtx.requestWidgetRender?.();
			cmdCtx.ui.notify(t.fg("success", "Bake pipeline reset"), "info");
		},
	});
}
