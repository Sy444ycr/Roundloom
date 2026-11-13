import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AcpAdapter } from "../packages/adapters/src/acp.js";
import { Core } from "../packages/core/src/index.js";
import type { Run, Room, Member } from "../packages/contracts/src/index.js";
import type {
  RunTools,
  AdapterEvent,
} from "../packages/adapter-sdk/src/index.js";
const tools: RunTools = {
  listMembers: () => [],
  requestPermission: async () => null,
  requestPeer: () => {
    throw new Error("Unexpected peer");
  },
  replyPeer: () => {},
};
const config = (dir: string, mode = "normal") => ({
  executable: process.execPath,
  args: [
    resolve("tests/fixtures/acp-lifecycle.mjs"),
    mode,
    join(dir, "journal"),
  ],
  cwd: dir,
  timeoutMs: 1000,
});
const run = (dir: string, mode = "normal"): Run => ({
  id: randomUUID(),
  roomId: "room",
  memberId: "member",
  sessionId: "session",
  input: "hello",
  status: "starting",
  requirementsVersion: 1,
  ownershipVersion: 1,
  attempt: 1,
  purpose: "discussion",
  cancelRequested: false,
  config: config(dir, mode),
  adapterId: "acp",
});
async function until(fn: () => boolean) {
  const end = Date.now() + 6000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const journal = (dir: string) => {
  try {
    return readFileSync(join(dir, "journal"), "utf8");
  } catch {
    return "";
  }
};

test("ACP concurrent connects share initialization and disposal rejects new connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-acp-life-"));
  const a = new AcpAdapter();
  try {
    const [x, y] = await Promise.all([
      a.connect("session", config(dir)),
      a.connect("session", config(dir)),
    ]);
    assert.deepEqual(x, y);
    assert.equal(journal(dir).split("spawn").length - 1, 1);
    await a.dispose();
    await assert.rejects(a.connect("new", config(dir)), { code: "CLOSED" });
  } finally {
    await a.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP disposal during initialize cannot resurrect a connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-acp-close-"));
  const a = new AcpAdapter();
  try {
    const pending = a.connect("session", config(dir));
    const rejected = assert.rejects(pending);
    await until(() => journal(dir).includes("initialize"));
    await a.dispose();
    await rejected;
    assert.equal(journal(dir).includes("session/new"), false);
  } finally {
    await a.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP cancellation during session creation never submits a prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-acp-cancel-"));
  const a = new AcpAdapter();
  const r = run(dir, "slow-new");
  const events: AdapterEvent[] = [];
  try {
    const pending = a.start(r, (e) => events.push(e), tools);
    await until(() => journal(dir).includes("session/new"));
    assert.equal(await a.cancel(r), "requested");
    await pending;
    assert.equal(journal(dir).includes("session/prompt"), false);
    assert.equal(events.find((e) => e.type === "state")?.state, "cancelled");
  } finally {
    await a.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP hung prompt times out as unknown and drops its connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-acp-timeout-"));
  const a = new AcpAdapter();
  const r = run(dir, "hang");
  const events: AdapterEvent[] = [];
  try {
    await a.start(r, (e) => events.push(e), tools);
    await until(() => events.some((e) => e.type === "state"));
    const state = events.find((e) => e.type === "state");
    assert.equal(state?.state, "unknown");
    assert.equal(state?.reason, "provider_timeout");
    assert.equal(await a.cancel(r), "unknown");
  } finally {
    await a.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP restart loads stored native session without duplicating historical messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-acp-resume-"));
  let c = new Core(join(dir, "core.db"), [new AcpAdapter()]);
  const call = <T>(operation: string, payload: unknown) =>
    c.execute({
      protocolVersion: 1,
      requestId: randomUUID(),
      operation,
      payload,
    }) as T;
  try {
    const room = call<Room>("rooms.create", { name: "resume" });
    const member = call<Member>("members.add", {
      roomId: room.id,
      name: "agent",
      adapterId: "acp",
      config: config(dir),
    });
    const send = () =>
      call("messages.send", {
        roomId: room.id,
        recipients: [member.id],
        text: "hello",
      });
    send();
    c.start();
    await until(
      () =>
        c.store.list<Run>("run").filter((r) => r.status === "succeeded")
          .length === 1,
    );
    await c.close();
    c = new Core(join(dir, "core.db"), [new AcpAdapter()]);
    send();
    c.start();
    await until(
      () =>
        c.store.list<Run>("run").filter((r) => r.status === "succeeded")
          .length === 2,
    );
    assert.equal(journal(dir).split("session/new").length - 1, 1);
    assert.equal(journal(dir).split("session/load").length - 1, 1);
    assert.equal(
      c.store
        .list<{ text: string }>("message")
        .some((m) => m.text.includes("HISTORICAL_OUTPUT")),
      false,
    );
  } finally {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP does not silently replace a session when load capability is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-acp-unsupported-"));
  const a = new AcpAdapter();
  try {
    await assert.rejects(
      a.start(
        { ...run(dir, "unsupported"), nativeRef: "old-session" },
        () => {},
        tools,
      ),
      { code: "CAPABILITY_UNSUPPORTED" },
    );
    assert.equal(journal(dir).includes("session/new"), false);
    assert.equal(journal(dir).includes("session/prompt"), false);
    const replacement = run(dir, "unsupported");
    replacement.nativeRef = "old-session";
    replacement.config.resumeSessions = false;
    const events: AdapterEvent[] = [];
    await a.start(replacement, (e) => events.push(e), tools);
    await until(() => events.some((e) => e.type === "state"));
    assert.equal(events.find((e) => e.type === "state")?.state, "succeeded");
    assert.equal(journal(dir).split("session/new").length - 1, 1);
  } finally {
    await a.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
