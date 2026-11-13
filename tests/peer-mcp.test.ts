import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import { openPeerMcp } from "../packages/adapters/src/peer-mcp.js";
import { NativeAdapter } from "../packages/adapters/src/native.js";
import { MockAdapter } from "../packages/adapters/src/mock.js";
import { Core } from "../packages/core/src/index.js";
import type {
  Room,
  Member,
  Task,
  PeerRequest,
  Run,
} from "../packages/contracts/src/index.js";
const connect = async (url: string, token: string) => {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
};
test("peer endpoint requires run token, rejects identity injection and revokes on abort", async () => {
  let requests = 0;
  const abort = new AbortController();
  const endpoint = await openPeerMcp(
    {
      listMembers: () => [{ id: "peer", name: "Peer" }],
      requestPeer: () => {
        requests++;
        return "request";
      },
      replyPeer: () => {},
      requestPermission: async () => null,
    },
    abort.signal,
  );
  let client: Client | undefined;
  try {
    assert.equal((await fetch(endpoint.url)).status, 403);
    assert.equal(
      (
        await fetch(endpoint.url, {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(endpoint.url, {
          headers: {
            Authorization: `Bearer ${endpoint.token}`,
            Origin: "https://example.com",
          },
        })
      ).status,
      403,
    );
    client = await connect(endpoint.url, endpoint.token);
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name).sort(),
      ["members", "peer_reply", "peer_request"],
    );
    const forged = await client.callTool({
      name: "peer_request",
      arguments: { recipientId: "peer", question: "help", senderId: "forged" },
    });
    assert.equal(forged.isError, true);
    assert.equal(requests, 0);
    assert.equal(
      (
        await client.callTool({
          name: "peer_request",
          arguments: { recipientId: "peer", question: "help" },
        })
      ).isError,
      undefined,
    );
    assert.equal(requests, 1);
    abort.abort();
    await endpoint.close();
    await assert.rejects(
      fetch(endpoint.url, {
        headers: { Authorization: `Bearer ${endpoint.token}` },
      }),
    );
  } finally {
    await client?.close();
    await endpoint.close();
  }
});

test("Codex uses scoped MCP to request a peer and resumes once with its reply", async () => {
  let peerId = "";
  let calls = 0;
  const endpoints: { url: string; token: string }[] = [];
  const adapter = new NativeAdapter("codex", (options) => {
    const url = (options.config as any).mcp_servers.roundloom.url as string;
    const token = options.env!.ROUNDLOOM_PEER_TOKEN;
    endpoints.push({ url, token });
    const thread = {
      async runStreamed(input: string) {
        return {
          events: (async function* (): AsyncGenerator<ThreadEvent> {
            yield { type: "thread.started", thread_id: "codex-peer-session" };
            const client = await connect(url, token);
            try {
              const payload = JSON.parse(input);
              if (!payload.input.startsWith("Peer reply:")) {
                const forbidden = await client.callTool({
                  name: "peer_request",
                  arguments: { recipientId: "not-in-room", question: "bad" },
                });
                assert.equal(forbidden.isError, true);
                const requested = await client.callTool({
                  name: "peer_request",
                  arguments: { recipientId: peerId, question: "Please review" },
                });
                assert.notEqual(requested.isError, true);
                calls++;
              } else
                yield {
                  type: "item.completed",
                  item: {
                    id: "answer",
                    type: "agent_message",
                    text: "Reviewed answer",
                  },
                };
            } finally {
              await client.close();
            }
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 1,
                cache_write_input_tokens: 0,
                reasoning_output_tokens: 0,
              },
            };
          })(),
        };
      },
    };
    return { startThread: () => thread, resumeThread: () => thread };
  });
  const c = new Core(":memory:", [adapter, new MockAdapter()]);
  const call = <T>(operation: string, payload: unknown) =>
    c.execute({
      protocolVersion: 1,
      requestId: randomUUID(),
      operation,
      payload,
    }) as T;
  try {
    const room = call<Room>("rooms.create", { name: "MCP" });
    peerId = call<Member>("members.add", {
      roomId: room.id,
      name: "reviewer",
      adapterId: "mock",
    }).id;
    const owner = call<Member>("members.add", {
      roomId: room.id,
      name: "codex",
      adapterId: "codex",
      config: { cwd: tmpdir() },
    });
    const task = call<Task>("tasks.assign", {
      roomId: room.id,
      ownerId: owner.id,
      goal: "review",
      criteria: ["done"],
    });
    c.start();
    const deadline = Date.now() + 5000;
    while (c.task(task.id).status !== "review") {
      if (Date.now() > deadline) throw new Error("Timeout");
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(calls, 1);
    assert.equal(c.store.list<Run>("run").length, 3);
    assert.equal(c.store.list<PeerRequest>("peer")[0].resumed, true);
    assert.notEqual(endpoints[0].token, endpoints[1].token);
    const persisted = JSON.stringify(
      c.store.db.prepare("SELECT data FROM objects").all(),
    );
    for (const endpoint of endpoints)
      assert.equal(persisted.includes(endpoint.token), false);
    for (const endpoint of endpoints)
      await assert.rejects(
        fetch(endpoint.url, {
          headers: { Authorization: `Bearer ${endpoint.token}` },
        }),
      );
  } finally {
    await c.close();
  }
});
