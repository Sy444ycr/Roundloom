import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Adapter,
  AdapterEvent,
  RunTools,
} from "../../adapter-sdk/src/index.js";
import type { Run } from "../../contracts/src/index.js";
const configSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()).max(100).default([]),
    cwd: z.string().min(1),
  })
  .strict();
const lineSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("output"), text: z.string().max(100_000) })
    .strict(),
  z
    .object({
      type: z.literal("result"),
      content: z.string().min(1).max(1_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("state"),
      state: z.enum(["succeeded", "failed", "cancelled"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("peer.request"),
      callId: z.string().min(1).max(200),
      recipientId: z.string(),
      question: z.string().min(1).max(100_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("peer.reply"),
      callId: z.string().min(1).max(200),
      requestId: z.string(),
      text: z.string().min(1).max(100_000),
    })
    .strict(),
]);
interface Handle {
  child: ChildProcessWithoutNullStreams;
  terminal: boolean;
  state: "succeeded" | "failed" | "cancelled" | "unknown";
}
/** Roundloom JSONL bridge contract, NOT a promise of arbitrary vendor CLI compatibility. */
export class StructuredCliAdapter implements Adapter {
  readonly id = "structured-cli";
  readonly simulated = false;
  readonly capabilities = { cancel: true, resume: false, peerMessaging: true };
  private handles = new Map<string, Handle>();
  validateConfig(value: Record<string, unknown>) {
    const c = configSchema.parse(value);
    if (!isAbsolute(c.executable) || !isAbsolute(c.cwd))
      throw new Error("Executable and cwd must be absolute");
    c.executable = realpathSync(c.executable);
    c.cwd = realpathSync(c.cwd);
    if (!statSync(c.executable).isFile() || !statSync(c.cwd).isDirectory())
      throw new Error("Invalid executable or workspace");
    return c;
  }
  async start(run: Run, emit: (event: AdapterEvent) => void, tools: RunTools) {
    const config = this.validateConfig(run.config);
    // Deliberately omit arbitrary environment injection and shell command evaluation.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        [
          "PATH",
          "PATHEXT",
          "SYSTEMROOT",
          "WINDIR",
          "TEMP",
          "TMP",
          "HOME",
          "USERPROFILE",
          "LANG",
        ].includes(k.toUpperCase()),
      ),
    );
    const child = spawn(config.executable, config.args, {
      cwd: config.cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    });
    const handle: Handle = { child, terminal: false, state: "unknown" };
    this.handles.set(run.id, handle);
    const finish = (state: "succeeded" | "failed" | "cancelled") => {
      if (handle.terminal) return;
      handle.terminal = true;
      handle.state = state;
      emit({ id: randomUUID(), type: "state", state });
      child.stdin.end();
    };
    const calls = new Map<string, { fingerprint: string; reply: unknown }>();
    child.stdin.on("error", () => {
      /* Process exit is handled separately. */
    });
    child.stderr.on("data", () => {
      /* Provider stderr may contain credentials: do not publish it. */
    });
    let bufferedBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bufferedBytes += chunk.length;
      if (bufferedBytes > 2_000_000 && !handle.terminal) {
        finish("failed");
        child.kill();
      }
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      bufferedBytes = 0;
      if (handle.terminal) return;
      try {
        if (Buffer.byteLength(line) > 1_100_000)
          throw new Error("Oversized frame");
        const event = lineSchema.parse(JSON.parse(line));
        if (event.type === "state") {
          finish(event.state);
          return;
        }
        if (event.type === "output" || event.type === "result") {
          emit({ ...event, id: randomUUID() });
          return;
        }
        const fingerprint = JSON.stringify(event);
        const previous = calls.get(event.callId);
        if (previous && previous.fingerprint !== fingerprint)
          throw new Error("Tool call ID conflict");
        let reply = previous?.reply;
        if (!previous) {
          if (calls.size >= 1000) throw new Error("Tool call limit exceeded");
          try {
            const result =
              event.type === "peer.request"
                ? tools.requestPeer(event.recipientId, event.question)
                : (tools.replyPeer(event.requestId, event.text),
                  { accepted: true });
            reply = {
              type: "tool.result",
              callId: event.callId,
              ok: true,
              result,
            };
          } catch {
            reply = {
              type: "tool.result",
              callId: event.callId,
              ok: false,
              error: "Tool request rejected",
            };
          }
          calls.set(event.callId, { fingerprint, reply });
        }
        child.stdin.write(JSON.stringify(reply) + "\n");
      } catch {
        finish("failed");
        child.kill();
      }
    });
    child.on("error", () => finish("failed"));
    child.on("close", () => {
      lines.close();
      if (!handle.terminal) finish("failed");
    });
    child.stdin.write(
      JSON.stringify({
        type: "run.start",
        protocolVersion: 1,
        runId: run.id,
        sessionId: run.sessionId,
        input: run.input,
        contextManifest: run.contextManifest,
        taskId: run.taskId,
        purpose: run.purpose,
        peerRequestId: run.peerRequestId,
      }) + "\n",
    );
    return { nativeRef: run.id };
  }
  async cancel(run: Run): Promise<"requested" | "unknown"> {
    const h = this.handles.get(run.id);
    if (!h || h.terminal) return "unknown";
    h.child.stdin.write(
      JSON.stringify({ type: "run.cancel", runId: run.id }) + "\n",
    );
    return "requested";
  }
  async query(run: Run) {
    return this.handles.get(run.id)?.state ?? "unknown";
  }
  dispose() {
    for (const h of this.handles.values()) {
      h.terminal = true;
      h.child.kill();
    }
    this.handles.clear();
  }
}
