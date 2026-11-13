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

test("JSONL exit or broken protocol without a terminal state remains unknown and releases handles", async () => {
  for (const code of [
    "process.stdin.once('data',()=>process.exit(0))",
    "process.stdin.once('data',()=>process.stdout.write('invalid-json\\n'))",
  ]) {
    const adapter = new StructuredCliAdapter();
    const c = new Core(":memory:", [adapter]);
    const call = (operation: string, payload: unknown) =>
      c.execute({
        protocolVersion: 1,
        requestId: randomUUID(),
        operation,
        payload,
      }) as any;
    try {
      const room = call("rooms.create", { name: "broken" });
      const member = call("members.add", {
        roomId: room.id,
        name: "bridge",
        adapterId: adapter.id,
        config: {
          executable: process.execPath,
          args: ["-e", code],
          cwd: process.cwd(),
        },
      });
      const task = call("tasks.assign", {
        roomId: room.id,
        ownerId: member.id,
        goal: "check",
        criteria: ["terminal required"],
      });
      c.start();
      const deadline = Date.now() + 5000;
      while (
        c.task(task.id).status !== "waiting" ||
        (adapter as any).handles.size
      ) {
        assert.ok(Date.now() < deadline, "Bridge did not close");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(c.store.runsForTask(task.id)[0].status, "unknown");
      assert.throws(
        () =>
          call("tasks.retry", {
            taskId: task.id,
            expectedVersion: c.task(task.id).version,
          }),
        { code: "CONFLICT" },
      );
    } finally {
      await c.close();
    }
  }
});
