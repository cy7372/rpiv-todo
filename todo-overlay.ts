/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, configurable collapse-not-scroll (default 12 content rows via
 * getMaxWidgetLines(); plus a trailing spacer row so the widget renders up
 * to 13 lines), Pi tool-output expansion awareness, auto-hide when empty.
 *
 * Reads live state via `getRenderState()` (the ctx-less foreground slot) at render
 * time — NEVER `replayFromBranch` from `tool_execution_end` (branch is stale;
 * `message_end` runs after).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, getMaxWidgetLines, resolveCollapseKey } from "./config.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { selectHasActive, selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./state/selectors.js";
import { getRenderState } from "./state/store.js";
import { formatOverlayTaskLine } from "./view/format.js";

const WIDGET_KEY = "rpiv-todos";

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_EXPAND_HINT = "{key} to expand";
const OVERLAY_COLLAPSED = "collapsed";

// dancher extension (2026-09-13): 8-cell progress bar for the heading.
const PROGRESS_CELLS = 8;
function progressBar(done: number, total: number): string {
	if (total <= 0) return "";
	const filled = Math.round((done / total) * PROGRESS_CELLS);
	return "▓".repeat(filled) + "░".repeat(PROGRESS_CELLS - filled);
}

/**
 * dancher extension (2026-09-13): resolve the dancher yinor-client relative to
 * this package's runtime location. Supported layouts (all probed with
 * fs.existsSync before import, first hit wins):
 *   - npm install:  ~/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo/  (3 up)
 *   - git source:   ~/.pi/agent/git/<host>/<owner>/<repo>/               (4 up)
 *   - dev checkout: any ancestor .pi/agent/extensions/dancher/…
 * Falls back to the USERPROFILE-anchored absolute path. All-quiet on failure.
 */
