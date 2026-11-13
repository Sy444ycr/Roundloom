import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Core } from "../packages/core/src/index.js";
import { Services } from "../packages/core/src/services.js";
import { MockAdapter } from "../packages/adapters/src/mock.js";
import { runCommand } from "../packages/workspace/src/index.js";
const cmd = (operation: string, payload: unknown) => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  operation,
  payload,
});

test("connection recovery requires a fresh connection and publishes lifecycle changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-connections-"));
  let c = new Core(join(dir, "core.db"), [new MockAdapter()]);
  try {
    const room = c.execute(cmd("rooms.create", { name: "connections" })) as any;
    const member = c.execute(
      cmd("members.add", { roomId: room.id, name: "mock", adapterId: "mock" }),
    ) as any;
    await c.connectMember(member.id);
    assert.equal(c.store.list<any>("connection")[0].status, "connected");
    const closing = c.close();
    assert.throws(() => c.start(), { code: "CLOSED" });
    await Promise.all([closing, c.close()]);
    c = new Core(join(dir, "core.db"), [new MockAdapter()]);
    assert.equal(c.store.list<any>("connection")[0].status, "unknown");
    await c.connectMember(member.id);
    await c.disconnectMember(member.id);
    const events = c.execute(
      cmd("events.read", { roomId: room.id, after: 0 }),
    ) as any;
    assert.ok(JSON.stringify(events).includes('"status":"disconnected"'));
    await c.close();
    await assert.rejects(c.connectMember(member.id), { code: "CLOSED" });
  } finally {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("one database owner and pruned event cursors require a snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-lock-"));
  const c = new Core(join(dir, "core.db"), [new MockAdapter()]);
  const s = new Services(c, dir);
  try {
    assert.throws(() => new Core(join(dir, "core.db"), []), {
      code: "DATABASE_LOCKED",
    });
    const r = c.execute(cmd("rooms.create", { name: "test" })) as any;
    for (let i = 0; i < 4; i++)
      c.execute(cmd("messages.send", { roomId: r.id, text: "event" }));
    const prune = (await s.execute(
      cmd("events.prune", { roomId: r.id, keepLast: 2 }),
    )) as any;
    assert.equal(prune.deleted, 3);
    assert.throws(
      () => c.execute(cmd("events.read", { roomId: r.id, after: 0 })),
      { code: "CURSOR_EXPIRED" },
    );
    const snapshot = c.execute(cmd("rooms.snapshot", { roomId: r.id })) as any;
    assert.equal(snapshot.sequence, 5);
    c.execute(cmd("messages.send", { roomId: r.id, text: "new" }));
    assert.equal(c.store.watermark(r.id), 6);
  } finally {
    await s.close();
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("git worktree and file evidence are independently versioned and restored backup stays intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-git-"));
  const repo = join(dir, "repo");
  const fs = await import("node:fs/promises");
  await fs.mkdir(repo);
  await runCommand("git", ["init"], repo);
  writeFileSync(join(repo, "hello.txt"), "one");
  await runCommand("git", ["add", "."], repo);
  const commit = await runCommand(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    repo,
  );
  assert.equal(commit.exitCode, 0);
  const c = new Core(":memory:", [new MockAdapter()]);
  const s = new Services(c, join(dir, "data"));
  try {
    const room = c.execute(cmd("rooms.create", { name: "git" })) as any;
    const m = c.execute(
      cmd("members.add", { roomId: room.id, name: "A", adapterId: "mock" }),
    ) as any;
    c.execute(cmd("rooms.pause", { roomId: room.id, paused: true }));
    const task = c.execute(
      cmd("tasks.assign", {
        roomId: room.id,
        ownerId: m.id,
        goal: "goal",
        criteria: ["one"],
      }),
    ) as any;
    const w = (await s.execute(
      cmd("workspaces.worktree", {
        roomId: room.id,
        repository: repo,
        destination: join(dir, "tree"),
      }),
    )) as any;
    assert.equal(readFileSync(join(w.root, "hello.txt"), "utf8"), "one");
    await s.execute(
      cmd("tests.execute", {
        taskId: task.id,
        workspaceId: w.id,
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
      }),
    );
    const artifact = (await s.execute(
      cmd("artifacts.capture", {
        taskId: task.id,
        workspaceId: w.id,
        expectedVersion: c.task(task.id).version,
      }),
    )) as any;
    assert.equal(
      (
        (await s.execute(
          cmd("artifacts.inspect", { artifactId: artifact.id }),
        )) as any
      ).verification,
      "verified",
    );
    await s.execute(
      cmd("workspaces.write", {
        workspaceId: w.id,
        path: "hello.txt",
        content: "two",
      }),
    );
    assert.equal(
      (
        (await s.execute(
          cmd("artifacts.inspect", { artifactId: artifact.id }),
        )) as any
      ).verification,
      "unverified",
    );
    await assert.rejects(
      s.execute(
        cmd("tasks.accept", {
          taskId: task.id,
          expectedVersion: c.task(task.id).version,
          artifactId: artifact.id,
          requirementsVersion: 1,
        }),
      ),
      { code: "CONFLICT" },
    );
    assert.equal(readFileSync(join(repo, "hello.txt"), "utf8"), "one");
    const backup = (await s.execute(cmd("storage.backup", {}))) as any;
    const restored = join(dir, "restored.db");
    const result = await runCommand(
      process.execPath,
      [join(process.cwd(), "dist/scripts/restore.js"), backup.path, restored],
      dir,
    );
    assert.equal(result.exitCode, 0, result.log);
    const restoredCore = new Core(restored, []);
    assert.equal(restoredCore.store.list("task").length, 1);
    await restoredCore.close();
  } finally {
    await s.close();
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
