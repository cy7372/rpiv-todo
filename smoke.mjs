// Smoke test: drive the reducer + response envelope through the same jiti
// transform pi uses at runtime. Run: node smoke.mjs
//
// 2026-10-08 可移植化：jiti/typebox 按候选探测（本仓 node_modules → pandar 共享内核
// releases → Windows 开发机 D: 盘旧布局），不再硬编码单一路径，任何 dancher 机能跑。
const { existsSync, readdirSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const nodePath = await import("node:path");
const HERE = nodePath.dirname(fileURLToPath(new URL(".", import.meta.url)));

function probe(rel) {
	const candidates = [nodePath.resolve(HERE, "node_modules", rel)];
	// 2026-10-10 修复：补共享根候选（共享 npm 根 + 部署副本自带 node_modules）——此前
	// 只探测 HERE/node_modules / 内核 releases / D: 盘旧布局，无 node_modules 的检出版
	// （如 /var/tmp 开发树）会一路落到 D: 盘候选报 ERR_MODULE_NOT_FOUND。
	const sharedRoot = "/opt/dancher/pi/plugins";
	for (const base of [
		nodePath.join(sharedRoot, "npm", "node_modules"),
		nodePath.join(sharedRoot, "packages", "rpiv-todo", "node_modules"),
	]) {
		const p = nodePath.join(base, rel);
		if (existsSync(p)) candidates.push(p);
	}
	const kernelRoot = "/opt/dancher/pi/install/releases";
	if (existsSync(kernelRoot)) {
		for (const ver of readdirSync(kernelRoot).sort().reverse()) {
			candidates.push(nodePath.join(kernelRoot, ver, "node_modules", rel));
		}
	}
	candidates.push(`D:/Programs/pi-web/node_modules/${rel}`);
	const hit = candidates.find((p) => existsSync(p));
	if (!hit) throw new Error(`smoke.mjs: 找不到 ${rel}（探测过 ${candidates.length} 个候选）`);
	return hit;
}

const { createJiti } = await import(probe("jiti/lib/jiti-static.mjs"));
const jiti = createJiti(import.meta.url, {
	alias: {
		typebox: probe("typebox/build/index.mjs"),
		"../tool/types.js": new URL("./tool/types.ts", import.meta.url).href,
	},
});

const { applyTaskMutation } = await jiti.import("./state/state-reducer.ts", { default: false });
const { formatContent } = await jiti.import("./tool/response-envelope.ts", { default: false });

let state = { tasks: [], nextId: 1 };
let failures = 0;
function check(name, cond, extra = "") {
	const ok = typeof cond === "function" ? cond() : cond;
	console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${extra}`}`);
	if (!ok) failures++;
}
function run(action, params) {
	const r = applyTaskMutation(state, action, params);
	if (r.op.kind !== "error") state = r.state;
	return r;
}

// 1. create: priority, parent, timestamps
let r = run("create", { subject: "parent task", priority: "P0" });
check("create #1 P0", r.op.kind === "create" && r.op.taskId === 1);
r = run("create", { subject: "subtask A", parent: 1 });
check("create #2 subtask of #1", r.op.kind === "create");
const t2 = state.tasks.find((t) => t.id === 2);
check("subtask has parent + createdAt", t2.parent === 1 && typeof t2.createdAt === "number");
r = run("create", { subject: "child of child", parent: 2 });
check("nested parent rejected", r.op.kind === "error" && r.op.message.includes("one nesting level"));
r = run("create", { subject: "blocked task", blockedBy: [1] });
check("create #3 blockedBy #1", r.op.kind === "create");
r = run("create", { subject: "bad priority", priority: "P9" });
check("bad priority rejected", r.op.kind === "error");

// 2. blocked hard guard
r = run("update", { id: 3, status: "in_progress" });
check("blocked → in_progress rejected", r.op.kind === "error" && r.op.message.includes("#1"));
r = run("update", { id: 1, status: "in_progress", activeForm: "working" });
check("blocker in_progress ok", r.op.kind === "update" && r.op.changed);
r = run("update", { id: 1, status: "completed" });
check("blocker completed ok", r.op.kind === "update");
const t1 = state.tasks.find((t) => t.id === 1);
check("completedAt set on completion", typeof t1.completedAt === "number");
r = run("update", { id: 3, status: "in_progress" });
check("unblocked task can start", r.op.kind === "update");

