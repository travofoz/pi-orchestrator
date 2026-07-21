import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SettingsListTheme, SettingsList, Container, Text } from "@earendil-works/pi-tui";
import { Overlay } from "../components/overlay.ts";
import { bakeCtx, loadConfig, saveConfig } from "./shared.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-config", {
		description: "Open bake settings — widget mode, preferences",
		handler: async (_args, cmdCtx) => {
			const t = cmdCtx.ui.theme;
			const cfg = loadConfig();

			interface SettingItem {
				id: string;
				label: string;
				description?: string;
				currentValue: string;
				values: string[];
			}

			const items: SettingItem[] = [
				{
					id: "widgetMode",
					label: "Widget mode",
					description:
						cfg.widgetMode === "full"
							? "List all phases (tall — needs vertical space)"
							: cfg.widgetMode === "compact"
								? "Single-line summary (phone-friendly)"
								: "Widget hidden entirely",
					currentValue: cfg.widgetMode,
					values: ["full", "compact", "hidden"],
				},
			];

			// Hide widget while overlay is open (avoids render conflicts)
			bakeCtx.widgetHidden = true;
			try {
			await cmdCtx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const ov = new Overlay(theme, { title: "Bake Config" });

					const settingsTheme: SettingsListTheme = {
						label: (s, _sel) => theme.fg("text", s),
						value: (s, sel) => (sel ? theme.fg("accent", theme.bold(s)) : theme.fg("muted", s)),
						description: (s) => theme.fg("dim", s),
						cursor: theme.fg("accent", "▸"),
						hint: (s) => theme.fg("dim", s),
					};
					const settingsList = new SettingsList(
						items,
						8,
						settingsTheme,
						(id, newValue) => {
							const updated = loadConfig();
							(updated as any)[id] = newValue;
							saveConfig(updated);
							bakeCtx.requestWidgetRender?.();
							const desc =
								newValue === "full"
									? "List all phases (tall — needs vertical space)"
									: newValue === "compact"
										? "Single-line summary (phone-friendly)"
										: "Widget hidden entirely";
							items[0].description = desc;
							items[0].currentValue = newValue;
						},
						() => done(undefined),
						{ enableSearch: false },
					);
					ov.addBody(settingsList);
					ov.addFooter("↑↓ navigate  ·  ← → / space change  ·  esc close");

					return {
						render: (w) => ov.render(w),
						invalidate: () => ov.invalidate(),
						handleInput: (data) => settingsList.handleInput?.(data),
						dispose: () => ov.dispose(),
					};
				},
				{ overlay: true },
			);
			} finally {
				bakeCtx.widgetHidden = false;
				bakeCtx.requestWidgetRender?.();
			}
		},
	});
}
