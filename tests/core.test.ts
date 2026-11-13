import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../packages/core/src/index.js";
import { MockAdapter } from "../packages/adapters/src/mock.js";
import type {
  Room,
  Member,
  Task,
  Run,
  PeerRequest,
  Artifact,
  StoredEvent,
} from "../packages/contracts/src/index.js";

function call<T>(
  c: Core,
  operation: string,
  payload: unknown,
  requestId = randomUUID(),
): T {
  return c.execute({ protocolVersion: 1, requestId, operation, payload }) as T;
}
function setup(c: Core, config: Record<string, unknown> = {}) {
  const room = call<Room>(c, "rooms.create", { name: "Test" });
  const member = call<Member>(c, "members.add", {
    roomId: room.id,
    name: "A",
    adapterId: "mock",
    config,
  });
  return { room, member };
}
function assign(c: Core, room: Room, member: Member, extra = {}) {
  return call<Task>(c, "tasks.assign", {
    roomId: room.id,
    ownerId: member.id,
    goal: "Build example",
    criteria: ["Works"],
    ...extra,
  });
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function create(t: test.TestContext) {
  const c = new Core(":memory:", [new MockAdapter()]);
  t.after(() => c.close());
  c.start();
  return c;
}

test("transactional idempotency and payload conflict", async (t) => {
  const c = create(t);
  const { room, member } = setup(c, { hang: true });
  const id = randomUUID();
  const payload = {
    roomId: room.id,
    ownerId: member.id,
    goal: "Goal",
    criteria: ["done"],
  };
  const a = call<Task>(c, "tasks.assign", payload, id);
  const b = call<Task>(c, "tasks.assign", payload, id);
  assert.equal(a.id, b.id);
  assert.equal(c.store.list("task").length, 1);
  assert.equal(c.store.list("run").length, 1);
  assert.throws(
    () => call(c, "tasks.assign", { ...payload, goal: "changed" }, id),
    { code: "CONFLICT" },
  );
});
test("normal messages do not create tasks or runs; routing is scoped", (t) => {
  const c = create(t);
  const { room, member } = setup(c);
  call(c, "messages.send", { roomId: room.id, text: "note" });
  assert.equal(c.store.list("run").length, 0);
  call(c, "messages.send", {
    roomId: room.id,
    text: "question",
    recipients: [member.id],
  });
  assert.equal(c.store.list("run").length, 1);
  assert.equal(c.store.list("task").length, 0);
  const other = call<Room>(c, "rooms.create", { name: "Other" });
  assert.throws(
    () =>
      call(c, "messages.send", {
        roomId: other.id,
        text: "bad",
        recipients: [member.id],
      }),
    { code: "FORBIDDEN" },
  );
  assert.equal(c.store.list("message", other.id).length, 0);
});
test("versioned artifact requires user acceptance and stays unverified", async (t) => {
  const c = create(t);
  const { room, member } = setup(c);
  const task = assign(c, room, member);
  await until(() => c.task(task.id).status === "review");
  const ready = c.task(task.id);
  const [artifact] = call<Artifact[]>(c, "artifacts.list", { taskId: task.id });
  assert.equal(artifact.verification, "unverified");
  assert.equal(artifact.simulated, true);
  assert.throws(
    () =>
      call(c, "tasks.accept", {
        taskId: task.id,
        expectedVersion: task.version,
        artifactId: artifact.id,
        requirementsVersion: 1,
      }),
    { code: "CONFLICT" },
  );
  const accepted = call<Task>(c, "tasks.accept", {
    taskId: task.id,
    expectedVersion: ready.version,
    artifactId: artifact.id,
    requirementsVersion: 1,
  });
  assert.equal(accepted.status, "completed");
});
test("single session serializes runs while different sessions progress", async (t) => {
  const c = create(t);
  const { room, member } = setup(c, { hang: true });
  assign(c, room, member);
  assign(c, room, member);
  await c.pump();
  const runs = c.store.list<Run>("run");
  assert.equal(runs.filter((r) => r.status === "queued").length, 1);
  const b = call<Member>(c, "members.add", {
    roomId: room.id,
    name: "B",
    adapterId: "mock",
  });
  const task = assign(c, room, b);
  await until(() => c.task(task.id).status === "review");
});
test("peer request resumes the owner exactly once", async (t) => {
  const c = create(t);
  const { room, member: b } = setup(c);
  const a = call<Member>(c, "members.add", {
    roomId: room.id,
    name: "A",
    adapterId: "mock",
    config: { peerId: b.id },
  });
  const task = assign(c, room, a);
  await until(() => c.task(task.id).status === "review");
  assert.equal(c.store.list<Run>("run").length, 3);
  const [q] = c.store.list<PeerRequest>("peer");
  assert.equal(q.status, "replied");
  assert.equal(q.resumed, true);
});
test("cancellation persists before stopping runs and blocks peer continuation", async (t) => {
  const c = create(t);
  const { room, member: b } = setup(c, { hang: true });
  const a = call<Member>(c, "members.add", {
    roomId: room.id,
    name: "A",
    adapterId: "mock",
    config: { peerId: b.id },
  });
  const task = assign(c, room, a);
  await until(() => c.store.list<PeerRequest>("peer").length === 1);
  const current = c.task(task.id);
  call(c, "tasks.cancel", {
    taskId: task.id,
    expectedVersion: current.version,
  });
  await until(() => c.task(task.id).status === "cancelled");
  assert.equal(c.store.list<Run>("run").length, 2);
  assert.equal(c.store.list<PeerRequest>("peer")[0].status, "cancelled");
});
test("pause blocks new dispatch and resumes safely", async (t) => {
  const c = create(t);
  const { room, member } = setup(c);
  call(c, "rooms.pause", { roomId: room.id, paused: true });
  const task = assign(c, room, member);
  await c.pump();
  assert.equal(c.store.list<Run>("run")[0].status, "queued");
  call(c, "rooms.pause", { roomId: room.id, paused: false });
  await until(() => c.task(task.id).status === "review");
});
test("requirements changed during execution cannot inherit old result", async (t) => {
  const c = create(t);
  const { room, member } = setup(c, { delayMs: 40 });
  const task = assign(c, room, member);
  const current = c.task(task.id);
  call(c, "tasks.update", {
    taskId: task.id,
    expectedVersion: current.version,
    goal: "new requirement",
    criteria: ["new"],
  });
  await until(() => c.task(task.id).status === "review");
  const artifacts = c.store.list<Artifact>("artifact");
  assert.deepEqual(
    artifacts.map((a) => a.requirementsVersion),
    [1, 2],
  );
  assert.equal(c.task(task.id).artifactId, artifacts[1].id);
});
test("event deduplication and history reads never dispatch work", async (t) => {
  const c = create(t);
  const { room, member } = setup(c, { hang: true });
  assign(c, room, member);
  const [r] = c.store.list<Run>("run");
  const event = { id: "same", type: "output" as const, text: "hello" };
  c.ingest(r.id, event);
  c.ingest(r.id, event);
  assert.equal(
    c.store.list<{ text: string }>("message").filter((m) => m.text === "hello")
      .length,
    1,
  );
  const events = call<StoredEvent[]>(c, "events.read", { roomId: room.id });
  assert.deepEqual(
    events.map((e) => e.sequence),
    events.map((_, i) => i + 1),
  );
  call(c, "events.read", { roomId: room.id, after: 0 });
  assert.equal(c.store.list("run").length, 1);
});
test("budget stops automatic continuation", async (t) => {
  const c = create(t);
  const { room, member: b } = setup(c);
  const a = call<Member>(c, "members.add", {
    roomId: room.id,
    name: "A",
    adapterId: "mock",
    config: { peerId: b.id },
  });
  const task = assign(c, room, a, { maxRuns: 2 });
  await until(() => c.task(task.id).waitReason === "budget_exceeded");
  assert.equal(c.task(task.id).runCount, 2);
  assert.equal(
    c.store.list<Run>("run").filter((r) => r.status === "queued").length,
    1,
  );
});
test("SQLite recovery marks active runs unknown without replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-"));
  const path = join(dir, "data.db");
  let c = new Core(path, [new MockAdapter()]);
  try {
    const { room, member } = setup(c, { hang: true });
    const task = assign(c, room, member);
    await c.pump();
    await c.close();
    c = new Core(path, [new MockAdapter()]);
    await c.pump();
    assert.equal(c.task(task.id).status, "waiting");
    assert.equal(c.store.list<Run>("run")[0].status, "unknown");
    assert.equal(c.store.list("run").length, 1);
  } finally {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("failed transaction leaves no partial objects or events", (t) => {
  const c = create(t);
  const before = c.store.list("room").length;
  assert.throws(() =>
    c.store.transaction(() => {
      c.store.put(
        "room",
        { id: "rollback", name: "bad", paused: false },
        "rollback",
      );
      c.store.event("rollback", "test", {});
      throw new Error("injected");
    }),
  );
  assert.equal(c.store.list("room").length, before);
  assert.equal(c.store.events("rollback").length, 0);
});
test("schema validation rejects unknown commands and unexpected identity", (t) => {
  const c = create(t);
  assert.throws(() => call(c, "shell.exec", { command: "bad" }), {
    code: "VALIDATION",
  });
  const { room } = setup(c);
  assert.throws(
    () =>
      call(c, "messages.send", {
        roomId: room.id,
        text: "x",
        senderId: "forged",
      }),
    { code: "VALIDATION" },
  );
});

test("early peer reply waits until source run succeeds", async (t) => {
  const c = create(t);
  const { room, member: a } = setup(c, { hang: true });
  const b = call<Member>(c, "members.add", {
    roomId: room.id,
    name: "B",
    adapterId: "mock",
    config: { hang: true },
  });
  const task = assign(c, room, a);
  await c.pump();
  const [source] = c.store.list<Run>("run");
  const q = c.requestPeer(source.id, b.id, "question");
  await c.pump();
  const peer = c.store.list<Run>("run").find((r) => r.purpose === "peer")!;
  c.replyPeer(peer.id, q, "answer");
  assert.equal(c.store.list("run").length, 2);
  c.ingest(source.id, { id: "source-done", type: "state", state: "succeeded" });
  assert.equal(c.store.list("run").length, 3);
  c.replyPeer(peer.id, q, "answer");
  assert.equal(c.store.list("run").length, 3);
  assert.equal(c.task(task.id).cancelRequested, false);
});
test("early peer reply does not resume a subsequently failed source", async (t) => {
  const c = create(t);
  const { room, member: a } = setup(c, { hang: true });
  const b = call<Member>(c, "members.add", {
    roomId: room.id,
    name: "B",
    adapterId: "mock",
    config: { hang: true },
  });
  const task = assign(c, room, a);
  await c.pump();
  const [source] = c.store.list<Run>("run");
  const q = c.requestPeer(source.id, b.id, "question");
  await c.pump();
  const peer = c.store.list<Run>("run").find((r) => r.purpose === "peer")!;
  c.replyPeer(peer.id, q, "answer");
  c.ingest(source.id, { id: "failed", type: "state", state: "failed" });
  assert.equal(c.task(task.id).status, "failed");
  assert.equal(c.store.list("run").length, 2);
});
test("idle handoff replaces queued owner work and records new ownership", async (t) => {
  const c = create(t);
  const { room, member: a } = setup(c);
  const b = call<Member>(c, "members.add", {
    roomId: room.id,
    name: "B",
    adapterId: "mock",
  });
  call(c, "rooms.pause", { roomId: room.id, paused: true });
  const task = assign(c, room, a);
  const updated = call<Task>(c, "tasks.handoff", {
    taskId: task.id,
    expectedVersion: task.version,
    ownerId: b.id,
    note: "Please continue",
  });
  assert.equal(updated.ownershipVersion, 2);
  assert.equal(c.store.list<Run>("run")[0].status, "cancelled");
  call(c, "rooms.pause", { roomId: room.id, paused: false });
  await until(() => c.task(task.id).status === "review");
  assert.equal(c.task(task.id).ownerId, b.id);
});
test("cancelled task retry preserves previous attempt", async (t) => {
  const c = create(t);
  const { room, member } = setup(c);
  call(c, "rooms.pause", { roomId: room.id, paused: true });
  const task = assign(c, room, member);
  const cancelled = call<Task>(c, "tasks.cancel", {
    taskId: task.id,
    expectedVersion: task.version,
  });
  const retried = call<Task>(c, "tasks.retry", {
    taskId: task.id,
    expectedVersion: cancelled.version,
  });
  assert.equal(retried.attempt, 2);
  call(c, "rooms.pause", { roomId: room.id, paused: false });
  await until(() => c.task(task.id).status === "review");
  assert.deepEqual(
    c.store.list<Run>("run").map((r) => r.attempt),
    [1, 2],
  );
});
