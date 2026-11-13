import {
  ClientApp,
  ndJsonStream,
  type ClientConnection,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { z } from "zod";
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
  transportClosed?: boolean;
  ready?: boolean;
  cwd: string;
  nativeSession?: string;
  capabilities: { loadSession?: boolean };
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
  readonly capabilities = { cancel: true, resume: true, peerMessaging: false };
  private disposed = false;
  private connecting = new Map<
    string,
    Promise<{ capabilities: { loadSession?: boolean }; authMethods: unknown }>
  >();
  private starting = new Map<string, AbortController>();
  private closingConnections = new WeakMap<Connection, Promise<void>>();
  private connections = new Map<string, Connection>();
  private states = new Map<
    string,
    "succeeded" | "failed" | "cancelled" | "unknown"
  >();
  health(sessionId: string) {
    const c = this.connections.get(sessionId);
    return {
      state:
        c &&
        c.ready &&
        !c.transportClosed &&
        !c.child.stdout.readableEnded &&
        !c.child.stdout.destroyed &&
        !c.child.stdin.destroyed &&
        !c.child.stdin.writableEnded &&
        c.child.exitCode === null &&
        c.child.signalCode === null &&
        !c.child.killed
          ? ("healthy" as const)
          : ("disconnected" as const),
      scope: "local-transport" as const,
    };
  }
  validateConfig(config: Record<string, unknown>) {
    const { timeoutMs, resumeSessions, ...processConfig } = z
      .object({
        executable: z.string(),
        args: z.array(z.string()).optional(),
        cwd: z.string(),
        timeoutMs: z.number().int().min(1000).max(600000).default(120000),
        resumeSessions: z.boolean().default(true),
      })
      .strict()
      .parse(config);
    return {
      ...new StructuredCliAdapter().validateConfig(processConfig),
      timeoutMs,
      resumeSessions,
    };
  }
  async connect(sessionId: string, value: Record<string, unknown>) {
    if (this.disposed) throw new CoreError("CLOSED", "Adapter disposed");
    const pending = this.connecting.get(sessionId);
    if (pending) return pending;
    const promise = this.connectOnce(sessionId, value);
    this.connecting.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      if (this.connecting.get(sessionId) === promise)
        this.connecting.delete(sessionId);
    }
  }
  private async connectOnce(sessionId: string, value: Record<string, unknown>) {
    const existing = this.connections.get(sessionId);
    if (existing && this.health(sessionId).state === "healthy")
      return {
        capabilities: existing.capabilities,
        authMethods: existing.authMethods,
      };
    if (existing) {
      this.connections.delete(sessionId);
      await this.closeConnection(existing);
    }
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
    this.connections.set(sessionId, connection);
    void rpc.closed.then(() => {
      connection.transportClosed = true;
    });
    child.on("error", () => rpc.close());
    child.on("close", () => {
      rpc.close();
      if (this.connections.get(sessionId) === connection)
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
      if (this.disposed || this.connections.get(sessionId) !== connection)
        throw new CoreError(
          "CLOSED",
          "Connection closed during initialization",
        );
      connection.capabilities = init.agentCapabilities ?? {};
      connection.authMethods = init.authMethods ?? [];
      connection.ready = true;
      return {
        capabilities: connection.capabilities,
        authMethods: connection.authMethods,
      };
    } catch (e) {
      if (this.connections.get(sessionId) === connection)
        this.connections.delete(sessionId);
      await this.closeConnection(connection);
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
    if (this.disposed) throw new CoreError("CLOSED", "Adapter disposed");
    const config = this.validateConfig(run.config);
    const controller = new AbortController();
    this.starting.set(run.id, controller);
    const checkStartup = () => {
      if (this.disposed || controller.signal.aborted)
        throw new CoreError("CLOSED", "Run startup cancelled");
    };
    try {
      await this.connect(run.sessionId, run.config);
      checkStartup();
      const c = this.connections.get(run.sessionId);
      if (!c) throw new CoreError("CLOSED", "Connection closed");
      if (c.active) throw new CoreError("CONFLICT", "Session already active");
      c.active = { run, emit, tools, text: "" };
      try {
        if (!c.nativeSession) {
          if (run.nativeRef && config.resumeSessions) {
            if (!c.capabilities.loadSession)
              throw new CoreError(
                "CAPABILITY_UNSUPPORTED",
                "Agent does not support session/load; create a new member or disable resumeSessions explicitly",
              );
            await c.rpc.agent.request(
              "session/load",
              { sessionId: run.nativeRef, cwd: c.cwd, mcpServers: [] },
              {
                stopWaitingOnCancel: true,
                cancellationSignal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(30_000),
                ]),
              },
            );
            c.nativeSession = run.nativeRef;
          } else {
            const session = await c.rpc.agent.request(
              "session/new",
              { cwd: c.cwd, mcpServers: [] },
              {
                stopWaitingOnCancel: true,
                cancellationSignal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(30_000),
                ]),
              },
            );
            c.nativeSession = session.sessionId;
          }
        }
        checkStartup();
        emit({ id: randomUUID(), type: "session", nativeRef: c.nativeSession });
        this.states.set(run.id, "unknown");
        const timeout = AbortSignal.timeout(config.timeoutMs);
        void c.rpc.agent
          .request(
            "session/prompt",
            {
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
            },
            { stopWaitingOnCancel: true, cancellationSignal: timeout },
          )
          .then((result) => {
            const a = c.active;
            if (!a || a.run.id !== run.id) return;
            const state =
              result.stopReason === "cancelled"
                ? "cancelled"
                : result.stopReason === "end_turn"
                  ? "succeeded"
                  : "failed";
            if (state === "succeeded" && a.text) {
              if (run.purpose === "peer" && run.peerRequestId)
                a.tools.replyPeer(run.peerRequestId, a.text);
              else if (run.taskId)
                emit({ id: randomUUID(), type: "result", content: a.text });
            }
            this.states.set(run.id, state);
            emit({ id: randomUUID(), type: "state", state });
          })
          .catch(async () => {
            // A timed out prompt may still be running remotely; discard its transport.
            if (this.connections.get(run.sessionId) === c)
              this.connections.delete(run.sessionId);
            c.active = undefined;
            await this.closeConnection(c);
            this.states.set(run.id, "unknown");
            emit({
              id: randomUUID(),
              type: "state",
              state: "unknown",
              reason: timeout.aborted
                ? "provider_timeout"
                : "provider_connection_failed",
            });
          })
          .finally(() => {
            if (c.active?.run.id === run.id) c.active = undefined;
          });
        return { nativeRef: c.nativeSession };
      } catch (error) {
        if (c.active?.run.id === run.id) c.active = undefined;
        // A cancelled/timed out session/new or load has unknown remote side effects.
        if (this.connections.get(run.sessionId) === c)
          this.connections.delete(run.sessionId);
        await this.closeConnection(c);
        throw error;
      }
    } catch (error) {
      if (controller.signal.aborted && !this.disposed) {
        this.states.set(run.id, "cancelled");
        emit({ id: randomUUID(), type: "state", state: "cancelled" });
        return { nativeRef: "" };
      }
      throw error;
    } finally {
      this.starting.delete(run.id);
    }
  }
  async cancel(run: Run): Promise<"requested" | "unknown"> {
    const starting = this.starting.get(run.id);
    if (starting) {
      starting.abort();
      return "requested";
    }
    const c = this.connections.get(run.sessionId);
    if (!c?.nativeSession || c.active?.run.id !== run.id) return "unknown";
    await c.rpc.agent.notify("session/cancel", { sessionId: c.nativeSession });
    return "requested";
  }
  async query(run: Run) {
    return this.states.get(run.id) ?? "unknown";
  }
  async disconnect(sessionId: string) {
    const c = this.connections.get(sessionId);
    if (c) {
      this.connections.delete(sessionId);
      await this.closeConnection(c);
    }
  }
  private closeConnection(c: Connection): Promise<void> {
    const prior = this.closingConnections.get(c);
    if (prior) return prior;
    const closing = (async () => {
      c.rpc.close();
      if (c.child.exitCode === null && c.child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 5000);
          function done() {
            clearTimeout(timer);
            c!.child.off("exit", done);
            resolve();
          }
          c.child.once("exit", done);
          if (process.platform === "win32" && c.child.pid)
            spawn("taskkill", ["/PID", String(c.child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
              shell: false,
            }).on("error", () => c.child.kill());
          else c.child.kill();
        });
      }
    })();
    this.closingConnections.set(c, closing);
    return closing;
  }
  async dispose() {
    this.disposed = true;
    for (const controller of this.starting.values()) controller.abort();
    await Promise.all(
      [...this.connections.keys()].map((id) => this.disconnect(id)),
    );
    await Promise.allSettled([...this.connecting.values()]);
  }
}
