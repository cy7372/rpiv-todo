import type { Task, TaskAction, TaskMutationParams, TaskStatus } from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";

/**
 * Reducer outcome. Closed tagged union — adding a new action requires extending
 * this union AND the response-envelope's `formatContent` switch (compiler-
 * enforced exhaustive). Mirrors the `Effect` pattern in
 * `packages/rpiv-ask-user-question/state/state-reducer.ts:14-30`.
 *
 * `error` carries the message in-band so callers can pattern-match on
 * `op.kind === "error"` without a side-channel boolean.
 *
 * Dancher extension (2026-09-13): `update` may carry `openSubtasks` (advisory:
 * completed a parent whose children are still open) and `list` may carry
 * `filter` (free-text match, applied by the envelope).
 */
export type Op =
	| { kind: "create"; taskId: number }
	| {
			kind: "update";
			id: number;
			fromStatus: TaskStatus;
			toStatus: TaskStatus;
			changed: boolean;
			openSubtasks?: number;
	  }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean; filter?: string }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function sameNumberList(a: number[] | undefined, b: number[] | undefined): boolean {
	const x = a ?? [];
	const y = b ?? [];
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameRecord(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const PRIORITIES: ReadonlySet<string> = new Set(["P0", "P1", "P2"]);

/**
 * Validate a `parent` reference for subtask assignment: the parent must exist,
 * not be deleted, and itself be top-level (one nesting level only, so the
 * overlay never needs recursive layout). Returns an error message or null.
 */
function validateParent(state: TaskState, selfId: number | undefined, parentId: number): string | null {
	if (selfId !== undefined && parentId === selfId) return `task #${selfId} cannot be its own parent`;
	const parentTask = state.tasks.find((t) => t.id === parentId);
	if (!parentTask) return `parent: #${parentId} not found`;
	if (parentTask.status === "deleted") return `parent: #${parentId} is deleted`;
	if (parentTask.parent !== undefined)
		return `parent: #${parentId} is itself a subtask of #${parentTask.parent} (one nesting level only — attach to the top-level task instead)`;
	return null;
}

/**
 * Guardrail (2026-09-13): a task may not move to `in_progress` or `completed`
 * while any blocker is unfinished. Blocking is opt-in metadata, but once the
 * model declares a dependency, violating it is almost always drift — reject
 * with a message that teaches the fix (finish the blockers or drop the edge
 * via removeBlockedBy). Deleted blockers count as satisfied (abandoned).
 */
function unfinishedBlockers(state: TaskState, task: Task): number[] {
	if (!task.blockedBy?.length) return [];
	return task.blockedBy.filter((dep) => {
		const depTask = state.tasks.find((t) => t.id === dep);
		return depTask === undefined || (depTask.status !== "completed" && depTask.status !== "deleted");
	});
}

/**
 * Did this `update` change anything? Compares the task before/after the params
 * are applied. A no-effect update — `status` set to its current value, or any
 * field re-sent unchanged — returns false, letting the response envelope say
 * "No change" instead of "Updated #N". Without this, a no-op update is
 * indistinguishable from a real mutation, which can drive a model to re-issue
 * the same call in a loop.
 *
 * blockedBy is order-sensitive (the reducer preserves insertion order);
 * metadata round-trips through JSON persistence, so JSON-equality is the
 * operative notion of "changed".
 */
function taskChanged(before: Task, after: Task): boolean {
	return (
		before.subject !== after.subject ||
		before.status !== after.status ||
		before.description !== after.description ||
		before.activeForm !== after.activeForm ||
		before.owner !== after.owner ||
		before.parent !== after.parent ||
		before.priority !== after.priority ||
		!sameNumberList(before.blockedBy, after.blockedBy) ||
		!sameRecord(before.metadata, after.metadata)
	);
}

/**
 * Pure reducer: (state, action, params) → (state, op). The response envelope (`tool/response-envelope.ts`) owns
 * formatting, the store (`state/store.ts`) owns commit.
 *
 * Validation is in-line: structural guards (`subject required`, `id required`,
 * `at least one mutable field`) plus state-aware checks (transition legality,
 * dangling/deleted blockedBy, self-block, cycles). Decision: validation stays
 * in-reducer.
 *
 * Dancher extension (2026-09-13): `parent`/`priority` (create + update),
 * blocked-transition hard guard, timestamp bookkeeping (createdAt on create,
 * completedAt on entering `completed`, updatedAt on any real change). The
 * reducer reads the wall clock for timestamps — replayed calls re-derive them
 * at replay time, which is acceptable because they are informational only
 * (the persisted `details.tasks` snapshot remains the source of truth).
 */
export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	switch (action) {
		case "create": {
			if (!params.subject?.trim()) {
				return errorResult(state, "subject required for create");
			}
			if (params.priority !== undefined && !PRIORITIES.has(params.priority)) {
				return errorResult(state, `priority must be one of P0, P1, P2`);
			}
			if (params.parent !== undefined) {
				const err = validateParent(state, undefined, params.parent);
				if (err) return errorResult(state, err);
			}
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
				}
			}
			const now = Date.now();
			const newTask: Task = {
				id: state.nextId,
				subject: params.subject,
				status: "pending",
				createdAt: now,
				updatedAt: now,
			};
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };
			if (params.parent !== undefined) newTask.parent = params.parent;
			if (params.priority !== undefined) newTask.priority = params.priority;

			const newTasks = [...state.tasks, newTask];
			return {
				state: { tasks: newTasks, nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				params.parent !== undefined ||
				params.priority !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation)
				return errorResult(
					state,
					"update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, parent, priority, addBlockedBy, or removeBlockedBy",
				);

			if (params.priority !== undefined && !PRIORITIES.has(params.priority)) {
				return errorResult(state, `priority must be one of P0, P1, P2`);
			}
			if (params.parent !== undefined) {
				const err = validateParent(state, current.id, params.parent);
				if (err) return errorResult(state, err);
			}

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				}
				newStatus = params.status;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			// Blocked hard guard: unfinished blockers veto in_progress/completed.
			if (newStatus !== current.status && (newStatus === "in_progress" || newStatus === "completed")) {
				const withNewBlockedBy = { ...current, blockedBy: newBlockedBy.length ? newBlockedBy : undefined };
				const blockers = unfinishedBlockers(state, withNewBlockedBy);
				if (blockers.length > 0) {
					return errorResult(
						state,
						`#${current.id} is blocked by unfinished ${blockers.map((id) => `#${id}`).join(", ")} — ` +
							`finish or delete those tasks first, or remove the dependency with removeBlockedBy if it no longer applies`,
					);
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (params.parent !== undefined) updated.parent = params.parent;
			if (params.priority !== undefined) updated.priority = params.priority;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const changed = taskChanged(current, updated);
			if (changed) {
				updated.updatedAt = Date.now();
				if (newStatus === "completed" && current.status !== "completed") {
					updated.completedAt = updated.updatedAt;
				} else if (newStatus !== "completed") {
					delete updated.completedAt;
				}
			}

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;

			// Advisory: completing a parent while subtasks are still open.
			let openSubtasks: number | undefined;
			if (newStatus === "completed" && current.status !== "completed" && updated.parent === undefined) {
				openSubtasks = newTasks.filter(
					(t) => t.parent === updated.id && t.status !== "completed" && t.status !== "deleted",
				).length;
				if (openSubtasks === 0) openSubtasks = undefined;
			}

			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: {
					kind: "update",
					id: updated.id,
					fromStatus: current.status,
					toStatus: newStatus,
					changed,
					...(openSubtasks !== undefined ? { openSubtasks } : {}),
				},
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
					...(params.filter !== undefined && params.filter.trim() !== "" ? { filter: params.filter } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			const updated: Task = { ...current, status: "deleted", updatedAt: Date.now() };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			// Deleting a parent detaches its subtasks (they become top-level)
			// so no dangling parent reference survives in the state.
			for (let i = 0; i < newTasks.length; i++) {
				if (newTasks[i].parent === updated.id) {
					const detached = { ...newTasks[i] };
					delete detached.parent;
					newTasks[i] = detached;
				}
			}
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "delete", id: updated.id, subject: updated.subject },
			};
		}

		case "clear": {
			const count = state.tasks.length;
			return {
				state: { tasks: [], nextId: 1 },
				op: { kind: "clear", count },
			};
		}
	}
}
