import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { SDKMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import {
  NativeAdapter,
  type CodexClient,
} from "../packages/adapters/src/native.js";
import { Core } from "../packages/core/src/index.js";
import type { Run, Room, Member } from "../packages/contracts/src/index.js";
import type {
  AdapterEvent,
  RunTools,
} from "../packages/adapter-sdk/src/index.js";
const tools: RunTools = {
  listMembers: () => [],
  requestPermission: async () => "deny",
  requestPeer: () => "peer",
  replyPeer: () => {},
};
const run = (): Run => ({
  id: randomUUID(),
  roomId: "room",
  memberId: "member",
  sessionId: "session",
  input: "hello",
  status: "running",
  requirementsVersion: 1,
  ownershipVersion: 1,
  attempt: 1,
  purpose: "task",
  taskId: "task",
  cancelRequested: false,
  config: { cwd: tmpdir() },
  adapterId: "codex",
});
async function until(fn: () => boolean) {
  const end = Date.now() + 4000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function client(events: ThreadEvent[], resumed: string[] = []): CodexClient {
  const thread = {
    async runStreamed() {
      return {
        events: (async function* () {
          yield* events;
        })(),
      };
    },
  };
  return {
    startThread: () => thread,
    resumeThread: (id) => {
      resumed.push(id);
      return thread;
    },
  };
}
const completed: ThreadEvent[] = [
  { type: "thread.started", thread_id: "native-session" },
  {
    type: "item.completed",
    item: { id: "message", type: "agent_message", text: "answer" },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 0,
    },
  },
];
test("Codex session survives database restart and queued turns resume it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roundloom-native-"));
  const resumed: string[] = [];
  let c = new Core(join(dir, "core.db"), [
    new NativeAdapter("codex", () => client(completed, resumed)),
  ]);
  const call = <T>(operation: string, payload: unknown) =>
    c.execute({
      protocolVersion: 1,
      requestId: randomUUID(),
      operation,
      payload,
    }) as T;
  try {
    const room = call<Room>("rooms.create", { name: "room" });
    const member = call<Member>("members.add", {
      roomId: room.id,
      name: "agent",
      adapterId: "codex",
      config: { cwd: dir },
    });
    const send = () =>
      call("messages.send", {
        roomId: room.id,
        recipients: [member.id],
        text: "hello",
      });
    send();
    send();
    c.start();
    await until(
      () =>
        c.store.list<Run>("run").filter((r) => r.status === "succeeded")
          .length === 2,
    );
    assert.deepEqual(resumed, ["native-session"]);
    await c.close();
    c = new Core(join(dir, "core.db"), [
      new NativeAdapter("codex", () => client(completed, resumed)),
    ]);
    send();
    c.start();
    await until(
      () =>
        c.store.list<Run>("run").filter((r) => r.status === "succeeded")
          .length === 3,
    );
    assert.deepEqual(resumed, ["native-session", "native-session"]);
  } finally {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Codex incomplete and failed streams never produce accepted results", async () => {
  for (const [events, expected] of [
    [completed.slice(0, 2), "unknown"],
    [[{ type: "turn.failed", error: { message: "failed" } }], "failed"],
  ] as [ThreadEvent[], string][]) {
    const adapter = new NativeAdapter("codex", () => client(events));
    const output: AdapterEvent[] = [];
    await adapter.start(run(), (e) => output.push(e), tools);
    await until(() => output.some((e) => e.type === "state"));
    assert.equal(output.find((e) => e.type === "state")?.state, expected);
    assert.equal(
      output.some((e) => e.type === "result"),
      false,
    );
    adapter.dispose();
  }
});
test("Claude forwards resume and permission decisions, persists session and result", async () => {
  let captured: Options | undefined;
  const adapter = new NativeAdapter("claude", undefined, async function* ({
    options,
  }) {
    captured = options;
    const decision = await options.canUseTool!(
      "Write",
      { file_path: "example" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool",
        requestId: "request",
      },
    );
    assert.equal(decision?.behavior, "deny");
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude-session",
      result: "done",
    } as SDKMessage;
  });
  const r = { ...run(), nativeRef: "previous" };
  const output: AdapterEvent[] = [];
  await adapter.start(r, (e) => output.push(e), tools);
  await until(() => output.some((e) => e.type === "state"));
  assert.equal(captured?.resume, "previous");
  assert.ok(captured?.mcpServers?.roundloom);
  assert.ok(
    output.some(
      (e) => e.type === "session" && e.nativeRef === "claude-session",
    ),
  );
  assert.ok(output.some((e) => e.type === "result" && e.content === "done"));
  assert.equal(await adapter.query(r), "succeeded");
  adapter.dispose();
});
test("native cancellation aborts SDK and does not emit a result", async () => {
  const adapter = new NativeAdapter("claude", undefined, async function* ({
    options,
  }) {
    await new Promise<void>((_, reject) =>
      options.abortController!.signal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      ),
    );
    yield {} as SDKMessage;
  });
  const r = run();
  const output: AdapterEvent[] = [];
  await adapter.start(r, (e) => output.push(e), tools);
  assert.equal(await adapter.cancel(r), "requested");
  await until(() => output.some((e) => e.type === "state"));
  assert.equal(await adapter.query(r), "cancelled");
  assert.equal(
    output.some((e) => e.type === "result"),
    false,
  );
  adapter.dispose();
});

test("Codex stops consuming after terminal success and tolerates reconnection events", async () => {
  let closed = false;
  const thread = {
    async runStreamed() {
      return {
        events: (async function* (): AsyncGenerator<ThreadEvent> {
          try {
            yield { type: "error", message: "Reconnecting: os error 10054" };
            yield* completed;
            throw new Error("Must not request events after terminal state");
          } finally {
            closed = true;
          }
        })(),
      };
    },
  };
  const adapter = new NativeAdapter("codex", () => ({
    startThread: () => thread,
    resumeThread: () => thread,
  }));
  const output: AdapterEvent[] = [];
  const r = run();
  await adapter.start(r, (e) => output.push(e), tools);
  await until(() => output.some((e) => e.type === "state"));
  assert.equal(await adapter.query(r), "succeeded");
  assert.equal(closed, true);
  assert.equal(output.find((e) => e.type === "state")?.reason, undefined);
  await adapter.dispose();
});

test("native timeout remains unknown and records a sanitized reason", async () => {
  const adapter = new NativeAdapter("claude", undefined, async function* ({
    options,
  }) {
    await new Promise<void>((_, reject) =>
      options.abortController!.signal.addEventListener(
        "abort",
        () => reject(new Error("secret provider diagnostics")),
        { once: true },
      ),
    );
    yield {} as SDKMessage;
  });
  const output: AdapterEvent[] = [];
  await adapter.start(
    { ...run(), config: { cwd: tmpdir(), timeoutMs: 1000 } },
    (e) => output.push(e),
    tools,
  );
  await until(() => output.some((e) => e.type === "state"));
  const terminal = output.find((e) => e.type === "state");
  assert.equal(terminal?.state, "unknown");
  assert.equal(terminal?.reason, "provider_timeout");
  assert.equal(JSON.stringify(output).includes("secret"), false);
  await adapter.dispose();
});
