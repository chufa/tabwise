const DEFAULT_QUOTA = 10 * 1024 * 1024;

export function buildHealth({ bytesInUse = 0, quotaBytes = DEFAULT_QUOTA, sync = {}, restoreTasks = [] } = {}) {
  const ratio = quotaBytes ? bytesInUse / quotaBytes : 0;
  const pending = restoreTasks.filter((task) => ["queued", "running", "stopping", "interrupted", "stopped"].includes(task.status)).length;
  return {
    storage: { bytesInUse, quotaBytes, ratio, level: ratio >= .9 ? "critical" : ratio >= .75 ? "warning" : "ok" },
    sync: { revision: Number(sync.revision) || 0, updatedAt: Number(sync.updatedAt) || 0 },
    restore: { pending, level: pending ? "warning" : "ok" }
  };
}
