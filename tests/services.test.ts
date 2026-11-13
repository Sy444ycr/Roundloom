import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Core } from "../packages/core/src/index.js";
import { Services } from "../packages/core/src/services.js";
import { MockAdapter } from "../packages/adapters/src/mock.js";
import { AcpAdapter } from "../packages/adapters/src/acp.js";
import type {
  Task,
  Member,
  Room,
  Run,
  PeerRequest,
} from "../packages/contracts/src/index.js";
const cmd = (operation: string, payload: unknown) => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  operation,
  payload,
});

test("concurrent async retries share a result and shutdown rejects new service work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-idempotent-"));
  const c = new Core(":memory:", [new MockAdapter()]);
  const s = new Services(c, dir);
  try {
    const request = cmd("storage.backup", {});
    const first = s.execute(request);
    const second = s.execute(request);
    await assert.rejects(
      s.execute({
        ...request,
        operation: "members.connect",
        payload: { memberId: "other" },
      }),
      { code: "CONFLICT" },
    );
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.deepEqual(await s.execute(request), a);
    assert.equal(readdirSync(join(dir, "backups")).length, 1);
    await s.close();
    await assert.rejects(s.execute(cmd("adapters.list", {})), {
      code: "CLOSED",
    });
  } finally {
    await s.close();
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP final response answers only its assigned peer request and resumes owner", async () => {
  const c = new Core(":memory:", [new MockAdapter(), new AcpAdapter()]);
  try {
    const room = c.execute(cmd("rooms.create", { name: "Peer" })) as Room;
    const peer = c.execute(
      cmd("members.add", {
        roomId: room.id,
        name: "ACP",
        adapterId: "acp",
        config: {
          executable: process.execPath,
          args: [resolve("tests/fixtures/acp-agent.mjs")],
          cwd: process.cwd(),
        },
      }),
    ) as Member;
    const owner = c.execute(
      cmd("members.add", {
        roomId: room.id,
        name: "Owner",
        adapterId: "mock",
        config: { peerId: peer.id },
      }),
    ) as Member;
    const task = c.execute(
      cmd("tasks.assign", {
        roomId: room.id,
        ownerId: owner.id,
        goal: "Review",
        criteria: ["answer"],
      }),
    ) as Task;
    c.start();
    await until(() =>
      c.store.list<any>("interaction").some((i) => i.status === "pending"),
    );
    const peerRun = c.store.list<Run>("run").find((r) => r.purpose === "peer")!;
    assert.throws(() => c.requestPeer(peerRun.id, owner.id, "not supported"), {
      code: "CAPABILITY_UNSUPPORTED",
    });
    assert.throws(() => c.replyPeer(peerRun.id, "not-a-request", "forged"));
    const interaction = c.store
      .list<any>("interaction")
      .find((i) => i.status === "pending");
    c.answerPermission(interaction.id, "allow");
    await until(() => c.task(task.id).status === "review");
    const requests = c.store.list<PeerRequest>("peer");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reply, "Fixture answer 1");
    assert.equal(requests[0].resumed, true);
    assert.equal(c.store.list<Run>("run").length, 3);
    assert.throws(
      () => c.replyPeer(peerRun.id, requests[0].id, "late forged reply"),
      { code: "FORBIDDEN" },
    );
  } finally {
    await c.close();
  }
});
async function until(fn: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("Timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
test("real test evidence tracks snapshots, failures, stale results and backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-workspace-"));
  const c = new Core(":memory:", [new MockAdapter()]);
  const s = new Services(c, join(dir, "data"));
  try {
    const room = c.execute(cmd("rooms.create", { name: "Workspace" })) as Room;
    const m = c.execute(
      cmd("members.add", { roomId: room.id, name: "A", adapterId: "mock" }),
    ) as Member;
    c.execute(cmd("rooms.pause", { roomId: room.id, paused: true }));
    const task = c.execute(
      cmd("tasks.assign", {
        roomId: room.id,
        ownerId: m.id,
        goal: "test",
        criteria: ["pass"],
      }),
    ) as Task;
    const workspace = (await s.execute(
      cmd("workspaces.register", { roomId: room.id, path: dir }),
    )) as { id: string };
    const run = async (code: string) =>
      s.execute(
        cmd("tests.execute", {
          taskId: task.id,
          workspaceId: workspace.id,
          executable: process.execPath,
          args: ["-e", code],
        }),
      ) as Promise<any>;
    assert.equal((await run('console.log("executed")')).status, "passed");
    assert.equal((await run("process.exit(2)")).status, "failed");
    assert.equal(
      (await run('require("fs").writeFileSync("changed.txt","changed")'))
        .status,
      "stale",
    );
    await assert.rejects(
      s.execute(
        cmd("workspaces.read", {
          workspaceId: workspace.id,
          path: "../outside",
        }),
      ),
    );
    const backup = (await s.execute(cmd("storage.backup", {}))) as {
      path: string;
    };
    assert.ok(existsSync(backup.path));
  } finally {
    await s.close();
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("test cancellation is available while the execution request is pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-cancel-"));
  const c = new Core(":memory:", [new MockAdapter()]);
  const s = new Services(c, dir);
  try {
    const room = c.execute(cmd("rooms.create", { name: "test" })) as Room;
    const member = c.execute(
      cmd("members.add", { roomId: room.id, name: "A", adapterId: "mock" }),
    ) as Member;
    c.execute(cmd("rooms.pause", { roomId: room.id, paused: true }));
    const task = c.execute(
      cmd("tasks.assign", {
        roomId: room.id,
        ownerId: member.id,
        goal: "x",
        criteria: ["x"],
      }),
    ) as Task;
    const w = (await s.execute(
      cmd("workspaces.register", { roomId: room.id, path: dir }),
    )) as any;
    const running = s.execute(
      cmd("tests.execute", {
        taskId: task.id,
        workspaceId: w.id,
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
      }),
    );
    await until(() =>
      c.store.list<any>("evidence").some((e) => e.status === "running"),
    );
    const evidence = c.store.list<any>("evidence")[0];
    await s.execute(cmd("tests.cancel", { evidenceId: evidence.id }));
    assert.equal(((await running) as any).status, "cancelled");
  } finally {
    await s.close();
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("ACP initialize, authenticate, retained native session and permission interaction", async () => {
  const c = new Core(":memory:", [new AcpAdapter()]);
  const s = new Services(c, tmpdir());
  try {
    c.start();
    const room = c.execute(cmd("rooms.create", { name: "ACP" })) as Room;
    const member = c.execute(
      cmd("members.add", {
        roomId: room.id,
        name: "Fixture",
        adapterId: "acp",
        config: {
          executable: process.execPath,
          args: [resolve("tests/fixtures/acp-agent.mjs")],
          cwd: process.cwd(),
        },
      }),
    ) as Member;
    const connection = (await s.execute(
      cmd("members.connect", { memberId: member.id }),
    )) as any;
    assert.equal(connection.status, "connected");
    await s.execute(
      cmd("members.authenticate", { memberId: member.id, methodId: "fixture" }),
    );
    for (let n = 0; n < 2; n++) {
      const task = c.execute(
        cmd("tasks.assign", {
          roomId: room.id,
          ownerId: member.id,
          goal: "Test ACP",
          criteria: ["response"],
        }),
      ) as Task;
      await until(() =>
        c.store.list<any>("interaction").some((i) => i.status === "pending"),
      );
      const interaction = c.store
        .list<any>("interaction")
        .find((i) => i.status === "pending");
      await assert.rejects(
        s.execute(
          cmd("interactions.answer", {
            interactionId: interaction.id,
            optionId: "forged",
          }),
        ),
      );
      await s.execute(
        cmd("interactions.answer", {
          interactionId: interaction.id,
          optionId: "allow",
        }),
      );
      await until(() => c.task(task.id).status === "review");
    }
    assert.equal(c.store.list("interaction").length, 2);
    await s.execute(cmd("members.disconnect", { memberId: member.id }));
  } finally {
    await s.close();
    await c.close();
  }
});
