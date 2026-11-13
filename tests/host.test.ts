import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
function host(dir: string) {
  const child = fork(
    fileURLToPath(new URL("../packages/core/src/host.js", import.meta.url)),
    [],
    {
      env: { ...process.env, ROUNDLOOM_DATA_DIR: dir },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const messages: any[] = [];
  child.on("message", (m) => messages.push(m));
  async function wait(predicate: (m: any) => boolean) {
    const start = Date.now();
    while (true) {
      const m = messages.find(predicate);
      if (m) return m;
      if (Date.now() - start > 5000) throw new Error("Host timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  async function call(operation: string, payload: unknown) {
    const requestId = randomUUID();
    child.send({ protocolVersion: 1, requestId, operation, payload });
    const response = await wait((m) => m.requestId === requestId);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  }
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  return { child, wait, call, stop, messages };
}
test("standalone process supports bounded acknowledged event streaming and crash recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-host-"));
  let h = host(dir);
  try {
    await h.wait((m) => m.type === "core.ready");
    const room = await h.call("rooms.create", { name: "IPC" });
    const subscription = await h.call("events.subscribe", { roomId: room.id });
    const batch = await h.wait((m) => m.type === "events.batch");
    assert.equal(batch.events[0].type, "room.created");
    const member = await h.call("members.add", {
      roomId: room.id,
      name: "A",
      adapterId: "mock",
      config: { hang: true },
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(h.messages.filter((m) => m.type === "events.batch").length, 1);
    await h.call("events.ack", {
      subscriptionId: subscription.subscriptionId,
      sequence: batch.events.at(-1).sequence,
    });
    await h.wait((m) => m.type === "events.batch" && m.events[0].sequence > 1);
    const task = await h.call("tasks.assign", {
      roomId: room.id,
      ownerId: member.id,
      goal: "Crash test",
      criteria: ["Persist"],
    });
    const exited = once(h.child, "exit");
    h.child.kill("SIGKILL");
    await exited;
    h = host(dir);
    await h.wait((m) => m.type === "core.ready");
    const restored = await h.call("tasks.get", { taskId: task.id });
    assert.equal(restored.status, "waiting");
    const runs = await h.call("runs.list", { roomId: room.id });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "unknown");
  } finally {
    await h.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
