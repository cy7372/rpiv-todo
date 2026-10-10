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
			/** Dancher extension (2026-10-10): 末子任务完成——父任务全部子任务已完且父未完，提示收掉父任务。 */
			parentReady?: number;
			/** Dancher extension (2026-10-08): auto-clear-on-drain — 完成最后一个任务时连带 clear 语义（清场计数）。 */
			autoCleared?: number;
			/** 同上：被清场任务详情（subject/description/时间戳），供 tool 层沉淀进 yinor（状态已清空，只能骑在 op 上）。 */
			clearedTasks?: { id: number; subject: string; description?: string; createdAt?: number; completedAt?: number }[];
		}
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean; filter?: string }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	/** Dancher extension (2026-10-10): plan 批量建轴——一次调用建 N 条任务，key→id 映射骑在 op 上供响应展示。 */
	| { kind: "plan"; count: number; ids: number[]; keys?: Record<string, number> }
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

/** plan 批量上限（2026-10-10）：防一次调用塞爆响应/状态；更大的轴分多次 plan。 */
const PLAN_MAX_ITEMS = 25;

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
export interface MutationOptions {
	/** Dancher extension (2026-10-08)：auto-clear-on-drain 开关，缺省 true（todo.ts execute 读 config 传入）。 */
	autoClearOnDrain?: boolean;
}

