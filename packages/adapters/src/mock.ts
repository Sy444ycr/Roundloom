import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  Adapter,
  AdapterEvent,
  RunTools,
} from "../../adapter-sdk/src/index.js";
import type { Run } from "../../contracts/src/index.js";
const configSchema = z
  .object({
    delayMs: z.number().int().min(0).max(60_000).default(10),
    fail: z.boolean().default(false),
    hang: z.boolean().default(false),
    peerId: z.string().optional(),
    response: z.string().max(100_000).default("Simulated result"),
  })
  .strict();
export class MockAdapter implements Adapter {
  readonly id = "mock";
  readonly simulated = true;
  readonly capabilities = { cancel: true, resume: false, peerMessaging: true };
  private active = new Map<
    string,
    { timer?: NodeJS.Timeout; emit: (e: AdapterEvent) => void }
  >();
  validateConfig(config: Record<string, unknown>) {
    return configSchema.parse(config);
  }
  async start(run: Run, emit: (e: AdapterEvent) => void, tools: RunTools) {
    const config = configSchema.parse(run.config);

    this.active.set(run.id, { emit });
    if (!config.hang) {
      const timer = setTimeout(() => {
        try {
          if (config.fail) {
            emit({
              id: randomUUID(),
              type: "state",
              state: "failed",
              reason: "Simulated failure",
            });
            return;
          }
          emit({
            id: randomUUID(),
            type: "output",
            text: `[SIMULATED] ${config.response}`,
          });
          if (run.purpose === "peer" && run.peerRequestId)
            tools.replyPeer(run.peerRequestId, config.response);
          else if (config.peerId && !run.input.startsWith("Peer reply:"))
            tools.requestPeer(config.peerId, "Please review the requirements");
          else if (run.taskId)
            emit({
              id: randomUUID(),
              type: "result",
              content: config.response,
            });
          emit({ id: randomUUID(), type: "state", state: "succeeded" });
        } catch {
          emit({
            id: randomUUID(),
            type: "state",
            state: "failed",
            reason: "Simulated tool request failed",
          });
        } finally {
          this.active.delete(run.id);
        }
      }, config.delayMs);
      this.active.get(run.id)!.timer = timer;
    }
    return { nativeRef: run.id };
  }
  async cancel(run: Run): Promise<"requested" | "unknown"> {
    const item = this.active.get(run.id);
    if (!item) return "unknown";
    clearTimeout(item.timer);
    this.active.delete(run.id);
    item.emit({ id: randomUUID(), type: "state", state: "cancelled" });
    return "requested";
  }
  async query(): Promise<"unknown"> {
    return "unknown";
  }
  dispose() {
    for (const item of this.active.values()) clearTimeout(item.timer);
    this.active.clear();
  }
}
