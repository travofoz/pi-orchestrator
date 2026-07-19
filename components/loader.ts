/**
 * Animated loader — KITT scanner in stacked braille style.
 *
 *   ⣀⣠⣤⣴⣶⣷⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣴⣤⣠⣀
 *   ──━━━━━━━━━━━━═══[ ▉ Scanning... ]═══━━━━━━━━━━━━──
 *   ──━━━━━━━━━━━━═══════════════════════════━━━━━━━━━━━━──
 *   ⣀⣠⣤⣴⣶⣷⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣴⣤⣠⣀
 *
 * Scanner char sweeps through ▏▎▍▌▋▊▉█.
 * Dark charcoal bg, 2-col terminal margin.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

// Near-black panel background — matches overlay dark theme
const PANEL_BG = "\x1b[48;5;232m";
const RESET_BLACK = "\x1b[0m\x1b[38;5;255m";

function wrapPanel(text: string): string {
	return PANEL_BG + text + RESET_BLACK;
}

const BRAILLE_STEPS = ["⣀","⣠","⣤","⣴","⣶","⣷","⣿","⣷","⣶","⣴","⣤","⣠","⣀"];

function brailleGauss(width: number): string {
	if (width <= 0) return "";
	let s = "";
	for (let i = 0; i < width; i++) {
		const center = (width - 1) / 2;
		const dist = Math.abs(i - center) / Math.max(1, center);
		const idx = Math.round(dist * (BRAILLE_STEPS.length - 1));
		s += BRAILLE_STEPS[Math.min(idx, BRAILLE_STEPS.length - 1)];
	}
	return s;
}

const TAPER_CHARS = ["─", "━", "═"];

function taper(width: number): string {
	if (width <= 0) return "";
	let s = "";
	for (let i = 0; i < width; i++) {
		const center = (width - 1) / 2;
		const dist = Math.abs(i - center) / Math.max(1, center);
		const idx = Math.round((1 - dist) * (TAPER_CHARS.length - 1));
		s += TAPER_CHARS[Math.max(0, Math.min(idx, TAPER_CHARS.length - 1))];
	}
	return s;
}

const SCANNER_FRAMES = ["▏","▎","▍","▌","▋","▊","▉","█","▉","▊","▋","▌","▍","▎","▏"];

export class LoaderComponent implements Component {
	private scannerIdx = 0;
	private scannerTimer: ReturnType<typeof setInterval> | null = null;
	private tuiRef: TUI;
	private fg: (variant: string, text: string) => string;
	private getMsg: () => string;

	constructor(
		tui: TUI,
		fg: (variant: string, text: string) => string,
		_bg: (variant: string, text: string) => string,
		getMsg: () => string,
	) {
		this.tuiRef = tui;
		this.fg = fg;
		this.getMsg = getMsg;
		this.scannerTimer = setInterval(() => {
			this.scannerIdx = (this.scannerIdx + 1) % SCANNER_FRAMES.length;
			tui.requestRender();
		}, 80);
	}

	invalidate() {}

	render(w: number): string[] {
		const RED_B = "\x1b[38;5;196m";
		const GRN_D = "\x1b[38;5;65m";
		const RST = "\x1b[0m";
		const scanner = SCANNER_FRAMES[this.scannerIdx];
		const msg = this.getMsg();
		const t = this.fg;
		const dim = (s: string) => t("dim", s);

		const margin = 2;
		const innerW = Math.max(28, w - margin * 2);
		const left = " ".repeat(margin);
		const right = (line: string) => " ".repeat(Math.max(0, w - margin - visibleWidth(line) - margin));

		// Braille gradient top (green dim)
		const braiGreen = GRN_D + brailleGauss(innerW) + RST;

		// Top taper rule with red scanner + msg
		const content = `${RED_B}${scanner}${RST} ${dim(msg)}`;
		const titleStr = `═[ ${content} ]`;
		const titleVis = visibleWidth(titleStr);
		const leftW = Math.floor((innerW - titleVis) / 2);
		const rightW = innerW - titleVis - leftW;
		const topRule = GRN_D + taper(leftW) + titleStr + taper(rightW) + RST;

		// Bottom taper rule (green dim)
		const botRule = GRN_D + taper(innerW) + RST;

		// Braille gradient bottom (green dim)
		const braiBot = GRN_D + brailleGauss(innerW) + RST;

		return [
			wrapPanel(left + braiGreen + right(braiGreen)),
			wrapPanel(left + topRule + right(topRule)),
			wrapPanel(left + botRule + right(botRule)),
			wrapPanel(left + braiBot + right(braiBot)),
		];
	}

	dispose(): void {
		if (this.scannerTimer) clearInterval(this.scannerTimer);
	}
}
