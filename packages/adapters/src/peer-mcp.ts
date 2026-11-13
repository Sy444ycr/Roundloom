import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { RunTools } from "../../adapter-sdk/src/index.js";
import { CoreError } from "../../contracts/src/index.js";

/** Ephemeral authenticated loopback endpoint; one instance belongs to one run. */
export async function openPeerMcp(tools: RunTools, signal: AbortSignal) {
  const token = randomBytes(32).toString("hex");
  const server = new McpServer({ name: "roundloom", version: "0.1.0" });
  let closed = false;
  const invoke = (operation: () => unknown) => {
    try {
      if (closed || signal.aborted)
        throw new CoreError("FORBIDDEN", "Run scope expired");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(operation()) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: error instanceof CoreError ? error.code : "TOOL_FAILED",
          },
        ],
      };
    }
  };
  server.registerTool(
    "members",
    {
      description: "List members of the current room",
      inputSchema: z.object({}).strict(),
    },
    () => invoke(() => tools.listMembers()),
  );
  server.registerTool(
    "peer_request",
    {
      description:
        "Ask a project member for help; end this turn after sending. The platform resumes you with the reply.",
      inputSchema: z
        .object({
          recipientId: z.string().min(1).max(200),
          question: z.string().min(1).max(100000),
        })
        .strict(),
    },
    (args) =>
      invoke(() => ({
        requestId: tools.requestPeer(args.recipientId, args.question),
      })),
  );
  server.registerTool(
    "peer_reply",
    {
      description: "Reply to the peer request assigned to this run",
      inputSchema: z
        .object({
          requestId: z.string().min(1).max(200),
          text: z.string().min(1).max(100000),
        })
        .strict(),
    },
    (args) =>
      invoke(() => {
        tools.replyPeer(args.requestId, args.text);
        return { accepted: true };
      }),
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const http = createServer((req, res) => {
    void (async () => {
      if (closed || signal.aborted) {
        res.writeHead(410).end();
        return;
      }
      if (
        req.headers.authorization !== `Bearer ${token}` ||
        req.headers.origin
      ) {
        res.writeHead(403).end();
        return;
      }
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      let body: unknown;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 150000) {
            res.writeHead(413).end();
            req.resume();
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400).end();
          return;
        }
      }
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Missing peer endpoint");
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      signal.removeEventListener("abort", abort);
      http.closeAllConnections();
      await Promise.all([
        server.close(),
        new Promise<void>((resolve) => http.close(() => resolve())),
      ]);
    })());
  const abort = () => {
    void close();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) await close();
  return { url: `http://127.0.0.1:${address.port}/mcp`, token, close };
}