// 3. reopen
r = run("update", { id: 1, status: "in_progress" });
check("completed → in_progress reopen ok", r.op.kind === "update");
const t1b = state.tasks.find((t) => t.id === 1);
check("completedAt cleared on reopen", t1b.completedAt === undefined);
r = run("update", { id: 1, status: "completed" });

// 4. parent with open subtask advisory
r = run("update", { id: 2, status: "completed" });
r = run("update", { id: 1, status: "in_progress" }); // reopen then complete again? #1 already completed
r = run("update", { id: 1, status: "in_progress" });
r = run("update", { id: 1, status: "completed" });
check("no openSubtasks when all children done", r.op.kind === "update" && r.op.openSubtasks === undefined);

// 5. undelete
r = run("delete", { id: 2 });
check("delete #2", r.op.kind === "delete");
check("deleted child keeps parent ref until parent deleted", state.tasks.find((t) => t.id === 2).parent === 1);
r = run("update", { id: 2, status: "pending" });
check("deleted → pending undelete ok", r.op.kind === "update");
r = run("delete", { id: 1 });
check("delete parent #1 detaches #2", state.tasks.find((t) => t.id === 2).parent === undefined);

// rebuild a clean scenario for all-done + filter
state = { tasks: [], nextId: 1 };
run("create", { subject: "alpha: write tests" });
run("create", { subject: "beta: run tests", description: "runs the vitest suite" });
run("create", { subject: "gamma: docs", owner: "alice" });
r = run("update", { id: 1, status: "in_progress" });
r = run("update", { id: 1, status: "completed" });
let text = formatContent(r.op, state);
check("not all done → no suffix", !text.includes("deliver the final summary"));
r = run("update", { id: 2, status: "completed" });
text = formatContent(r.op, state);
check("still not all done", !text.includes("deliver the final summary"));

// filter（必须在 drain 之前跑：auto-clear 会清场，见下）
r = run("list", { filter: "tests" });
text = formatContent(r.op, state);
check("filter 'tests' matches subject+description", text.split("\n").length === 2 && text.includes("#1") && text.includes("#2"));
r = run("list", { filter: "ALICE" });
text = formatContent(r.op, state);
check("filter case-insensitive owner", text.includes("#3") && text.split("\n").length === 1);

// auto-clear-on-drain（2026-10-08）：完成最后一个任务 → 同 op 连带 clear 语义
r = run("update", { id: 3, status: "completed" });
text = formatContent(r.op, state);
check("all done → summary instruction", text.includes("All tasks are now completed"));
check(
	"auto-clear: op 携带计数与任务详情",
	r.op.kind === "update" && r.op.autoCleared === 3 && Array.isArray(r.op.clearedTasks) && r.op.clearedTasks.length === 3 && r.op.clearedTasks.every((t) => typeof t.subject === "string"),
	JSON.stringify(r.op),
);
check("auto-clear: 清单已清空、nextId 归 1", state.tasks.length === 0 && state.nextId === 1);
check("auto-clear: 尾注提示清场", text.includes("auto-cleared"));

// 清场后开新组：id 从 1 重新起算；单任务组 drain 同样触发
r = run("create", { subject: "new group task" });
check("post-clear create restarts ids", r.op.kind === "create" && r.op.taskId === 1);
r = run("update", { id: 1, status: "completed" });
check("single-task drain also auto-clears", r.op.kind === "update" && r.op.autoCleared === 1);

r = run("list", {});
check("post-drain list is empty", formatContent(r.op, state) === "No tasks");

