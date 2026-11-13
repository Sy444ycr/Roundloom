import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openPeerMcp } from "../packages/adapters/src/peer-mcp.js";
const cycles = Number(process.argv[2] ?? 1000);
assert.ok(Number.isInteger(cycles) && cycles >= 10 && cycles <= 100000);
const directory = resolve(".roundloom", "mcp-soak", randomUUID());
mkdirSync(directory, { recursive: true });
const serverHandles = () =>
  process.getActiveResourcesInfo().filter((n) => n === "TCPServerWrap").length;
const baselineHandles = serverHandles();
global.gc?.();
const baseline = process.memoryUsage().heapUsed;
let completed = 0,
  requests = 0,
  failure: string | undefined;
const started = Date.now();
try {
  while (completed < cycles) {
    await Promise.all(
      Array.from({ length: Math.min(8, cycles - completed) }, async () => {
        const abort = new AbortController();
        const endpoint = await openPeerMcp(
          {
            listMembers: () => [],
            requestPeer: () => {
              requests++;
              return "peer";
            },
            replyPeer: () => {},
            requestPermission: async () => null,
          },
          abort.signal,
        );
        const client = new Client({ name: "load", version: "1" });
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(endpoint.url), {
              requestInit: {
                headers: { Authorization: `Bearer ${endpoint.token}` },
              },
            }),
          );
          const result = await client.callTool({
            name: "peer_request",
            arguments: { recipientId: "peer", question: "load" },
          });
          assert.notEqual(result.isError, true);
          abort.abort();
        } finally {
          await client.close();
          await endpoint.close();
        }
        completed++;
      }),
    );
  }
  await new Promise((r) => setTimeout(r, 100));
  global.gc?.();
  assert.equal(requests, cycles);
  assert.equal(serverHandles(), baselineHandles);
  assert.ok(
    process.memoryUsage().heapUsed - baseline < 64 * 1048576,
    "MCP retained heap growth over 64 MiB",
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
}
const report = {
  passed: !failure,
  failure,
  cycles,
  completed,
  requests,
  concurrency: 8,
  elapsedSeconds: (Date.now() - started) / 1000,
  heapGrowthMiB: (process.memoryUsage().heapUsed - baseline) / 1048576,
  remainingServerHandles: serverHandles() - baselineHandles,
  gcAvailable: !!global.gc,
};
writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({ ...report, report: join(directory, "report.json") }),
);
