import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { Core } from "./index.js";
import { MockAdapter } from "../../adapters/src/mock.js";
import { StructuredCliAdapter } from "../../adapters/src/structured-cli.js";
import { CoreError } from "../../contracts/src/index.js";
import { z } from "zod";
import { Services } from "./services.js";
import { AcpAdapter } from "../../adapters/src/acp.js";
import { NativeAdapter } from "../../adapters/src/native.js";
// Trusted parent transport only: no listening TCP port and no remote authentication surface.
const core = new Core(
  resolve(process.env.ROUNDLOOM_DATA_DIR ?? ".roundloom", "core.db"),
  [
    new MockAdapter(),
    new StructuredCliAdapter(),
    new AcpAdapter(),
    new NativeAdapter("claude"),
    new NativeAdapter("codex"),
  ],
);
const services = new Services(
  core,
  resolve(process.env.ROUNDLOOM_DATA_DIR ?? ".roundloom"),
);
core.start();
type ParentPort = {
  postMessage(value: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
};
const electronPort = (process as typeof process & { parentPort?: ParentPort })
  .parentPort;
const send = (value: unknown) => {
  if (electronPort) electronPort.postMessage(value);
  else if (process.send) process.send(value);
  else process.stdout.write(JSON.stringify(value) + "\n");
};
let tail = Promise.resolve();
const subscriptions = new Map<
  string,
  { roomId: string; cursor: number; pending: number | null }
>();
const subscribeSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: z.string().min(1),
    operation: z.literal("events.subscribe"),
    payload: z
      .object({
        roomId: z.string().min(1),
        after: z.number().int().nonnegative().default(0),
      })
      .strict(),
  })
  .strict();
const ackSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: z.string().min(1),
    operation: z.literal("events.ack"),
    payload: z
      .object({
        subscriptionId: z.string(),
        sequence: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const unsubscribeSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: z.string().min(1),
    operation: z.literal("events.unsubscribe"),
    payload: z.object({ subscriptionId: z.string() }).strict(),
  })
  .strict();
const reconcileSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: z.string().min(1),
    operation: z.literal("runs.reconcile"),
    payload: z.object({ runId: z.string() }).strict(),
  })
  .strict();
const feedTimer = setInterval(() => {
  for (const [subscriptionId, sub] of subscriptions) {
    if (sub.pending !== null) continue;
    let events;
    try {
      events = core.store.events(sub.roomId, sub.cursor, 100);
    } catch (error) {
      send({ type: "events.resync_required", subscriptionId });
      subscriptions.delete(subscriptionId);
      continue;
    }
    if (events.length) {
      sub.pending = events.at(-1)!.sequence;
      send({ type: "events.batch", subscriptionId, events });
    }
  }
}, 25);
feedTimer.unref();
function receive(raw: unknown) {
  if (exiting) return;
  const handling = (async () => {
    const requestId =
      typeof raw === "object" && raw !== null && "requestId" in raw
        ? String(raw.requestId)
        : null;
    try {
      let data: unknown;
      const operation =
        typeof raw === "object" && raw !== null && "operation" in raw
          ? raw.operation
          : undefined;
      if (operation === "events.subscribe") {
        const { payload } = subscribeSchema.parse(raw);
        core.store.get("room", payload.roomId);
        if (payload.after > core.store.watermark(payload.roomId))
          throw new CoreError("VALIDATION", "Cursor exceeds room history");
        const existing = subscriptions.get(requestId!);
        if (existing && existing.roomId !== payload.roomId)
          throw new CoreError("CONFLICT", "Subscription ID is already used");
        if (!existing && subscriptions.size >= 64)
          throw new CoreError("LIMIT_EXCEEDED", "Too many subscriptions");
        if (!existing)
          subscriptions.set(requestId!, {
            roomId: payload.roomId,
            cursor: payload.after,
            pending: null,
          });
        data = { subscriptionId: requestId };
      } else if (operation === "events.ack") {
        const { payload } = ackSchema.parse(raw);
        const sub = subscriptions.get(payload.subscriptionId);
        if (!sub) throw new CoreError("NOT_FOUND", "Subscription not found");
        if (payload.sequence !== sub.pending && payload.sequence !== sub.cursor)
          throw new CoreError("CONFLICT", "Invalid acknowledgement");
        if (payload.sequence === sub.pending) {
          sub.cursor = payload.sequence;
          sub.pending = null;
        }
        data = { acknowledged: true };
      } else if (operation === "events.unsubscribe") {
        const { payload } = unsubscribeSchema.parse(raw);
        data = { removed: subscriptions.delete(payload.subscriptionId) };
      } else if (operation === "runs.reconcile") {
        const { payload } = reconcileSchema.parse(raw);
        data = { state: await core.reconcile(payload.runId) };
      } else if (typeof operation === "string" && services.supports(operation))
        data = await services.execute(raw);
      else data = core.execute(raw);
      send({ requestId, ok: true, data });
    } catch (e) {
      send({
        requestId,
        ok: false,
        error: {
          code:
            e instanceof CoreError
              ? e.code
              : e instanceof z.ZodError
                ? "VALIDATION"
                : "INTERNAL",
          message:
            e instanceof CoreError
              ? e.message
              : e instanceof z.ZodError
                ? "Invalid command payload"
                : "Operation failed",
        },
      });
    }
  })();
  tail = Promise.allSettled([tail, handling]).then(() => {});
}
if (electronPort) electronPort.on("message", (event) => receive(event.data));
else if (process.send) process.on("message", receive);
else {
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    if (line.length > 1_100_000) {
      send({
        ok: false,
        error: { code: "VALIDATION", message: "Command too large" },
      });
      return;
    }
    try {
      receive(JSON.parse(line));
    } catch {
      send({
        ok: false,
        error: { code: "VALIDATION", message: "Invalid JSON" },
      });
    }
  });
  lines.on("close", () => void shutdown());
}
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  clearInterval(feedTimer);
  subscriptions.clear();
  await services.close();
  await tail;
  await core.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("disconnect", () => void shutdown());
send({
  type: "core.ready",
  protocolVersion: 1,
  adapterIds: ["mock", "structured-cli", "acp", "claude", "codex"],
});
