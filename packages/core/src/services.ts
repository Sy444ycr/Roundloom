import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Core } from "./index.js";
import { Workspaces } from "../../workspace/src/index.js";
import {
  CoreError,
  payloads,
  type Run,
  type Member,
} from "../../contracts/src/index.js";
const id = z.string().min(1).max(200);
const path = z.string().min(1).max(4096);
const schemas = {
  "tasks.accept": payloads["tasks.accept"],
  "adapters.list": z.object({}).strict(),
  "members.connect": z.object({ memberId: id }).strict(),
  "members.disconnect": z.object({ memberId: id }).strict(),
  "members.authenticate": z.object({ memberId: id, methodId: id }).strict(),
  "connections.list": z.object({ roomId: id }).strict(),
  "sessions.list": z.object({ roomId: id }).strict(),
  "interactions.list": z.object({ roomId: id }).strict(),
  "interactions.answer": z
    .object({ interactionId: id, optionId: z.string().nullable() })
    .strict(),
  "workspaces.register": z.object({ roomId: id, path }).strict(),
  "workspaces.worktree": z
    .object({
      roomId: id,
      repository: path,
      destination: path,
      revision: z.string().default("HEAD"),
    })
    .strict(),
  "workspaces.list": z.object({ roomId: id }).strict(),
  "workspaces.read": z.object({ workspaceId: id, path }).strict(),
  "workspaces.write": z
    .object({ workspaceId: id, path, content: z.string().max(1_000_000) })
    .strict(),
  "workspaces.snapshot": z.object({ workspaceId: id }).strict(),
  "tests.execute": z
    .object({
      taskId: id,
      workspaceId: id,
      executable: path,
      args: z.array(z.string()).max(100).default([]),
      timeoutMs: z.number().int().min(100).max(600_000).default(60_000),
    })
    .strict(),
  "tests.cancel": z.object({ evidenceId: id }).strict(),
  "tests.list": z.object({ roomId: id }).strict(),
  "storage.backup": z.object({}).strict(),
  "artifacts.capture": z
    .object({
      taskId: id,
      workspaceId: id,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  "artifacts.inspect": z.object({ artifactId: id }).strict(),
  "events.prune": z
    .object({ roomId: id, keepLast: z.number().int().min(1).max(100_000) })
    .strict(),
} as const;
export class Services {
  readonly workspaces: Workspaces;
  private pending = new Map<
    string,
    { fingerprint: string; promise: Promise<unknown> }
  >();
  constructor(
    private core: Core,
    private dataDir: string,
  ) {
    this.workspaces = new Workspaces(core.store);
    for (const i of core.store.list<any>("interaction"))
      if (i.status === "pending") {
        i.status = "expired";
        core.store.put("interaction", i, i.roomId);
      }
  }
  supports(op: string) {
    return op in schemas;
  }
  async execute(raw: unknown): Promise<unknown> {
    const c = z
      .object({
        protocolVersion: z.literal(1),
        requestId: id,
        operation: z.enum(
          Object.keys(schemas) as [
            keyof typeof schemas,
            ...(keyof typeof schemas)[],
          ],
        ),
        payload: z.unknown(),
      })
      .strict()
      .parse(raw);
    const p = schemas[c.operation].parse(c.payload) as Record<string, any>;
    const fingerprint = JSON.stringify({ operation: c.operation, payload: p });
    const read = [
      "adapters.list",
      "connections.list",
      "sessions.list",
      "interactions.list",
      "workspaces.list",
      "workspaces.read",
      "workspaces.snapshot",
      "tests.list",
      "artifacts.inspect",
    ].includes(c.operation);
    if (read) return this.dispatch(c.operation, p);
    const cached = this.core.store.db
      .prepare("SELECT fingerprint,result FROM requests WHERE request_id=?")
      .get(c.requestId) as { fingerprint: string; result: string } | undefined;
    if (cached) {
      if (cached.fingerprint !== fingerprint)
        throw new CoreError("CONFLICT", "Request ID reused");
      const parsed = JSON.parse(cached.result);
      if (parsed.asyncPending)
        throw new CoreError(
          "STATE_UNKNOWN",
          "Previous operation interrupted; inspect its records before retrying",
        );
      return parsed;
    }
    const existing = this.pending.get(c.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new CoreError("CONFLICT", "Request ID reused");
      return existing.promise;
    }
    this.core.store.db
      .prepare("INSERT INTO requests VALUES (?,?,?)")
      .run(c.requestId, fingerprint, JSON.stringify({ asyncPending: true }));
    const promise = this.dispatch(c.operation, p)
      .then((result) => {
        this.core.store.db
          .prepare("UPDATE requests SET result=? WHERE request_id=?")
          .run(JSON.stringify(result ?? {}), c.requestId);
        return result;
      })
      .finally(() => this.pending.delete(c.requestId));
    this.pending.set(c.requestId, { fingerprint, promise });
    return promise;
  }
  private async dispatch(op: string, p: Record<string, any>): Promise<unknown> {
    if (p.roomId) this.core.store.get("room", p.roomId);
    switch (op) {
      case "tasks.accept": {
        const artifact = await this.workspaces.inspect(p.artifactId);
        if (artifact.workspaceId && !artifact.current)
          throw new CoreError(
            "CONFLICT",
            "Workspace has changed since artifact capture",
          );
        return this.core.acceptInspectedArtifact(
          {
            protocolVersion: 1,
            requestId: randomUUID(),
            operation: op,
            payload: p,
          },
          artifact.id,
          artifact.digest,
        );
      }
      case "adapters.list":
        return this.core.listAdapters();
      case "members.connect":
        return this.core.connectMember(p.memberId);
      case "members.disconnect":
        return this.core.disconnectMember(p.memberId);
      case "members.authenticate":
        return this.core.authenticateMember(p.memberId, p.methodId);
      case "connections.list":
        return this.core.store.list("connection", p.roomId);
      case "sessions.list":
        return this.core.store.list("session", p.roomId);
      case "interactions.list":
        return this.core.store.list("interaction", p.roomId);
      case "interactions.answer":
        return this.core.answerPermission(p.interactionId, p.optionId);
      case "workspaces.register":
        return this.workspaces.register(p.roomId, p.path);
      case "workspaces.worktree":
        return this.workspaces.worktree(
          p.roomId,
          p.repository,
          p.destination,
          p.revision,
        );
      case "workspaces.list":
        return this.core.store.list("workspace", p.roomId);
      case "workspaces.read":
        return this.workspaces.read(p.workspaceId, p.path);
      case "workspaces.write":
        return this.workspaces.write(p.workspaceId, p.path, p.content);
      case "workspaces.snapshot":
        return this.workspaces.snapshot(p.workspaceId);
      case "tests.execute": {
        const release = this.core.holdTask(p.taskId);
        try {
          return await this.workspaces.test(
            p.taskId,
            p.workspaceId,
            p.executable,
            p.args,
            p.timeoutMs,
          );
        } finally {
          release();
        }
      }
      case "tests.cancel":
        return this.workspaces.cancel(p.evidenceId);
      case "tests.list":
        return this.core.store.list("evidence", p.roomId);
      case "artifacts.capture": {
        const release = this.core.holdTask(p.taskId);
        try {
          return await this.workspaces.capture(
            p.taskId,
            p.workspaceId,
            p.expectedVersion,
          );
        } finally {
          release();
        }
      }
      case "artifacts.inspect":
        return this.workspaces.inspect(p.artifactId);
      case "events.prune": {
        const watermark = this.core.store.watermark(p.roomId);
        const deleted = this.core.store.db
          .prepare("DELETE FROM events WHERE room_id=? AND sequence<=?")
          .run(p.roomId, watermark - p.keepLast).changes;
        return { deleted, watermark };
      }
      case "storage.backup": {
        if (this.workspaces.busy)
          throw new CoreError(
            "CONFLICT",
            "Finish test execution before backup",
          );
        const directory = resolve(this.dataDir, "backups");
        await mkdir(directory, { recursive: true });
        const file = join(directory, randomUUID() + ".db");
        await this.core.store.db.backup(file);
        return { path: file, externalWorkspacesIncluded: false };
      }
    }
    throw new CoreError("VALIDATION", "Unknown service operation");
  }
  async close() {
    this.workspaces.dispose();
    await Promise.allSettled([...this.pending.values()].map((p) => p.promise));
  }
}
