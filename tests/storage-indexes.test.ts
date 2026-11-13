import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/storage/src/index.js";
import type { Run, PeerRequest } from "../packages/contracts/src/index.js";
const makeRun = (id: string, status: Run["status"]): Run => ({
  id,
  roomId: "room",
  memberId: "member",
  sessionId: "session",
  taskId: "task",
  input: "x",
  status,
  requirementsVersion: 1,
  ownershipVersion: 1,
  attempt: 1,
  purpose: "task",
  cancelRequested: false,
  config: {},
  adapterId: "mock",
});
test("indexed run queries track transitions and transaction rollback amid historical records", () => {
  const s = new Store(":memory:");
  try {
    s.transaction(() => {
      for (let i = 0; i < 10000; i++)
        s.put(
          "run",
          {
            ...makeRun(`history-${i}`, "succeeded"),
            taskId: `history-task-${i}`,
            sessionId: `history-session-${i}`,
          },
          "room",
        );
      for (const status of [
        "queued",
        "starting",
        "running",
        "unknown",
        "cancelled",
      ] as const)
        s.put("run", makeRun(status, status), "room");
    });
    assert.deepEqual(
      s.activeRuns().map((r) => r.id),
      ["starting", "running", "unknown"],
    );
    assert.equal(s.activeRuns("elsewhere").length, 0);
    assert.equal(s.runsForTask("task").length, 5);
    assert.throws(() =>
      s.transaction(() => {
        s.put("run", makeRun("running", "succeeded"), "room");
        throw new Error("rollback");
      }),
    );
    assert.ok(s.activeRuns("session").some((r) => r.id === "running"));
    s.put("run", makeRun("running", "succeeded"), "room");
    assert.deepEqual(
      s.activeRuns("session").map((r) => r.id),
      ["starting", "unknown"],
    );
    const plan = s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT data FROM objects WHERE kind='run' AND json_extract(data, '$.taskId')=? ORDER BY rowid",
      )
      .all("task") as { detail: string }[];
    assert.ok(plan.some((p) => p.detail.includes("objects_run_task")));
  } finally {
    s.close();
  }
});

test("existing databases gain peer indexes without losing data or changing deadline semantics", () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-index-upgrade-"));
  let s = new Store(join(dir, "core.db"));
  try {
    const peer: PeerRequest = {
      id: "peer",
      roomId: "room",
      taskId: "task",
      sourceRunId: "source",
      senderId: "a",
      recipientId: "b",
      question: "help",
      status: "pending",
      deadline: 100,
      resumed: false,
    };
    s.put("peer", peer, "room");
    s.db.exec(
      "DROP INDEX objects_active_runs; DROP INDEX objects_run_task; DROP INDEX objects_peer_task; DROP INDEX objects_peer_source; DROP INDEX objects_pending_peer_deadline; DROP INDEX dispatch_pending",
    );
    s.close();
    s = new Store(join(dir, "core.db"));
    assert.deepEqual(s.peersForTask("task"), [peer]);
    assert.deepEqual(s.peersForSource("source"), [peer]);
    assert.equal(s.expiredPeers(99).length, 0);
    assert.deepEqual(s.expiredPeers(100), [peer]);
    s.put("peer", { ...peer, status: "replied" }, "room");
    assert.equal(s.expiredPeers(101).length, 0);
    assert.equal(s.db.pragma("user_version", { simple: true }), 2);
    const plan = s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT run_id FROM dispatch WHERE status='pending' ORDER BY rowid",
      )
      .all() as { detail: string }[];
    assert.ok(plan.some((p) => p.detail.includes("dispatch_pending")));
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
