/**
 * yinor 沉淀辅助 —— 完成的 todo 清单写入记忆服务（尽力而为，静默失败）。
 *
 * 2026-09-07 起挂在 todo-overlay.ts（TUI 路径）；2026-10-08 auto-clear-on-drain
 * 上线后清场发生在 reducer/tool 层，overlay 永远看不到「全完成」瞬间，沉淀责任
 * 随迁到 todo.ts 的 execute（TUI/DAS 两态都覆盖）。本模块是两处共享的唯一实现。
 *
 * import 走多候选路径探测（2026-09-13）：包从 npm 换 git 源安装位置变化后不断链。
 */

export interface YinorClient {
	postEpisode: (ep: Record<string, unknown>) => Promise<unknown>;
}

export async function importYinorClient(): Promise<YinorClient | undefined> {
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
				const mod = (await import(/* @vite-ignore */ candidate)) as Partial<YinorClient>;
				if (typeof mod?.postEpisode === "function") return mod as YinorClient;
			}
		} catch {
			/* probe next */
		}
	}
	return undefined;
}

export interface SedimentedTask {
	id: number;
	subject: string;
	description?: string;
	createdAt?: number;
	completedAt?: number;
}

/** 2026-10-08 沉淀增强：带 description 与每项完成耗时，清场后这里是唯一备份。 */
function formatTaskLine(t: SedimentedTask, index: number): string {
	const parts: string[] = [];
	if (t.createdAt !== undefined && t.completedAt !== undefined) {
		const ms = t.completedAt - t.createdAt;
		if (Number.isFinite(ms) && ms >= 0) {
			const minutes = Math.round(ms / 60000);
			parts.push(minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${minutes}m`);
		}
	}
	let line = `${index + 1}. ${t.subject}`;
	if (parts.length > 0) line += `（${parts[0]}）`;
	if (t.description) line += ` — ${t.description.slice(0, 80)}`;
	return line;
}

/** 完成清单写入 yinor（走 lib/yinor-client 统一出口）。fire-and-forget：绝不影响工具主流程。 */
export function sedimentCompletedList(tasks: SedimentedTask[]): void {
	void (async () => {
		try {
			if (tasks.length === 0) return;
			const mod = await importYinorClient();
			if (!mod) return;
			const body = tasks.map(formatTaskLine).join("\n");
			await mod.postEpisode({
				content: `todo 清单完成（${tasks.length} 项）：\n${body}`,
				source: "rpiv-todo",
				sourceDescription: "todo 全完成自动清场时沉淀（2026-09-07 起，2026-10-08 随 auto-clear 迁至 tool 层并增强详情）",
			});
		} catch {
			/* yinor 不可用时静默跳过 */
		}
	})();
}
