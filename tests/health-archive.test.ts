import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Core } from "../packages/core/src/index.js";
import { Services } from "../packages/core/src/services.js";
import { Archives } from "../packages/core/src/archives.js";
import { Store } from "../packages/storage/src/index.js";
import { MockAdapter } from "../packages/adapters/src/mock.js";
import { AcpAdapter } from "../packages/adapters/src/acp.js";
import { runCommand } from "../packages/workspace/src/index.js";
import type {
  Room,
  Task,
  Member,
  Artifact,
} from "../packages/contracts/src/index.js";
const cmd = (operation: string, payload: unknown) => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  operation,
  payload,
});
async function until(fn: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!fn()) {
    assert.ok(Date.now() < deadline, "Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
function seed(c: Core) {
  const room = c.execute(cmd("rooms.create", { name: "archive" })) as Room;
  const member = c.execute(
    cmd("members.add", { roomId: room.id, name: "A", adapterId: "mock" }),
  ) as Member;
  const task = c.execute(
    cmd("tasks.assign", {
      roomId: room.id,
      ownerId: member.id,
      goal: "done",
      criteria: ["done"],
    }),
  ) as Task;
  return { room, member, task };
}
async function complete(c: Core, task: Task) {
  c.start();
  await until(() => c.task(task.id).status === "review");
  const latest = c.task(task.id);
  c.execute(
    cmd("tasks.accept", {
      taskId: task.id,
      expectedVersion: latest.version,
      artifactId: latest.artifactId,
      requirementsVersion: latest.requirementsVersion,
    }),
  );
}

test("idle ACP process exit is detected automatically and unsupported probes stay unknown", async () => {
  const c = new Core(":memory:", [new AcpAdapter(), new MockAdapter()]);
  try {
    const { room, member } = seed(c);
    await c.connectMember(member.id);
    const acp = c.execute(
      cmd("members.add", {
        roomId: room.id,
        name: "ACP",
        adapterId: "acp",
        config: {
          executable: process.execPath,
          args: [resolve("tests/fixtures/acp-lifecycle.mjs"), "idle-exit"],
          cwd: process.cwd(),
        },
      }),
    ) as Member;
    await c.connectMember(acp.id);
    const checked = c.checkConnections(room.id);
    assert.equal(
      checked.find((x) => x.memberId === member.id).health.state,
      "unknown",
    );
    assert.equal(
      checked.find((x) => x.memberId === acp.id).health.state,
      "healthy",
    );
    const watermark = c.store.watermark(room.id);
    c.checkConnections(room.id);
    assert.equal(
      c.store.watermark(room.id),
      watermark,
      "unchanged probes do not flood events",
    );
    c.start();
    await until(
      () =>
        c.store.get<any>("connection", "connection:" + acp.sessionId).status ===
        "disconnected",
    );
    assert.ok(c.store.get<any>("session", member.sessionId).lastRunId);
    assert.equal(
      c.store.get<any>("connection", "connection:" + member.sessionId).memberId,
      member.id,
    );
    const disconnected = c.store.get<any>(
      "connection",
      "connection:" + acp.sessionId,
    );
    assert.equal(disconnected.health.scope, "local-transport");
    assert.ok(disconnected.health.checkedAt);
    await c.connectMember(acp.id);
    assert.equal(
      c.checkConnections(room.id).find((x) => x.memberId === acp.id).status,
      "connected",
    );
  } finally {
    await c.close();
  }
});

test("closed ACP stream is unhealthy even when the process remains alive", async () => {
  const a = new AcpAdapter();
  try {
    await a.connect("session", {
      executable: process.execPath,
      args: [resolve("tests/fixtures/acp-lifecycle.mjs"), "normal"],
      cwd: process.cwd(),
    });
    assert.equal(a.health("session").state, "healthy");
    const connection = (a as any).connections.get("session");
    connection.child.stdout.destroy();
    assert.equal(connection.child.exitCode, null);
    await until(() => a.health("session").state === "disconnected");
    await a.connect("session", {
      executable: process.execPath,
      args: [resolve("tests/fixtures/acp-lifecycle.mjs"), "normal"],
      cwd: process.cwd(),
    });
    assert.equal(a.health("session").state, "healthy");
  } finally {
    await a.dispose();
  }
});

test("archive survives backup and restart, preserves idempotency and restores exact history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-archive-"));
  let c = new Core(join(dir, "core.db"), [new MockAdapter()]);
  let s = new Services(c, dir);
  try {
    const { room, task } = seed(c);
    await complete(c, task);
    const rows = c.store.db.prepare("SELECT * FROM objects ORDER BY id").all();
    const dispatch = c.store.db
      .prepare("SELECT * FROM dispatch ORDER BY run_id")
      .all();
    const adapterEvents = c.store.db
      .prepare("SELECT * FROM adapter_events ORDER BY run_id,source_id")
      .all();
    const runId = c.store.runsForTask(task.id)[0].id;
    const request = cmd("history.archive", {
      taskId: task.id,
      expectedVersion: c.task(task.id).version,
    });
    const archived = (await s.execute(request)) as any;
    assert.deepEqual(await s.execute(request), archived);
    assert.equal(c.store.list("task").length, 0);
    assert.equal(c.task(task.id).status, "completed");
    assert.ok(
      (
        (await s.execute(
          cmd("history.read", { archiveId: archived.id }),
        )) as any
      ).objects.some((o: any) => o.kind === "acceptance"),
    );
    assert.equal(
      (
        (await s.execute(
          cmd("history.list", { roomId: room.id, offset: 1 }),
        )) as any[]
      ).length,
      0,
    );
    const sequence = c.store.watermark(room.id);
    c.ingest(runId, { id: "late", type: "output", text: "ignored" });
    assert.equal(c.store.watermark(room.id), sequence);
    assert.throws(() => c.holdTask(task.id), { code: "ARCHIVED" });
    const backup = (await s.execute(cmd("storage.backup", {}))) as any;
    const restoredPath = join(dir, "backup-restored.db");
    const restored = await runCommand(
      process.execPath,
      [resolve("dist/scripts/restore.js"), backup.path, restoredPath],
      dir,
    );
    assert.equal(restored.exitCode, 0, restored.log);
    const backupCore = new Core(restoredPath, []);
    assert.equal(
      new Archives(backupCore.store).read(archived.id).taskId,
      task.id,
    );
    await backupCore.close();
    await s.close();
    await c.close();
    c = new Core(join(dir, "core.db"), [new MockAdapter()]);
    s = new Services(c, dir);
    assert.deepEqual(await s.execute(request), archived);
    await s.execute(cmd("history.restore", { archiveId: archived.id }));
    assert.deepEqual(
      c.store.db.prepare("SELECT * FROM objects ORDER BY id").all(),
      rows,
    );
    assert.deepEqual(
      c.store.db.prepare("SELECT * FROM dispatch ORDER BY run_id").all(),
      dispatch,
    );
    assert.deepEqual(
      c.store.db
        .prepare("SELECT * FROM adapter_events ORDER BY run_id,source_id")
        .all(),
      adapterEvents,
    );
    assert.equal(c.store.db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    await s.close();
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive rejects unfinished work and rolls back failed moves and restores", async () => {
  const c = new Core(":memory:", [new MockAdapter()]);
  const a = new Archives(c.store);
  try {
    const { task } = seed(c);
    assert.throws(() => a.create(task.id, task.version), { code: "CONFLICT" });
    await complete(c, task);
    c.store.db.exec(
      "CREATE TRIGGER fail_archive BEFORE DELETE ON objects BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    assert.throws(() => a.create(task.id, c.task(task.id).version), /injected/);
    assert.equal(a.list(task.roomId, 10, 0).length, 0);
    assert.equal(c.store.list("task").length, 1);
    c.store.db.exec("DROP TRIGGER fail_archive");
    const archived = a.create(task.id, c.task(task.id).version);
    c.store.db.exec(
      "CREATE TRIGGER fail_restore BEFORE INSERT ON objects BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    assert.throws(() => a.restore(archived.id), /injected/);
    assert.equal(a.read(archived.id).taskId, task.id);
    assert.equal(c.store.list("task").length, 0);
    c.store.db.exec("DROP TRIGGER fail_restore");
    a.restore(archived.id);
    assert.equal(c.store.list("task").length, 1);
  } finally {
    await c.close();
  }
});

test("v1 databases migrate atomically and newer schemas are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-migrate-"));
  const path = join(dir, "core.db");
  let s = new Store(path);
  try {
    s.put("room", { id: "room", name: "kept", paused: false }, "room");
    s.put(
      "connection",
      {
        id: "old-session",
        memberId: "old-member",
        nativeRef: "retained-native",
        lastRunId: "old-run",
        status: "succeeded",
      },
      "room",
    );
    s.db.exec(
      "DROP TABLE archived_objects; DROP TABLE archives; PRAGMA user_version=1",
    );
    s.close();
    s = new Store(path);
    assert.equal(s.db.pragma("user_version", { simple: true }), 2);
    assert.equal(s.get<Room>("room", "room").name, "kept");
    assert.equal(
      s.get<any>("session", "old-session").nativeRef,
      "retained-native",
    );
    assert.equal(
      s.get<any>("connection", "connection:old-session").sessionId,
      "old-session",
    );
    s.db.pragma("user_version=3");
    s.close();
    assert.throws(() => new Store(path), { code: "SCHEMA_TOO_NEW" });
  } finally {
    if (s.db.open) s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed v1 migration rolls back schema and releases the database lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-migration-failure-"));
  const path = join(dir, "core.db");
  const original = new Store(path);
  original.put(
    "connection",
    { id: "legacy", memberId: "member", status: "connected" },
    "room",
  );
  original.db.exec(
    "DROP TABLE archived_objects; DROP TABLE archives; PRAGMA user_version=1; CREATE TRIGGER fail_migration BEFORE UPDATE ON objects BEGIN SELECT RAISE(ABORT,'migration failed'); END",
  );
  original.close();
  try {
    assert.throws(() => new Store(path), /migration failed/);
    const db = new Database(path);
    try {
      assert.equal(db.pragma("user_version", { simple: true }), 1);
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='archives'",
          )
          .get() &&
          (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='archives'",
              )
              .get() as any
          ).n,
        0,
      );
      db.exec("DROP TRIGGER fail_migration");
    } finally {
      db.close();
    }
    const migrated = new Store(path);
    assert.equal(
      migrated.get<any>("connection", "connection:legacy").memberId,
      "member",
    );
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
