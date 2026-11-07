import { projectTaskDetail, projectTasks } from "../shared/task-projection.js";

const validTaskTypes = new Set(["batch", "restore"]);

const mutationTaskType = (message) => {
  if (!validTaskTypes.has(message.taskType)) throw new Error("任务类型无效，请刷新后重试。");
  return message.taskType;
};

export const createTaskCommands = ({ batchRunner, restorer }) => {
  const runnerFor = (taskType) => taskType === "batch" ? batchRunner : restorer;
  const detail = async (message) => {
    let taskType = message.taskType;
    if (!validTaskTypes.has(taskType)) taskType = (await batchRunner.list()).some((task) => task.id === message.taskId) ? "batch" : "restore";
    const task = await runnerFor(taskType).detail(message.taskId, message.offset);
    return projectTaskDetail(task, { taskType, offset: message.offset, resultsArePaged: taskType === "restore" });
  };
  return {
    async list(includeArchived = false) {
      const [batchTasks, restoreTasks] = await Promise.all([batchRunner.list(), restorer.list()]);
      return projectTasks({ batchTasks, restoreTasks }).filter((task) => includeArchived || !task.archivedAt);
    },
    detail,
    async stop(message) {
      return runnerFor(mutationTaskType(message)).stop(message.taskId);
    },
    async retry(message) {
      return runnerFor(mutationTaskType(message)).retry(message.taskId);
    },
    async archive(message) {
      return runnerFor(mutationTaskType(message)).archive(message.taskId);
    },
    async resume(message) {
      if (mutationTaskType(message) !== "restore") throw new Error("仅支持恢复任务继续执行。");
      return restorer.resume(message.taskId);
    }
  };
};
