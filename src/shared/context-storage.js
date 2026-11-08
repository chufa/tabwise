import { queueStorage } from "./storage.js";
import { normalizeContextTask, validateContextCapacity } from "./task-context.js";

let accessArea, accessReady;
export function protectContextStorage() {
  const area = chrome.storage.local;
  if (accessArea !== area) {
    accessArea = area;
    accessReady = Promise.resolve(area.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }));
  }
  return accessReady;
}
export async function getContextTasks() {
  await protectContextStorage();
  const { contextTasks = [] } = await chrome.storage.local.get("contextTasks");
  validateContextCapacity(contextTasks);
  return contextTasks.map(normalizeContextTask);
}
export function changeContextTasks(change) {
  return queueStorage("local", async () => {
    const tasks = await getContextTasks();
    const result = await change(tasks);
    validateContextCapacity(tasks);
    await chrome.storage.local.set({ contextTasks: tasks });
    return result;
  });
}
