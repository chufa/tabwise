const publicFields = [
  "id", "name", "status", "createdAt", "updatedAt", "total", "count", "skipped",
  "failed", "settled", "retryable", "resumable", "reason", "retryOf", "resumeOf", "operationId", "archivedAt", "resolvedBy", "sessionExpired", "loadMode", "concurrency"
];

const publicTask = (task, taskType) => {
  const projected = Object.fromEntries(publicFields
    .filter((field) => task[field] !== undefined)
    .map((field) => [field, task[field]]));
  return {
    ...projected,
    kind: taskType === "restore" ? "restore" : task.kind,
    taskType,
    resumable: Boolean(task.resumable)
  };
};

const compareTasks = (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id);

export const projectTasks = ({ batchTasks = [], restoreTasks = [] }) => [
  ...batchTasks.map((task) => publicTask(task, "batch")),
  ...restoreTasks.map((task) => publicTask(task, "restore"))
].sort(compareTasks);

export const projectTaskDetail = (task, { taskType, offset = 0, pageSize = 50, resultsArePaged = false } = {}) => {
  const results = Array.isArray(task.results) ? task.results : [];
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const detail = {
    ok: true,
    ...publicTask(task, taskType),
    itemTotal: Number.isInteger(task.itemTotal) ? task.itemTotal : results.length,
    offset: resultsArePaged && Number.isInteger(task.offset) ? task.offset : safeOffset,
    results: resultsArePaged ? results : results.slice(safeOffset, safeOffset + pageSize)
  };
  if (Array.isArray(task.audit)) detail.audit = task.audit;
  return detail;
};
