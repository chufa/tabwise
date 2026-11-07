// The initial durable record remains authoritative if final bookkeeping fails.
export async function suspensionTransaction({ record, reserve, validate, apply, finish, remove, inspect }) {
  let reserved = false, attempted = false, mode;
  try {
    await reserve(record);
    reserved = true;
    await validate();
    attempted = true;
    mode = await apply();
    await finish({ ...record, mode, state: "suspended" });
    return { ok: true, recordId: record.recordId };
  } catch (error) {
    if (reserved && attempted) {
      const state = await inspect().catch(() => "unknown");
      if (state !== "unchanged") return { ok: state === "applied", error: state !== "applied",
        recordId: record.recordId, recoveryRetained: true, warning: error.message,
        reason: state === "applied" ? "休眠已完成，恢复记录已保留；部分统计未写入。" : "操作结果尚不确定，恢复记录已保留，请检查页面。" };
    }
    if (reserved) await remove(record.recordId).catch(() => {});
    return { ok: false, error: true, reason: error.message || "休眠操作失败" };
  }
}
