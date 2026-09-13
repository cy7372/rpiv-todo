import type { TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import { deriveBlocks } from "../state/task-graph.js";
import { sanitizeTerminalText } from "./sanitize.js";
import type { Task, TaskAction, TaskDetails, TaskMutationParams, TaskPriority } from "./types.js";

/** Badge for the plain-text list/get lines: only set priorities are shown. */
function priorityBadge(priority: TaskPriority | undefined): string {
	if (!priority) return "";
	return `${priority} `;
}

/** Short local timestamp for the `get` view; `sv-SE` locale ≈ ISO-like local time. */
function formatTs(ts: number | undefined): string | undefined {
	if (ts === undefined) return undefined;
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
		d.getHours(),
	).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Format a single task as a `[status] #id subject [(activeForm)] [⛓ #dep,…]`
 * line. Used by the `list` content branch only — the overlay and `/todos`
 * formatting paths use `view/format.ts` for richer presentations.
 *
 * Dancher extension (2026-09-13): `P0/P1/P2` prefix badge and `↳#parent` suffix.
 */
function formatListLine(t: Task): string {
	const badge = priorityBadge(t.priority);
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const parent = t.parent !== undefined ? ` ↳#${t.parent}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	return `[${t.status}] ${badge}#${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}${parent}`;
}

/**
 * Multi-line presentation for the `get` action. Order of the original rows is
 * pinned by pre-refactor `todo.ts:354-376` — description, activeForm,
 * blockedBy, blocks, owner — so envelope-level snapshot tests stay
 * byte-equivalent. The 2026-09-13 rows (priority, parent, created, completed)
 * append after `owner` to keep that guarantee.
 */
function formatGetLines(task: Task, state: TaskState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${priorityBadge(task.priority)}${sanitizeTerminalText(task.subject)}`];
	if (task.description) lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
	if (task.activeForm) lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
	if (task.blockedBy?.length) {
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.owner) lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
	if (task.parent !== undefined) {
		const parentSubject = state.tasks.find((t) => t.id === task.parent)?.subject;
		lines.push(`  parent: #${task.parent}${parentSubject ? ` (${sanitizeTerminalText(parentSubject)})` : ""}`);
	}
	const created = formatTs(task.createdAt);
	if (created) lines.push(`  created: ${created}`);
	const done = formatTs(task.completedAt);
	if (done) lines.push(`  completed: ${done}`);
	return lines.join("\n");
}

/**
 * Case-insensitive substring filter for the `list` action: matches against
 * subject, description, and owner (2026-09-13). `filter` is optional and
 * empty-after-trim filters are no-ops.
 */
function applyListFilter(tasks: readonly Task[], filter: string): readonly Task[] {
	const needle = filter.trim().toLowerCase();
	if (!needle) return tasks;
	return tasks.filter((t) => {
		const hay = [t.subject, t.description ?? "", t.owner ?? ""].join("\n").toLowerCase();
		return hay.includes(needle);
	});
}

/**
 * The all-done guardrail (2026-09-13, after Ona's "rethinking the todo tool"):
 * when a `completed` transition drains the list of all unfinished work, the
 * tool result itself carries the next instruction — deliver the summary. The
 * most common end-of-list failure mode isn't a failed task, it's the model
 * quietly continuing instead of wrapping up.
 */
const ALL_DONE_SUFFIX =
	"\nAll tasks are now completed — deliver the final summary to the user now (results, deviations, follow-ups). Do not start new work without new instructions.";

/**
 * Pure formatter: `(op, state) → string`. Closed switch on `op.kind` —
 * adding a new `Op` variant fails to compile here until a branch is added.
 * The strings on each branch are byte-equivalent to pre-refactor `todo.ts`
 * reducer output (dancher extensions noted inline).
 */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const t = state.tasks.find((x) => x.id === op.taskId);
			// Defensive — `op.taskId` always resolves on success path.
			if (!t) return `Created #${op.taskId}`;
			const parent = t.parent !== undefined ? ` ↳#${t.parent}` : "";
			return `Created #${t.id}: ${sanitizeTerminalText(t.subject)} (pending${parent})`;
		}
		case "update": {
			if (!op.changed) {
				return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
			}
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			let text = `Updated #${op.id}${transition}`;
			if (op.openSubtasks !== undefined) {
				text += `\nNote: #${op.id} has ${op.openSubtasks} unfinished subtask(s) — complete or delete them, or fold their state into the summary.`;
			}
			if (op.toStatus === "completed" && allDone(state)) {
				text += ALL_DONE_SUFFIX;
			}
			return text;
		}
		case "delete":
			return `Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`;
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			let view: readonly Task[] = state.tasks;
			if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
			if (op.filter) view = applyListFilter(view, op.filter);
			return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `Error: ${op.message}`;
	}
}

/** Any alive (non-deleted) task still pending or in_progress? */
function allDone(state: TaskState): boolean {
	const alive = state.tasks.filter((t) => t.status !== "deleted");
	return alive.length > 0 && alive.every((t) => t.status === "completed");
}

/**
 * Build the LLM-facing tool envelope after the store has committed the
 * reducer's new state. `details` is the persistence + replay snapshot —
 * `state/replay.ts` consumes this exact shape on session lifecycle events.
 *
 * Mirrors `packages/rpiv-ask-user-question/tool/response-envelope.ts:13-47`.
 */
export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
	const text = formatContent(op, state);
	const details: TaskDetails = {
		action,
		params: params as Record<string, unknown>,
		tasks: state.tasks,
		nextId: state.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
	};
	return { content: [{ type: "text", text }], details };
}
