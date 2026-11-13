import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Core } from "../packages/core/src/index.js";
import { StructuredCliAdapter } from "../packages/adapters/src/structured-cli.js";
import type {
  Room,
  Member,
  Task,
  Artifact,
} from "../packages/contracts/src/index.js";
test("structured CLI executes a real fixture subprocess and preserves unverified artifact status", async () => {
  const c = new Core(":memory:", [new StructuredCliAdapter()]);
  const call = <T>(operation: string, payload: unknown) =>
    c.execute({
      protocolVersion: 1,
      requestId: randomUUID(),
      operation,
      payload,
    }) as T;
  try {
    c.start();
    const room = call<Room>("rooms.create", { name: "CLI" });
    const member = call<Member>("members.add", {
      roomId: room.id,
      name: "Fixture",
      adapterId: "structured-cli",
      config: {
        executable: process.execPath,
        args: [resolve("tests/fixtures/agent.mjs")],
        cwd: process.cwd(),
      },
    });
    const task = call<Task>("tasks.assign", {
      roomId: room.id,
      ownerId: member.id,
      goal: "Check subprocess",
      criteria: ["Receive result"],
    });
    const end = Date.now() + 3000;
    while (c.task(task.id).status !== "review") {
      if (Date.now() > end) throw new Error("CLI timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
    const [artifact] = call<Artifact[]>("artifacts.list", { taskId: task.id });
    assert.equal(artifact.simulated, false);
    assert.equal(artifact.verification, "unverified");
    assert.match(artifact.content, /Fixture output/);
  } finally {
    await c.close();
  }
});
