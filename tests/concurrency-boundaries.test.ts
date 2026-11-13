import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Core } from "../packages/core/src/index.js";
import { Services } from "../packages/core/src/services.js";
import { Store } from "../packages/storage/src/index.js";
import { MockAdapter } from "../packages/adapters/src/mock.js";
const cmd = (operation: string, payload: unknown) => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  operation,
  payload,
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-boundary-"));
  mkdirSync(join(dir, "child"));
  writeFileSync(join(dir, "file.txt"), "original");
  const core = new Core(":memory:", [new MockAdapter()]);
  const services = new Services(core, dir);
  const rooms = ["A", "B"].map(
    (name) => core.execute(cmd("rooms.create", { name })) as any,
  );
  const member = core.execute(
    cmd("members.add", { roomId: rooms[0].id, name: "A", adapterId: "mock" }),
  ) as any;
  core.execute(cmd("rooms.pause", { roomId: rooms[0].id, paused: true }));
  const task = core.execute(
    cmd("tasks.assign", {
      roomId: rooms[0].id,
      ownerId: member.id,
      goal: "test",
      criteria: ["pass"],
    }),
  ) as any;
  const workspaces = await Promise.all([
    services.workspaces.register(rooms[0].id, dir),
    services.workspaces.register(rooms[1].id, dir),
    services.workspaces.register(rooms[1].id, join(dir, "child")),
  ]);
  return {
    core,
    services,
    task,
    workspaces,
    async close() {
      await services.close();
      await core.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("test locks cover other registrations of the same directory and nested directories", async () => {
  const f = await setup();
  const hold = gate(),
    entered = gate();
  const original = f.services.workspaces.snapshot.bind(f.services.workspaces);
  let first = true;
  f.services.workspaces.snapshot = async (id) => {
    if (first) {
      first = false;
      entered.release();
      await hold.promise;
    }
    return original(id);
  };
  const running = f.services.execute(
    cmd("tests.execute", {
      taskId: f.task.id,
      workspaceId: f.workspaces[0].id,
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    }),
  );
  try {
    await entered.promise;
    for (const w of f.workspaces.slice(1))
      await assert.rejects(
        f.services.workspaces.write(w.id, "file.txt", "changed"),
        { code: "CONFLICT" },
      );
  } finally {
    hold.release();
    await running;
    await f.close();
  }
});

test("a write holds its directory lock before its first asynchronous filesystem operation", async () => {
  const f = await setup();
  const hold = gate(),
    entered = gate();
  const original = f.services.workspaces.path.bind(f.services.workspaces);
  let first = true;
  f.services.workspaces.path = async (id, path) => {
    if (first) {
      first = false;
      entered.release();
      await hold.promise;
    }
    return original(id, path);
  };
  const writing = f.services.workspaces.write(
    f.workspaces[1].id,
    "file.txt",
    "changed",
  );
  try {
    await entered.promise;
    await assert.rejects(
      f.services.workspaces.test(
        f.task.id,
        f.workspaces[0].id,
        process.execPath,
        ["-e", "process.exit(0)"],
        5000,
      ),
      { code: "CONFLICT" },
    );
  } finally {
    hold.release();
    await writing;
    await f.close();
  }
});

test("service shutdown drains asynchronous reads before returning", async () => {
  const f = await setup();
  const hold = gate(),
    entered = gate();
  const original = f.services.workspaces.snapshot.bind(f.services.workspaces);
  f.services.workspaces.snapshot = async (id) => {
    entered.release();
    await hold.promise;
    return original(id);
  };
  const reading = f.services.execute(
    cmd("workspaces.snapshot", { workspaceId: f.workspaces[0].id }),
  );
  try {
    await entered.promise;
    let closed = false;
    const closing = f.services.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    hold.release();
    await Promise.all([reading, closing, f.services.close()]);
    await assert.rejects(f.services.execute(cmd("adapters.list", {})), {
      code: "CLOSED",
    });
  } finally {
    hold.release();
    await reading;
    await f.close();
  }
});

test("object IDs cannot overwrite a different entity kind or room", () => {
  const s = new Store(":memory:");
  try {
    const value = { id: "same", name: "kept" };
    s.put("room", value, "room-a");
    assert.throws(
      () => s.put("session", { id: "same", name: "corrupt" }, "room-a"),
      { code: "CONFLICT" },
    );
    assert.throws(
      () => s.put("room", { id: "same", name: "corrupt" }, "room-b"),
      { code: "CONFLICT" },
    );
    assert.deepEqual(s.get("room", "same"), value);
  } finally {
    s.close();
  }
});

test("failed file writes remove temporary files and release directory locks", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.services.workspaces.write(
        f.workspaces[0].id,
        "child",
        "cannot replace directory",
      ),
    );
    assert.ok(
      !readdirSync(f.workspaces[0].root).some((name) =>
        name.startsWith(".roundloom-"),
      ),
    );
    await f.services.workspaces.write(
      f.workspaces[1].id,
      "file.txt",
      "lock released",
    );
    assert.equal(
      (await f.services.workspaces.read(f.workspaces[0].id, "file.txt")).text,
      "lock released",
    );
  } finally {
    await f.close();
  }
});

test("member connection controls exclude each other and hold new task dispatch", async () => {
  const hold = gate();
  class ConnectingAdapter extends MockAdapter {
    async connect() {
      await hold.promise;
      return {};
    }
    async disconnect() {}
  }
  const c = new Core(":memory:", [new ConnectingAdapter()]);
  let connecting: Promise<unknown> | undefined;
  try {
    const room = c.execute(cmd("rooms.create", { name: "control" })) as any;
    const member = c.execute(
      cmd("members.add", { roomId: room.id, name: "A", adapterId: "mock" }),
    ) as any;
    connecting = c.connectMember(member.id);
    await assert.rejects(c.disconnectMember(member.id), { code: "CONFLICT" });
    const task = c.execute(
      cmd("tasks.assign", {
        roomId: room.id,
        ownerId: member.id,
        goal: "wait",
        criteria: ["pass"],
      }),
    ) as any;
    c.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(c.task(task.id).status, "queued");
    hold.release();
    await connecting;
    const end = Date.now() + 3000;
    while (c.task(task.id).status !== "review") {
      assert.ok(Date.now() < end);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    hold.release();
    await connecting;
    await c.close();
  }
});