export function applyTaskMutation(
	state: TaskState,
	action: TaskAction,
	params: TaskMutationParams,
	options: MutationOptions = {},
): ApplyResult {
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

			// Dancher extension (2026-10-10): 末子任务完成 → 提示收父任务（与上面的 openSubtasks
			// 提示对称）。父任务存在、未完未删，且其余子任务全部完成/删除时才触发；父任务自己
			// 就是清单尾巴的情况由 auto-clear 接管（父未完 → 不 drain，nudge 先行）。
			let parentReady: number | undefined;
			if (newStatus === "completed" && current.status !== "completed" && updated.parent !== undefined) {
				const parentTask = newTasks.find((t) => t.id === updated.parent);
				if (parentTask && parentTask.status !== "completed" && parentTask.status !== "deleted") {
					const openSiblings = newTasks.filter(
						(t) => t.parent === updated.parent && t.id !== updated.id && t.status !== "completed" && t.status !== "deleted",
					).length;
					if (openSiblings === 0) parentReady = updated.parent;
				}
			}

			// Dancher extension (2026-10-08): auto-clear-on-drain — 真实的 completed 转换把清单
			// 的未完成工作清零时，同一 op 连带 clear 语义（tasks 清空、nextId 归 1），下一组从
			// 白板开始（用户裁决：滚动堆积新旧清单会稀释进度视图信号）。subject 骑在 op 上，
			// 由 todo.ts 的 execute 在状态被抹掉前负责沉淀。
			let autoCleared: number | undefined;
			let clearedTasks: NonNullable<Extract<Op, { kind: "update" }>["clearedTasks"]> | undefined;
			if (
				options.autoClearOnDrain !== false &&
				changed &&
				newStatus === "completed" &&
				current.status !== "completed"
			) {
				const alive = newTasks.filter((t) => t.status !== "deleted");
				if (alive.length > 0 && alive.every((t) => t.status === "completed")) {
					autoCleared = alive.length;
					clearedTasks = alive.map((t) => ({
						id: t.id,
						subject: t.subject,
						...(t.description !== undefined ? { description: t.description } : {}),
						...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}),
						...(t.completedAt !== undefined ? { completedAt: t.completedAt } : {}),
					}));
				}
			}

				return {
				state: autoCleared !== undefined ? { tasks: [], nextId: 1 } : { tasks: newTasks, nextId: state.nextId },
				op: {
					kind: "update",
					id: updated.id,
					fromStatus: current.status,
					toStatus: newStatus,
					changed,
					...(openSubtasks !== undefined ? { openSubtasks } : {}),
					...(parentReady !== undefined ? { parentReady } : {}),
					...(autoCleared !== undefined ? { autoCleared, clearedTasks } : {}),
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

		case "plan": {
			// Dancher extension (2026-10-10): 批量建轴——一次调用铺整条任务轴（mission 工具的
			// items[] 心智模型）。原子语义：任何一项校验失败，整批拒绝、状态零改动。两段式：
			// 先校验+建任务（拿 id），再回填 dependsOn/parent（key→id 解析）。
			const items = params.items;
			if (!Array.isArray(items) || items.length === 0) {
				return errorResult(state, "items[] required for plan (at least one task per call)");
			}
			if (items.length > PLAN_MAX_ITEMS) {
				return errorResult(state, `plan accepts at most ${PLAN_MAX_ITEMS} items per call — split into multiple plan calls`);
			}

			// Pass 0a: 逐项结构校验 + key 收集（唯一性）。
			const keyToIndex = new Map<string, number>();
			for (let i = 0; i < items.length; i++) {
				const it = items[i];
				if (typeof it.subject !== "string" || !it.subject.trim()) {
					return errorResult(state, `items[${i}]: subject required`);
				}
				if (it.priority !== undefined && !PRIORITIES.has(it.priority)) {
					return errorResult(state, `items[${i}]: priority must be one of P0, P1, P2`);
				}
				if (it.key !== undefined) {
					const k = String(it.key).trim();
					if (!k) return errorResult(state, `items[${i}]: key must be a non-empty alias`);
					if (keyToIndex.has(k)) return errorResult(state, `items[${i}]: duplicate key "${k}" (already used by items[${keyToIndex.get(k)}])`);
					keyToIndex.set(k, i);
				}
			}

			// Pass 0b: 数字 blockedBy（既有任务，与 create 同规）。
			for (let i = 0; i < items.length; i++) {
				for (const dep of items[i].blockedBy ?? []) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `items[${i}] blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `items[${i}] blockedBy: #${dep} is deleted`);
				}
			}

			// Pass 0c: dependsOn 键解析 + 批内环检测（DFS 三色）。
			const keyDeps: string[][] = items.map((it) => (it.dependsOn ?? []).map(String));
			for (let i = 0; i < items.length; i++) {
				for (const k of keyDeps[i]) {
					if (!keyToIndex.has(k)) return errorResult(state, `items[${i}] dependsOn: key "${k}" not defined in this batch`);
					if (keyToIndex.get(k) === i) return errorResult(state, `items[${i}] dependsOn itself (key "${k}")`);
				}
			}
			const depColor = new Array<number>(items.length).fill(0); // 0=white 1=gray 2=black
			const dfsCycle = (i: number): boolean => {
				depColor[i] = 1;
				for (const k of keyDeps[i]) {
					const j = keyToIndex.get(k)!;
					if (depColor[j] === 1) return true;
					if (depColor[j] === 0 && dfsCycle(j)) return true;
				}
				depColor[i] = 2;
				return false;
			};
			for (let i = 0; i < items.length; i++) {
				if (depColor[i] === 0 && dfsCycle(i)) {
					return errorResult(state, "dependsOn would create a cycle within the batch");
				}
			}

			// Pass 0d: parent 解析（数字→既有任务同规校验；字符串→批内 key + 单层限制）。
			for (let i = 0; i < items.length; i++) {
				const p = items[i].parent;
				if (p === undefined) continue;
				if (typeof p === "number") {
					const err = validateParent(state, undefined, p);
					if (err) return errorResult(state, `items[${i}] ${err}`);
				} else {
					const k = String(p).trim();
					const idx = keyToIndex.get(k);
					if (idx === undefined) return errorResult(state, `items[${i}] parent: key "${k}" not defined in this batch`);
					if (idx === i) return errorResult(state, `items[${i}] cannot be its own parent`);
					if (items[idx].parent !== undefined) {
							return errorResult(state, `items[${idx}] (key "${k}") is itself a subtask — one nesting level only`);
					}
				}
			}

			// Pass 1: 建 N 条任务（整批共用一个 now，时间戳仅信息性）。
			const now = Date.now();
			const keyToId = new Map<string, number>();
			const created: Task[] = [];
			let nextId = state.nextId;
			for (const it of items) {
				const t: Task = { id: nextId++, subject: it.subject, status: "pending", createdAt: now, updatedAt: now };
				if (it.description) t.description = it.description;
				if (it.activeForm) t.activeForm = it.activeForm;
				if (it.owner) t.owner = it.owner;
				if (it.priority !== undefined) t.priority = it.priority;
				created.push(t);
				if (it.key !== undefined) keyToId.set(String(it.key).trim(), t.id);
			}

			// Pass 2: 回填依赖与父子关系（key→id 解析，校验已在 Pass 0 完成）。
			for (let i = 0; i < items.length; i++) {
				const it = items[i];
			const t = created[i];
			const deps: number[] = [...(it.blockedBy ?? [])];
				for (const k of keyDeps[i]) deps.push(keyToId.get(k)!);
				if (deps.length) t.blockedBy = [...new Set(deps)];
				if (it.parent !== undefined) {
					t.parent = typeof it.parent === "number" ? it.parent : keyToId.get(String(it.parent).trim())!;
				}
			}

			const keys = keyToId.size ? Object.fromEntries(keyToId) : undefined;
			return {
				state: { tasks: [...state.tasks, ...created], nextId },
				op: { kind: "plan", count: created.length, ids: created.map((t) => t.id), ...(keys !== undefined ? { keys } : {}) },
			};
		}
	}
}
