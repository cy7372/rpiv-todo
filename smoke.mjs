// Smoke test: drive the reducer + response envelope through the same jiti
// transform pi uses at runtime. Run: node smoke.mjs
const { createJiti } = await import("file:///D:/Programs/pi-web/node_modules/jiti/lib/jiti-static.mjs");

const jiti = createJiti(import.meta.url, {
	alias: {
		typebox: "D:/Programs/pi-web/node_modules/typebox/build/index.mjs",
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
r = run("update", { id: 3, status: "completed" });
text = formatContent(r.op, state);
check("all done → summary instruction", text.includes("All tasks are now completed"));

// filter
r = run("list", { filter: "tests" });
text = formatContent(r.op, state);
check("filter 'tests' matches subject+description", text.split("\n").length === 2 && text.includes("#1") && text.includes("#2"));
r = run("list", { filter: "ALICE" });
text = formatContent(r.op, state);
check("filter case-insensitive owner", text.includes("#3") && text.split("\n").length === 1);

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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
