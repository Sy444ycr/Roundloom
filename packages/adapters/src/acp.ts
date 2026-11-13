import {
  ClientApp,
  ndJsonStream,
  type ClientConnection,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { StructuredCliAdapter } from "./structured-cli.js";
import type {
  Adapter,
  AdapterEvent,
  RunTools,
} from "../../adapter-sdk/src/index.js";
import type { Run } from "../../contracts/src/index.js";
import { CoreError } from "../../contracts/src/index.js";
interface Connection {
  child: ChildProcessWithoutNullStreams;
  rpc: ClientConnection;
  cwd: string;
  nativeSession?: string;
  capabilities: unknown;
  authMethods: unknown;
  active?: {
    run: Run;
    emit: (e: AdapterEvent) => void;
    tools: RunTools;
    text: string;
  };
}
export class AcpAdapter implements Adapter {
  readonly id = "acp";
  readonly simulated = false;
  readonly capabilities = { cancel: true, resume: false, peerMessaging: false };
  private connections = new Map<string, Connection>();
  private states = new Map<
    string,
    "succeeded" | "failed" | "cancelled" | "unknown"
  >();
  validateConfig(config: Record<string, unknown>) {
    return new StructuredCliAdapter().validateConfig(config);
  }
  async connect(sessionId: string, value: Record<string, unknown>) {
    const existing = this.connections.get(sessionId);
    if (existing)
      return {
        capabilities: existing.capabilities,
        authMethods: existing.authMethods,
      };
    const config = this.validateConfig(value);
    const child = spawn(config.executable, config.args, {
      cwd: config.cwd,
      stdio: "pipe",
      windowsHide: true,
      shell: false,
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    const app = new ClientApp();
    let connection: Connection;
    app.onNotification("session/update", ({ params }) => {
      const a = connection?.active;
      if (!a || params.sessionId !== connection.nativeSession) return;
      const update = params.update;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        a.text += update.content.text;
        if (a.text.length > 1_000_000) {
          connection.rpc.close();
          return;
        }
        a.emit({ id: randomUUID(), type: "output", text: update.content.text });
      }
    });
    app.onRequest("session/request_permission", async ({ params }) => {
      const a = connection?.active;
      if (!a || params.sessionId !== connection.nativeSession)
        return { outcome: { outcome: "cancelled" } };
      const selected = await a.tools.requestPermission(
        params.toolCall.title ?? "Agent tool permission",
        params.options.map((o) => ({ id: o.optionId, label: o.name })),
      );
      return selected
        ? { outcome: { outcome: "selected", optionId: selected } }
        : { outcome: { outcome: "cancelled" } };
    });
    const rpc = app.connect(
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        { maxMessageBytes: 2_000_000 },
      ),
    );
    connection = {
      child,
      rpc,
      cwd: config.cwd,
      capabilities: {},
      authMethods: [],
    };
    child.on("error", () => rpc.close());
    child.on("close", () => {
      rpc.close();
      this.connections.delete(sessionId);
    });
    try {
      const init = await rpc.agent.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "roundloom", version: "0.1.0" },
        },
        {
          stopWaitingOnCancel: true,
          cancellationSignal: AbortSignal.timeout(15_000),
        },
      );
      if (init.protocolVersion !== 1)
        throw new CoreError("CONTRACT_MISMATCH", "ACP v1 required");
      connection.capabilities = init.agentCapabilities;
      connection.authMethods = init.authMethods ?? [];
      this.connections.set(sessionId, connection);
      return {
        capabilities: connection.capabilities,
        authMethods: connection.authMethods,
      };
    } catch (e) {
      rpc.close();
      child.kill();
      throw e;
    }
  }
  async authenticate(sessionId: string, methodId: string) {
    const c = this.connections.get(sessionId);
    if (!c) throw new CoreError("NOT_FOUND", "Connect first");
    return c.rpc.agent.request(
      "authenticate",
      { methodId },
      {
        stopWaitingOnCancel: true,
        cancellationSignal: AbortSignal.timeout(120_000),
      },
    );
  }
  async start(run: Run, emit: (e: AdapterEvent) => void, tools: RunTools) {
    await this.connect(run.sessionId, run.config);
    const c = this.connections.get(run.sessionId)!;
    if (c.active) throw new CoreError("CONFLICT", "Session already active");
    if (!c.nativeSession) {
      const session = await c.rpc.agent.request(
        "session/new",
        { cwd: c.cwd, mcpServers: [] },
        {
          stopWaitingOnCancel: true,
          cancellationSignal: AbortSignal.timeout(30_000),
        },
      );
      c.nativeSession = session.sessionId;
    }
    c.active = { run, emit, tools, text: "" };
    this.states.set(run.id, "unknown");
    void c.rpc.agent
      .request("session/prompt", {
        sessionId: c.nativeSession,
        prompt: [
          {
            type: "text",
            text: JSON.stringify({
              input: run.input,
              context: run.contextManifest,
            }),
          },
        ],
      })
      .then((result) => {
        const a = c.active;
        if (!a || a.run.id !== run.id) return;
        const state =
          result.stopReason === "cancelled"
            ? "cancelled"
            : result.stopReason === "end_turn"
              ? "succeeded"
              : "failed";
        if (state === "succeeded" && a.text && run.taskId)
          emit({ id: randomUUID(), type: "result", content: a.text });
        this.states.set(run.id, state);
        emit({ id: randomUUID(), type: "state", state });
      })
      .catch(() => {
        this.states.set(run.id, "unknown");
        emit({ id: randomUUID(), type: "state", state: "unknown" });
      })
      .finally(() => {
        c.active = undefined;
      });
    return { nativeRef: c.nativeSession };
  }
  async cancel(run: Run): Promise<"requested" | "unknown"> {
    const c = this.connections.get(run.sessionId);
    if (!c?.nativeSession) return "unknown";
    await c.rpc.agent.notify("session/cancel", { sessionId: c.nativeSession });
    return "requested";
  }
  async query(run: Run) {
    return this.states.get(run.id) ?? "unknown";
  }
  async disconnect(sessionId: string) {
    const c = this.connections.get(sessionId);
    if (c) {
      c.rpc.close();
      c.child.kill();
      this.connections.delete(sessionId);
    }
  }
  dispose() {
    for (const id of this.connections.keys()) void this.disconnect(id);
  }
}