// waiting-user / blocked（2026-10-08）：新状态合法转移 + 不算完成
state = { tasks: [], nextId: 1 };
run("create", { subject: "waits on user" }); // #1
run("create", { subject: "external stall" }); // #2
r = run("update", { id: 1, status: "waiting-user" });
check("pending → waiting-user ok", r.op.kind === "update" && r.op.toStatus === "waiting-user");
r = run("update", { id: 2, status: "blocked" });
check("pending → blocked ok", r.op.kind === "update" && r.op.toStatus === "blocked");
r = run("update", { id: 1, status: "completed" });
check("waiting-user → completed ok", r.op.kind === "update" && r.op.changed === true);
check("waiting/blocked 任务未全完成 → 不清场", state.tasks.length === 2);
r = run("update", { id: 2, status: "completed" });
check("最后 blocked 完成后仍触发清场", r.op.kind === "update" && r.op.autoCleared === 2);

// completed → waiting-user 非法（重开须先经 in_progress/pending）
state = { tasks: [], nextId: 1 };
run("create", { subject: "done thing" });
run("update", { id: 1, status: "completed" });
r = run("update", { id: 1, status: "waiting-user" });
check("completed → waiting-user rejected", r.op.kind === "error");

// autoClearOnDrain: false（2026-10-08）：关开关保留旧行为
state = { tasks: [], nextId: 1 };
run("create", { subject: "keep me" });
let saved = applyTaskMutation(state, "update", { action: "update", id: 1, status: "completed" }, { autoClearOnDrain: false });
state = saved.state;
check(
	"autoClearOnDrain:false 不清场，all-done 兜底提示仍在",
	state.tasks.length === 1 && state.tasks[0].status === "completed" && formatContent(saved.op, state).includes("All tasks are now completed"),
);

// priority sort + subtask interleave in overlay layout
const { selectOverlayLayout } = await jiti.import("./state/selectors.ts", { default: false });
state = { tasks: [], nextId: 1 };
run("create", { subject: "low prio work", priority: "P2" });
run("create", { subject: "urgent fix", priority: "P0" });
run("create", { subject: "normal work" });
run("create", { subject: "urgent sub", parent: 2 });
const layout = selectOverlayLayout(state, 12);
check(
	"overlay order: P0 parent, its subtask, then unset/P1, then P2",
	JSON.stringify(layout.visible.map((t) => t.id)) === JSON.stringify([2, 4, 3, 1]),
	JSON.stringify(layout.visible.map((t) => [t.id, t.priority])),
);
check("no overflow", layout.hiddenCompleted === 0 && layout.truncatedTail === 0);

// plan（2026-10-10）：批量建轴——一次调用建 N 条，key 依赖回填 blockedBy
state = { tasks: [], nextId: 1 };
run("create", { subject: "pre-existing task" }); // #1
r = run("plan", {
	items: [
		{ subject: "research existing tool", key: "research", priority: "P0" },
		{ subject: "implement feature", key: "impl", dependsOn: ["research"] },
		{ subject: "write tests", key: "tests", dependsOn: ["research", "impl"], blockedBy: [1] },
		{ subject: "edge cases", parent: "tests" },
		{ subject: "docs update", blockedBy: [1] },
	],
});
check(
	"plan creates 5 tasks, state grows to 6",
	r.op.kind === "plan" && r.op.count === 5 && state.tasks.length === 6 && state.nextId === 7,
	JSON.stringify(r.op),
);
check("plan ids sequential from nextId", r.op.kind === "plan" && JSON.stringify(r.op.ids) === JSON.stringify([2, 3, 4, 5, 6]));
const implTask = state.tasks.find((t) => t.id === 3);
check("plan dependsOn wired into blockedBy", implTask.blockedBy.join(",") === "2", JSON.stringify(implTask.blockedBy));
const testsTask = state.tasks.find((t) => t.id === 4);
check(
	"plan merges dependsOn + numeric blockedBy",
	testsTask.blockedBy.join(",") === "1,2,3" && testsTask.parent === undefined,
	JSON.stringify(testsTask.blockedBy),
);
const edgeTask = state.tasks.find((t) => t.id === 5);
check("plan parent-by-key nests", edgeTask.parent === 4);
check("plan op carries key→id map", r.op.kind === "plan" && r.op.keys && r.op.keys.research === 2 && r.op.keys.impl === 3);
text = formatContent(r.op, state);
check(
	"plan response lists subjects + keys + deps",
	text.includes("Planned 5 tasks") && text.includes("[key: research]") && text.includes("⛓ #2"),
	text,
);
r = run("update", { id: 6, status: "in_progress" });
check("plan-created blockedBy enforced", r.op.kind === "error" && r.op.message.includes("#1"));

