export function createReviewRunner({ read, write, execute }) {
  const ready = (async () => {
    const entries = await read();
    let changed = false;
    for (const entry of entries) {
      if (entry.status !== "running") continue;
      Object.assign(entry, { status: "interrupted", finishedAt: Date.now(), error: "后台在巡检完成前重启，请检查记录后手动重试。" });
      changed = true;
    }
    if (changed) await write(entries);
  })();
  let queue = ready;
  return {
    ready,
    run(trigger, details = {}) {
      const next = queue.catch(() => {}).then(async () => {
        const entries = await read();
        if (details.scheduledSlot && entries.some((entry) => entry.scheduledSlot === details.scheduledSlot)) return { ok: true, skipped: true };
        let retryTrigger;
        if (details.retryOf) {
          const previous = entries.find((entry) => entry.id === details.retryOf);
          if (!previous || !["failed", "interrupted"].includes(previous.status)
            || entries.some((entry) => entry.retryOf === details.retryOf)) throw new Error("此巡检不能重复重试，请检查最新运行记录。");
          retryTrigger = previous.retryTrigger || previous.trigger;
        }
        const review = { id: crypto.randomUUID(), createdAt: Date.now(), trigger, status: "running", ...details, ...(retryTrigger ? { retryTrigger } : {}) };
        await write([review, ...entries].slice(0, 20));
        try {
          Object.assign(review, await execute(review, async (details) => {
            Object.assign(review, details);
            await write((await read()).map((entry) => entry.id === review.id ? review : entry));
          }), { status: "completed" });
        } catch (error) {
          Object.assign(review, { status: "failed", error: error.message || "资源巡检未完成。" });
        }
        review.finishedAt = Date.now();
        review.durationMs = review.finishedAt - review.createdAt;
        await write((await read()).map((entry) => entry.id === review.id ? review : entry));
        return { ok: review.status === "completed", reason: review.error, review };
      });
      queue = next;
      return next;
    }
  };
}
