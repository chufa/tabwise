export const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "stopping"]);
export const ATTENTION_TASK_STATUSES = new Set([...ACTIVE_TASK_STATUSES, "interrupted", "stopped"]);

export const isTaskActive = (status) => ACTIVE_TASK_STATUSES.has(status);
export const taskNeedsAttention = (task) => typeof task === "string" ? ATTENTION_TASK_STATUSES.has(task)
  : !task.archivedAt && !task.resolvedBy && (ATTENTION_TASK_STATUSES.has(task.status) || task.failed > 0);
