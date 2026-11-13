import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Core } from "../packages/core/src/index.js";
import { Services } from "../packages/core/src/services.js";
import { MockAdapter } from "../packages/adapters/src/mock.js";
import { runCommand, type Evidence } from "../packages/workspace/src/index.js";
import type { Room, Member, Task } from "../packages/contracts/src/index.js";

const cmd = (operation: string, payload: unknown) => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  operation,
  payload,
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-evidence-"));
  writeFileSync(join(dir, "source.txt"), "unchanged");
  const core = new Core(":memory:", [new MockAdapter()]);
  const services = new Services(core, dir);
  const room = core.execute(cmd("rooms.create", { name: "evidence" })) as Room;
  const members = ["A", "B"].map(
    (name) =>
      core.execute(
        cmd("members.add", {
          roomId: room.id,
          name,
          adapterId: "mock",
        }),
      ) as Member,
  );
  core.execute(cmd("rooms.pause", { roomId: room.id, paused: true }));
  const task = core.execute(
    cmd("tasks.assign", {
      roomId: room.id,
      ownerId: members[0].id,
      goal: "test",
      criteria: ["pass"],
    }),
  ) as Task;
  const workspace = await services.workspaces.register(room.id, dir);
  return {
    core,
    services,
    room,
    members,
    task,
    workspace,
    async close() {
      await services.close();
      await core.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("handoff invalidates file artifact ownership and requires fresh test evidence", async () => {
  const f = await fixture();
  const { core, services, task, workspace } = f;
  const run = () =>
    services.workspaces.test(
      task.id,
      workspace.id,
      process.execPath,
      ["-e", "process.exit(0)"],
      5000,
    );
  const capture = () =>
    services.workspaces.capture(
      task.id,
      workspace.id,
      core.task(task.id).version,
    );
  try {
    await run();
    const original = await capture();
    assert.equal(
      (await services.workspaces.inspect(original.id)).verification,
      "verified",
    );
    core.execute(
      cmd("tasks.handoff", {
        taskId: task.id,
        expectedVersion: core.task(task.id).version,
        ownerId: f.members[1].id,
        note: "New owner must validate",
      }),
    );
    assert.equal(
      (await services.workspaces.inspect(original.id)).current,
      false,
    );
    const replacement = await capture();
    assert.equal(
      (await services.workspaces.inspect(replacement.id)).verification,
      "unverified",
    );
    await run();
    assert.equal(
      (await services.workspaces.inspect(replacement.id)).verification,
      "verified",
    );
    // Old persisted snapshots without ownership metadata fail closed.
    const legacy = { ...replacement } as Record<string, any>;
    delete legacy.ownershipVersion;
    core.store.put("artifact", legacy as typeof replacement, task.roomId);
    assert.equal(
      (await services.workspaces.inspect(replacement.id)).current,
      false,
    );
  } finally {
    await f.close();
  }
});

test("post-command snapshot failure retains command result and publishes terminal evidence", async () => {
  const f = await fixture();
  const { core, services, task, workspace } = f;
  const original = services.workspaces.snapshot.bind(services.workspaces);
  let calls = 0;
  services.workspaces.snapshot = async (id) => {
    if (++calls === 2) throw new Error("snapshot unavailable");
    return original(id);
  };
  try {
    await assert.rejects(
      services.workspaces.test(
        task.id,
        workspace.id,
        process.execPath,
        ["-e", "console.log('COMMAND_FINISHED'); process.exit(2)"],
        5000,
      ),
      /snapshot unavailable/,
    );
    const evidence = core.store.list<Evidence>("evidence")[0];
    assert.equal(evidence.status, "unknown");
    assert.equal(evidence.exitCode, 2);
    assert.match(evidence.log, /COMMAND_FINISHED/);
    assert.ok(evidence.endedAt);
    const finished = core.store
      .events(f.room.id)
      .filter((e) => e.type === "test.finished");
    assert.equal(finished.length, 1);
    assert.equal((finished[0].payload as Evidence).status, "unknown");
    assert.equal(services.workspaces.busy, false);
  } finally {
    await f.close();
  }
});

test("already cancelled commands never attempt to launch an executable", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCommand(
    "roundloom-missing-executable-" + randomUUID(),
    [],
    tmpdir(),
    controller.signal,
  );
  assert.deepEqual(result, { exitCode: null, log: "", cancelled: true });
});

test("shutdown during the initial snapshot cancels the test before command launch", async () => {
  const f = await fixture();
  const { core, services, task, workspace } = f;
  const snapshot = services.workspaces.snapshot.bind(services.workspaces);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  services.workspaces.snapshot = async (id) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return snapshot(id);
  };
  try {
    const execution = services.execute(
      cmd("tests.execute", {
        taskId: task.id,
        workspaceId: workspace.id,
        executable: "roundloom-missing-executable-" + randomUUID(),
      }),
    );
    await started;
    const closing = services.close();
    resume();
    const result = (await execution) as Evidence;
    await closing;
    assert.equal(result.status, "cancelled");
    assert.equal(result.log, "");
    assert.equal(core.store.list<Evidence>("evidence")[0].status, "cancelled");
  } finally {
    resume();
    await f.close();
  }
});
