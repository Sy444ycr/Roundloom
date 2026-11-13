import type { Run, Task } from "../../contracts/src/index.js";
export const isActiveRun = (run: Run) =>
  ["starting", "running", "unknown"].includes(run.status);
export const isTerminalRun = (run: Run) =>
  ["succeeded", "failed", "cancelled"].includes(run.status);
export const currentOwnerRun = (task: Task, run: Run) =>
  run.attempt === task.attempt &&
  run.memberId === task.ownerId &&
  run.ownershipVersion === task.ownershipVersion;
