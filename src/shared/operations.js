export function sameOperationState(left, right) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function createOperationJournal({ read, write, undoItem }) {
  let queue = Promise.resolve();
  const run = (work) => {
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next;
  };
  return {
    record(label, items, status = "ready", batchTaskId) {
      return run(async () => {
        const entry = { id: crypto.randomUUID(), label, items, status, createdAt: Date.now(), ...(batchTaskId ? { batchTaskId } : {}) };
        await write([entry, ...await read()].slice(0, 20));
        return entry;
      });
    },
    finish(id, items) {
      return run(async () => {
        const entries = await read();
        const entry = entries.find((item) => item.id === id);
        if (!entry) throw new Error("操作记录不存在");
        entry.items = items;
        entry.status = "ready";
        await write(entries);
      });
    },
    undo(id) {
      return run(async () => {
        const entries = await read();
        const entry = entries.find((item) => item.id === id);
        if (!entry || entry.status !== "ready") return { ok: false, reason: "此操作已撤销或未完成，不能重复执行。" };
        entry.status = "undoing";
        await write(entries);
        const results = [];
        for (const item of entry.items) {
          try { results.push({ ok: true, reason: await undoItem(item) || "已恢复" }); }
          catch (error) { results.push({ ok: false, reason: error.message }); }
        }
        const restored = results.filter((item) => item.ok).length;
        entry.status = restored === results.length ? "undone" : restored ? "partial" : "conflict";
        entry.results = results;
        entry.undoneAt = Date.now();
        await write(entries);
        return { ok: true, restored, results };
      });
    }
  };
}