async function importYinorClient(): Promise<{ postEpisode: (ep: Record<string, unknown>) => Promise<unknown> } | undefined> {
	const { existsSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const path = await import("node:path");
	const here = path.dirname(fileURLToPath(import.meta.url));
	const home = process.env.USERPROFILE ?? process.env.HOME;
	const candidates = [
		path.resolve(here, "../../../extensions/dancher/lib/yinor-client.js"), // npm layout
		path.resolve(here, "../../../../extensions/dancher/lib/yinor-client.js"), // git-source clone layout
		...(home ? [path.join(home, ".pi/agent/extensions/dancher/lib/yinor-client.js")] : []),
	];
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) {
				const mod = (await import(/* @vite-ignore */ candidate)) as {
					postEpisode: (ep: Record<string, unknown>) => Promise<unknown>;
			};
				if (typeof mod?.postEpisode === "function") return mod;
			}
		} catch {
			/* probe next */
		}
	}
	return undefined;
}

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;
	private collapsed = false;
	// 本地补丁（2026-09-07）：全完成 toast/yinor 沉淀的一次性门闩（出现新未完成任务时重置）
	private allCompletedHandled = false;

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const snapshot = this.getSnapshot();
		const alive = snapshot.tasks.filter((task) => task.status !== "deleted");
		// 本地补丁（2026-09-07）：出现非完成任务 → 重置全完成门闩，允许下次转换再触发
		if (alive.some((task) => task.status !== "completed")) this.allCompletedHandled = false;

		this.updateStatusBar(alive); // 本地补丁（2026-09-07）：状态栏 todo 进度

		const visible = this.selectOverlayTasks(snapshot);

		if (visible.length === 0) {
			// 本地补丁（2026-09-07）：全完成转换瞬间（widgetRegistered 佐证本会话观察到过未完成态，
			// replay 恢复即全完成的场景不触发）→ toast 正反馈 + yinor 沉淀，各一次
			if (
				alive.length > 0 &&
				alive.every((task) => task.status === "completed") &&
				this.widgetRegistered &&
				!this.allCompletedHandled
			) {
				this.allCompletedHandled = true;
				this.fireAllCompleted(alive);
			}
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {
							// No rendered strings are cached. Pi invalidates on theme changes;
							// the next render reads uiCtx.theme.
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}

	toggleCollapse(): void {
		this.collapsed = !this.collapsed;
		// Forced full redraw on the collapsed↔expanded height step, mirroring the
		// lane-dock's requestRender(shapeChanged); distinct from the non-forced
		// requestRender() refresh paths in update()/hideCompletedTasksFromPreviousTurn().
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	/** 本地补丁（2026-09-07）：全部完成瞬间的一次性正反馈（toast）+ 记忆沉淀（yinor） */
	private fireAllCompleted(tasks: { id: number; subject: string }[]): void {
		try {
			this.uiCtx?.notify?.(`✓ Todos 全部完成（${tasks.length}/${tasks.length}）`, "info");
		} catch {
			/* toast 失败不影响主流程 */
		}
		void this.persistToYinor(tasks);
	}

	/** 本地补丁（2026-09-07）：完成清单写入 yinor（走 lib/yinor-client 统一出口，静默尽力而为）。
	 * 2026-09-13：import 改多候选探测，包从 npm 换 git 源安装位置变化后不再断链。 */
	private async persistToYinor(tasks: { subject: string }[]): Promise<void> {
		try {
			const mod = await importYinorClient();
			if (!mod) return;
			const lines = tasks.map((t) => t.subject).filter(Boolean).join("；");
			if (!lines) return;
			await mod.postEpisode({
				content: `todo 清单完成（${tasks.length} 项）：${lines}`,
				source: "rpiv-todo",
				sourceDescription: "todo 全完成时自动沉淀（本地补丁 2026-09-07）",
			});
		} catch {
			/* yinor 不可用时静默跳过，绝不影响 overlay */
		}
	}

	/** 本地补丁（2026-09-07）：状态栏 todo 进度（有活跃任务时 “N/M ● 当前任务名”） */
	private updateStatusBar(alive: { status: string; subject: string }[]): void {
		try {
			const total = alive.length;
			const done = alive.filter((t) => t.status === "completed").length;
			if (total === 0 || done === total) {
				this.uiCtx?.setStatus?.("rpiv-todo", undefined as never);
				return;
			}
			const current =
				alive.find((t) => t.status === "in_progress") ?? alive.find((t) => t.status === "pending");
			const label = current ? ` ● ${current.subject.slice(0, 24)}` : "";
			this.uiCtx?.setStatus?.("rpiv-todo", `${done}/${total}${label}`);
		} catch {
			/* 状态栏失败不影响主流程 */
		}
	}

	private getSnapshot() {
		const state = getRenderState();
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		const completedTaskIds = new Set(
			state.tasks.filter((task) => task.status === "completed").map((task) => task.id),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
		}
		return { tasks: [...state.tasks], nextId: state.nextId };
	}

	private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
		const alive = snapshot.tasks.filter((task) => task.status !== "deleted");
		// 本地补丁（2026-09-07）：全部完成时立即隐藏整个 overlay——完成清单无信息价值，
		// 原设计要等下一轮 agent_start 的 hideCompletedTasksFromPreviousTurn 才收，会话若就此结束则永远挂着。
		// ⚠️ pi update npm:@juicesharp/rpiv-todo 会覆盖本补丁（登记于 ~/.pi/COMPONENTS.md §2）。
		if (alive.length > 0 && alive.every((task) => task.status === "completed")) return [];
		return alive.filter((task) => !this.shouldHideCompletedTask(task));
	}

	/** 本地补丁（2026-09-11）：alt-screen (tuiMode: fullscreen) 滚离底部检测。
	 * TuiAltScreen 公开 getter；TuiMainScreen（regular 模式）无此属性 → 永远 false，不影响。 */
	private isScrolledUp(): boolean {
		const tui = this.tui as { isFollowingOutput?: boolean } | undefined;
		return tui !== undefined && typeof tui.isFollowingOutput === "boolean" && !tui.isFollowingOutput;
	}

	private shouldHideCompletedTask(task: ReturnType<TodoOverlay["getSnapshot"]>["tasks"][number]): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		if (overlayTasks.length === 0) return [];

		const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(overlayState);
		const hasActive = selectHasActive(overlayState);
		const showIds = selectShowTaskIds(overlayState);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const bar = progressBar(counts.completed, counts.total);
		const headingText = bar
			? `${t("overlay.heading", OVERLAY_HEADING)} ${bar} (${counts.completed}/${counts.total})`
			: `${t("overlay.heading", OVERLAY_HEADING)} (${counts.completed}/${counts.total})`;
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);

		// Collapsed view: just the heading + a dim "└─" expand hint, then the
		// trailing spacer. Short-circuit before the budget math and the completed-
		// display tracking — nothing is shown to track, and skipping the tracking
		// when nothing is rendered is correctness, not optimization. The hint splices
		// the resolved key into the {key} placeholder (per-render, like the row
		// budget); a config edit needs /reload to re-bind the actual shortcut. The
		// "off" sentinel is reachable here mid-session (config edited after the
		// shortcut was bound and the overlay collapsed) — render a static collapsed
		// label instead of splicing the sentinel into the placeholder.
		if (this.collapsed) {
			const key = resolveCollapseKey();
			const hint =
				key === COLLAPSE_KEY_OFF
					? t("overlay.collapsed", OVERLAY_COLLAPSED)
					: t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace("{key}", key);
			return this.withTrailingSpacer([heading, truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`)]);
		}

		// 本地补丁（2026-09-11）：fullscreen (alt-screen) 翻阅历史时收缩为单行 heading。
		// transcript 滚动不带动固定 dock，长任务列表会长期遮屏；isFollowingOutput === false
		// 即滚离底部（每次 doRender 全量重渲染，滚动后状态必被读到）。regular 模式的 TUI
		// 无此属性，特性检测跳过，行为不变。回到底部自动恢复完整列表。
		if (this.isScrolledUp()) {
			return this.withTrailingSpacer([truncate(`${heading} ${theme.fg("dim", "↕")}`)]);
		}

		const lines: string[] = [heading];
		// Budget for content rows (heading + tasks/summary). The rendered widget is
		// one line taller — withTrailingSpacer() appends a blank row below the panel.
		// Pi's global tool-output expansion mode is read on every render so its
		// expand/collapse shortcut also expands this live widget. Optional chaining
		// preserves compatibility with hosts predating getToolsExpanded().
		const bodyBudget = this.uiCtx?.getToolsExpanded?.() === true ? overlayTasks.length : getMaxWidgetLines() - 1;
		const layout = selectOverlayLayout(overlayState, bodyBudget);
		for (const task of layout.visible) {
			lines.push(
				truncate(
					`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds, snapshot.tasks)}`,
				),
			);
		}

		const newlyDisplayedCompletedTaskIds = overlayTasks
			.filter(
				(task) =>
					task.status === "completed" &&
					!this.completedTaskIdsPendingHide.has(task.id) &&
					!this.hiddenCompletedTaskIds.has(task.id),
			)
			.map((task) => task.id);
		for (const taskId of newlyDisplayedCompletedTaskIds) {
			this.completedTaskIdsPendingHide.add(taskId);
		}

		if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return this.withTrailingSpacer(lines);
		}

		const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
		if (layout.truncatedTail > 0) overflowParts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
		const more = t("overlay.more", OVERLAY_MORE);
		const summary =
			overflowParts.length > 0 ? `+${totalHidden} ${more} (${overflowParts.join(", ")})` : `+${totalHidden} ${more}`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
		return this.withTrailingSpacer(lines);
	}

	/**
	 * Append a trailing blank line so the overlay isn't flush against the
	 * editor box. Pi's host adds a leading spacer above the widget but none
	 * below, which leaves the last "└─" row (or the "+N more" summary) glued
	 * to the input box. The empty string gives the "Todos" panel a little
	 * breathing room.
	 */
	private withTrailingSpacer(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		lines.push("");
		return lines;
	}

	dispose(): void {
		if (this.uiCtx) {
			this.uiCtx.setWidget(WIDGET_KEY, undefined);
			try {
				this.uiCtx.setStatus?.("rpiv-todo", undefined as never); // 本地补丁：清状态栏
			} catch {
				/* ignore */
			}
		}
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.collapsed = false;
		this.resetCompletedDisplayState();
	}
}
