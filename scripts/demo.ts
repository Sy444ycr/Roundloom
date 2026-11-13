import { Core } from "../packages/core/src/index.js";
import { MockAdapter } from "../packages/adapters/src/mock.js";
import { randomUUID } from "node:crypto";
import type { Room, Member, Task } from "../packages/contracts/src/index.js";
const core = new Core(":memory:", [new MockAdapter()]);
const call = <T>(operation: string, payload: unknown): T =>
  core.execute({
    protocolVersion: 1,
    requestId: randomUUID(),
    operation,
    payload,
  }) as T;
try {
  core.start();
  const room = call<Room>("rooms.create", { name: "Roundloom backend demo" });
  const b = call<Member>("members.add", {
    roomId: room.id,
    name: "Reviewer",
    adapterId: "mock",
  });
  const a = call<Member>("members.add", {
    roomId: room.id,
    name: "Builder",
    adapterId: "mock",
    config: { peerId: b.id },
  });
  const task = call<Task>("tasks.assign", {
    roomId: room.id,
    ownerId: a.id,
    goal: "Demonstrate peer collaboration",
    criteria: ["Mock peer reply and versioned artifact"],
  });
  const deadline = Date.now() + 5000;
  while (core.task(task.id).status !== "review" && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  const ready = core.task(task.id);
  if (ready.status !== "review") throw new Error("Demo did not reach review");
  const completed = call<Task>("tasks.accept", {
    taskId: task.id,
    expectedVersion: ready.version,
    artifactId: ready.artifactId,
    requirementsVersion: ready.requirementsVersion,
  });
  console.log(
    JSON.stringify(
      {
        simulated: true,
        task: completed,
        runs: call("runs.list", { roomId: room.id }),
        artifacts: call("artifacts.list", { taskId: task.id }),
      },
      null,
      2,
    ),
  );
} finally {
  await core.close();
}
