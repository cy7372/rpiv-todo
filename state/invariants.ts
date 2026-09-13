import type { TaskStatus } from "../tool/types.js";

/**
 * Allowed transitions per source status.
 *
 * Dancher extension (2026-09-13) vs upstream 2.10.0:
 * - `deleted` is no longer terminal: deleted → pending revives a tombstoned
 *   task (undelete) with its id, subject, and dependencies intact.
 * - `completed` can reopen: completed → in_progress and completed → pending
 *   recover from premature completion (e.g. tests failed after marking done).
 * The one-way discipline stays as *guidance*; the state machine now trusts
 * the model to correct itself, which is strictly better than a stuck list.
 *
 * Idempotent same→same is checked separately in `isTransitionValid` so this
 * table only enumerates actual transitions.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["deleted", "in_progress", "pending"]),
	deleted: new Set(["pending"]),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}