// plan 校验拒绝（原子：失败批零改动）
r = run("plan", { items: [] });
check("plan empty items rejected", r.op.kind === "error" && r.op.message.includes("items[]"));
r = run("plan", { subject: "not items" });
check("plan without items rejected", r.op.kind === "error");
r = run("plan", { items: [{ subject: "a", key: "x" }, { subject: "b", key: "x" }] });
check("plan duplicate key rejected", r.op.kind === "error" && r.op.message.includes("duplicate key"));
r = run("plan", { items: [{ subject: "a", key: "x" }, { subject: "b", dependsOn: ["nope"] }] });
check("plan unknown dependsOn key rejected", r.op.kind === "error" && r.op.message.includes("nope"));
r = run("plan", { items: [{ subject: "a", key: "x", dependsOn: ["x"] }] });
check("plan self-dependency rejected", r.op.kind === "error");
r = run("plan", { items: [{ subject: "a", key: "x", dependsOn: ["y"] }, { subject: "b", key: "y", dependsOn: ["x"] }] });
check("plan dependsOn cycle rejected", r.op.kind === "error" && r.op.message.includes("cycle"));
r = run("plan", { items: [{ subject: "a", key: "x" }, { subject: "b", key: "b", parent: "x" }, { subject: "c", parent: "b" }] });
check("plan parent-of-subtask rejected (one level)", r.op.kind === "error" && r.op.message.includes("one nesting level"));
r = run("plan", { items: Array.from({ length: 26 }, (_, i) => ({ subject: `t${i}` })) });
check("plan >25 items rejected", r.op.kind === "error" && r.op.message.includes("at most 25"));
r = run("plan", { items: [{ subject: "" }] });
check("plan empty subject rejected", r.op.kind === "error");
check("failed plans leave state untouched", state.tasks.length === 6 && state.nextId === 7);

// 末子任务完成 → 收父任务提示（2026-10-10）
state = { tasks: [], nextId: 1 };
run("create", { subject: "parent" }); // #1
run("create", { subject: "child A", parent: 1 });
run("create", { subject: "child B", parent: 1 });
r = run("update", { id: 2, status: "completed" });
check("non-last subtask completion: no nudge", r.op.kind === "update" && r.op.parentReady === undefined);
r = run("update", { id: 3, status: "completed" });
text = formatContent(r.op, state);
check(
	"last subtask done → parent close-out nudge",
	r.op.kind === "update" && r.op.parentReady === 1 && text.includes("close out #1"),
	text,
);
check("nudge 不触发清场（父未完）", r.op.autoCleared === undefined && state.tasks.length === 3);
r = run("update", { id: 1, status: "completed" });
check("parent completion drains without nudge", r.op.kind === "update" && r.op.autoCleared === 3 && r.op.parentReady === undefined);

// list/get 陈旧提示（2026-10-10）：in_progress 挂超 2h 带 ⏳ 年龄；waiting-user/blocked 不提示
state = { tasks: [], nextId: 1 };
run("create", { subject: "fresh task" });
run("update", { id: 1, status: "in_progress" });
r = run("list", {});
const nowMs = Date.now();
check("fresh in_progress: no age hint", !formatContent(r.op, state, nowMs).includes("⏳"));
check("3h in_progress: age hint", formatContent(r.op, state, nowMs + 3 * 3600_000).includes("⏳ 3.0h"));
run("update", { id: 1, status: "waiting-user" });
r = run("list", {});
check("waiting-user parked: never hints", !formatContent(r.op, state, nowMs + 3 * 3600_000).includes("⏳"));
run("update", { id: 1, status: "in_progress" });
r = run("get", { id: 1 });
text = formatContent(r.op, state, nowMs + 3 * 3600_000);
check("get: updated row + stale hint", text.includes("updated:") && text.includes("⏳"), text);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
