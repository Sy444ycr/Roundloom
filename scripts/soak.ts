import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Core } from "../packages/core/src/index.js";
import { Services } from "../packages/core/src/services.js";
import { MockAdapter } from "../packages/adapters/src/mock.js";
import type {
  Room,
  Member,
  Task,
  Run,
  PeerRequest,
} from "../packages/contracts/src/index.js";

const durationSeconds = Number(process.argv[2] ?? 600);
assert.ok(
  Number.isInteger(durationSeconds) &&
    durationSeconds >= 10 &&
    durationSeconds <= 86400,
);
const directory = resolve(".roundloom", "soak", randomUUID());
mkdirSync(directory, { recursive: true });
const database = join(directory, "core.db");
let core = new Core(database, [new MockAdapter()]);
let services = new Services(core, directory);
const command = (
  operation: string,
  payload: unknown,
  requestId: string = randomUUID(),
) => ({ protocolVersion: 1, requestId, operation, payload });
const call = <T>(operation: string, payload: unknown, requestId?: string) =>
  core.execute(command(operation, payload, requestId)) as T;
const room = call<Room>("rooms.create", { name: "Bounded soak" });
const peer = call<Member>("members.add", {
  roomId: room.id,
  name: "reviewer",
  adapterId: "mock",
  config: { delayMs: 30 },
});
const owners = Array.from({ length: 8 }, (_, i) =>
  call<Member>("members.add", {
    roomId: room.id,
    name: `owner-${i}`,
    adapterId: "mock",
    config: { delayMs: 50, ...(i % 2 === 0 ? { peerId: peer.id } : {}) },
  }),
);
const cancelMember = call<Member>("members.add", {
  roomId: room.id,
  name: "cancel",
  adapterId: "mock",
  config: { hang: true },
});
const inflight = new Map<string, { at: number; cancel: boolean }>();
const latencies: number[] = [];
const samples: Record<string, number>[] = [];
let issued = 0,
  reviewed = 0,
  cancelled = 0,
  maxConcurrent = 0,
  cursor = 0,
  restarts = 0;
let nextBatch = 0,
  nextSample = 0,
  nextRead = 0,
  nextPrune = 30000;
const started = Date.now();
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
let failure: string | undefined;
core.start();
try {
  while (Date.now() - started < durationSeconds * 1000 || inflight.size) {
    const age = Date.now() - started;
    if (age > durationSeconds * 1000 + 30000)
      throw new Error("Queue did not drain");
    if (age < durationSeconds * 1000 && age >= nextBatch) {
      nextBatch = age + 4000;
      for (const owner of owners) {
        const cancel = issued % 7 === 0;
        const requestId = randomUUID();
        const payload = {
          roomId: room.id,
          ownerId: cancel ? cancelMember.id : owner.id,
          goal: `soak-${issued}`,
          criteria: ["result"],
          maxRuns: 4,
        };
        const task = call<Task>("tasks.assign", payload, requestId);
        assert.equal(
          call<Task>("tasks.assign", payload, requestId).id,
          task.id,
        );
        inflight.set(task.id, { at: Date.now(), cancel });
        issued++;
      }
    }
    for (const [id, entry] of inflight) {
      const task = core.task(id);
      if (entry.cancel && task.status === "running" && !task.cancelRequested)
        call("tasks.cancel", { taskId: id, expectedVersion: task.version });
      if (["review", "cancelled"].includes(task.status)) {
        assert.equal(task.status, entry.cancel ? "cancelled" : "review");
        if (entry.cancel) cancelled++;
        else reviewed++;
        latencies.push(Date.now() - entry.at);
        inflight.delete(id);
      } else
        assert.ok(
          !["failed", "completed"].includes(task.status),
          `Unexpected task status ${task.status}`,
        );
    }
    const active = core.store.activeRuns();
    assert.equal(
      new Set(active.map((r) => r.sessionId)).size,
      active.length,
      "Concurrent work in one session",
    );
    maxConcurrent = Math.max(maxConcurrent, active.length);
    if (age >= nextRead) {
      nextRead = age + 5000;
      const events = core.store.events(room.id, cursor, 100);
      for (const event of events) {
        assert.ok(event.sequence > cursor);
        cursor = event.sequence;
      }
    }
    if (age >= nextPrune) {
      nextPrune = age + 30000;
      await services.execute(
        command("events.prune", { roomId: room.id, keepLast: 5000 }),
      );
      // A slow consumer must resync after pruning, not replay commands.
      const oldest = core.store.db
        .prepare("SELECT MIN(sequence) AS n FROM events WHERE room_id=?")
        .get(room.id) as { n: number };
      if (cursor < oldest.n - 1) cursor = core.store.watermark(room.id);
    }
    if (!restarts && age >= durationSeconds * 500 && !inflight.size) {
      await services.close();
      await core.close();
      core = new Core(database, [new MockAdapter()]);
      services = new Services(core, directory);
      core.start();
      restarts++;
    }
    if (age >= nextSample) {
      nextSample = age + 30000;
      global.gc?.();
      const memory = process.memoryUsage();
      samples.push({
        seconds: Math.round(age / 1000),
        heapMiB: memory.heapUsed / 1048576,
        rssMiB: memory.rss / 1048576,
        issued,
        reviewed,
        cancelled,
        queue: inflight.size,
      });
      console.log(JSON.stringify({ stage: "soak", ...samples.at(-1) }));
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(reviewed + cancelled, issued);
  assert.equal(
    core.store
      .list<Run>("run")
      .filter((r) => ["starting", "running", "unknown"].includes(r.status))
      .length,
    0,
  );
  assert.ok(maxConcurrent >= 2);
  assert.equal(restarts, 1);
  assert.equal(core.store.list<Task>("task").length, issued);
  assert.ok(
    core.store
      .list<PeerRequest>("peer")
      .every((q) => q.status === "replied" && q.resumed),
  );
  const integrity = core.store.db.pragma("integrity_check") as {
    integrity_check: string;
  }[];
  assert.ok(integrity.every((r) => r.integrity_check === "ok"));
  const sorted = [...latencies].sort((a, b) => a - b);
  assert.ok(
    sorted[Math.floor(sorted.length * 0.95)] < 5000,
    "Task p95 exceeded 5 seconds",
  );
  assert.ok(lag.percentile(99) / 1e6 < 500, "Event loop p99 exceeded 500 ms");
  const baseline = samples.find((s) => s.seconds >= 60) ?? samples[0];
  assert.ok(
    (samples.at(-1)?.heapMiB ?? 0) - baseline.heapMiB < 64,
    "Post-warmup heap grew over 64 MiB",
  );
  assert.ok(
    Math.max(...samples.map((s) => s.rssMiB)) < 512,
    "RSS exceeded 512 MiB",
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  lag.disable();
  await services.close();
  await core.close();
  const sorted = latencies.sort((a, b) => a - b);
  const report = {
    passed: !failure,
    failure,
    durationSeconds,
    elapsedSeconds: (Date.now() - started) / 1000,
    issued,
    reviewed,
    cancelled,
    maxConcurrent,
    restarts,
    taskP95Ms: sorted[Math.floor(sorted.length * 0.95)],
    eventLoopP99Ms: lag.percentile(99) / 1e6,
    gcAvailable: !!global.gc,
    samples,
    databaseBytes: statSync(database).size,
    node: process.version,
    platform: process.platform,
  };
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      stage: "complete",
      passed: !failure,
      failure,
      report: join(directory, "report.json"),
    }),
  );
}
