import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../../storage/src/index.js";
import {
  commandSchema,
  payloads,
  CoreError,
  requireThat as check,
  type Room,
  type Member,
  type Message,
  type Task,
  type Run,
  type PeerRequest,
  type Artifact,
} from "../../contracts/src/index.js";
import type {
  Adapter,
  AdapterEvent,
  RunTools,
} from "../../adapter-sdk/src/index.js";
import {
  isActiveRun as active,
  isTerminalRun as terminal,
  currentOwnerRun,
} from "../../domain/src/index.js";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export class Core {
  private validatedFileArtifact?: string;
  acceptInspectedArtifact(
    command: unknown,
    artifactId: string,
    digest: string,
  ) {
    const artifact = this.store.get<Artifact>("artifact", artifactId);
    check(
      artifact.digest === digest,
      "CONFLICT",
      "Artifact changed during verification",
    );
    this.validatedFileArtifact = artifactId;
    try {
      return this.execute(command);
    } finally {
      this.validatedFileArtifact = undefined;
    }
  }
  private taskHolds = new Set<string>();
  holdTask(taskId: string) {
    check(
      !this.store.isArchived(taskId),
      "ARCHIVED",
      "Restore task before executing work",
    );
    check(
      !this.taskHolds.has(taskId) && !this.runs(taskId).some(active),
      "CONFLICT",
      "Task has active work",
    );
    this.taskHolds.add(taskId);
    return () => this.taskHolds.delete(taskId);
  }
  private permissions = new Map<
    string,
    { resolve: (value: string | null) => void; timer: NodeJS.Timeout }
  >();
  listAdapters() {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      simulated: a.simulated,
      capabilities: a.capabilities,
    }));
  }
  private memberControls = new Set<string>();
  private async controlMember<T>(
    memberId: string,
    operation: () => Promise<T>,
  ) {
    check(!this.closing && !this.stopped, "CLOSED", "Core is closing");
    check(
      !this.memberControls.has(memberId),
      "CONFLICT",
      "Member connection operation in progress",
    );
    this.memberControls.add(memberId);
    try {
      return await operation();
    } finally {
      this.memberControls.delete(memberId);
    }
  }
  connectMember(memberId: string) {
    return this.controlMember(memberId, () => this.connectMemberOnce(memberId));
  }
  private async connectMemberOnce(memberId: string) {
    check(!this.closing && !this.stopped, "CLOSED", "Core is closing");
    const m = this.store.get<Member>("member", memberId);
    const a = this.adapters.get(m.adapterId)!;
    const record = {
      id: "connection:" + m.sessionId,
      sessionId: m.sessionId,
      roomId: m.roomId,
      memberId,
      status: "connecting",
      capabilities: a.capabilities,
    };
    this.store.put("connection", record, m.roomId);
    this.store.event(m.roomId, "connection.changed", record);
    try {
      const details = a.connect
        ? await a.connect(m.sessionId, m.config)
        : { available: true };
      check(!this.closing && !this.stopped, "CLOSED", "Core is closing");
      const connected = { ...record, status: "connected", details };
      this.store.put("connection", connected, m.roomId);
      this.store.event(m.roomId, "connection.changed", connected);
      return connected;
    } catch {
      check(!this.closing && !this.stopped, "CLOSED", "Core is closing");
      const failed = { ...record, status: "failed" };
      this.store.put("connection", failed, m.roomId);
      this.store.event(m.roomId, "connection.changed", failed);
      throw new CoreError(
        "CONNECTION_FAILED",
        "Connection failed; check executable and authentication",
      );
    }
  }
  authenticateMember(memberId: string, methodId: string) {
    return this.controlMember(memberId, () =>
      this.authenticateMemberOnce(memberId, methodId),
    );
  }
  private async authenticateMemberOnce(memberId: string, methodId: string) {
    check(!this.closing && !this.stopped, "CLOSED", "Core is closing");
    const m = this.store.get<Member>("member", memberId);
    const a = this.adapters.get(m.adapterId)!;
    check(
      a.authenticate,
      "CAPABILITY_UNSUPPORTED",
      "Adapter has no authentication operation",
    );
    return a.authenticate(m.sessionId, methodId);
  }
  disconnectMember(memberId: string) {
    return this.controlMember(memberId, () =>
      this.disconnectMemberOnce(memberId),
    );
  }
  private async disconnectMemberOnce(memberId: string) {
    check(!this.closing && !this.stopped, "CLOSED", "Core is closing");
    const m = this.store.get<Member>("member", memberId);
    check(
      !this.store.activeRuns().some((r) => r.memberId === m.id && active(r)),
      "CONFLICT",
      "Member has active execution",
    );
    await this.adapters.get(m.adapterId)?.disconnect?.(m.sessionId);
    check(!this.closing && !this.stopped, "CLOSED", "Core is closing");
    const value = {
      id: "connection:" + m.sessionId,
      sessionId: m.sessionId,
      roomId: m.roomId,
      memberId,
      status: "disconnected",
    };
    this.store.put("connection", value, m.roomId);
    this.store.event(m.roomId, "connection.changed", value);
    return value;
  }
  answerPermission(id: string, optionId: string | null) {
    const item = this.store.get<{
      id: string;
      roomId: string;
      runId: string;
      status: string;
      options: { id: string }[];
    }>("interaction", id);
    check(
      item.status === "pending" && this.permissions.has(id),
      "CONFLICT",
      "Permission request expired",
    );
    check(
      optionId === null || item.options.some((o) => o.id === optionId),
      "VALIDATION",
      "Invalid permission option",
    );
    item.status = optionId === null ? "cancelled" : "answered";
    this.store.put("interaction", { ...item, selected: optionId }, item.roomId);
    this.store.event(item.roomId, "interaction.answered", { id, optionId });
    const p = this.permissions.get(id)!;
    clearTimeout(p.timer);
    this.permissions.delete(id);
    p.resolve(optionId);
    return { accepted: true };
  }
  readonly store: Store;
  private adapters = new Map<string, Adapter>();
  private pumping = false;
  private stopped = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private cancelInFlight = new Set<string>();
  private cancelDelivered = new Set<string>();
  private lastCancelAttempt = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  checkConnections(roomId?: string) {
    check(!this.closing && !this.stopped, "CLOSED", "Core is closing");
    if (roomId) this.room(roomId);
    const records = this.store.list<any>("connection", roomId);
    const known = new Set(records.map((r) => r.sessionId));
    for (const member of this.store.list<Member>("member", roomId)) {
      if (known.has(member.sessionId)) continue;
      try {
        if (
          this.adapters.get(member.adapterId)?.health?.(member.sessionId)
            .state === "healthy"
        )
          records.push({
            id: "connection:" + member.sessionId,
            sessionId: member.sessionId,
            roomId: member.roomId,
            memberId: member.id,
            status: "unknown",
          });
      } catch {
        /* An unconnected member has no connection to report. */
      }
    }
    return records.map((record) => {
      if (
        record.status === "connecting" ||
        this.memberControls.has(record.memberId)
      )
        return record;
      const member = this.store.get<Member>("member", record.memberId);
      const adapter = this.adapters.get(member.adapterId);
      let health: { state: string; scope: string };
      try {
        health = adapter?.health?.(member.sessionId) ?? {
          state: "unknown",
          scope: "unsupported",
        };
      } catch {
        health = { state: "unknown", scope: "probe-failed" };
      }
      const value = {
        ...record,
        health: { ...health, checkedAt: new Date().toISOString() },
        status:
          health.state === "disconnected"
            ? "disconnected"
            : health.state === "healthy"
              ? "connected"
              : record.status,
      };
      this.store.transaction(() => {
        this.store.put("connection", value, value.roomId);
        if (
          record.status !== value.status ||
          record.health?.state !== health.state ||
          record.health?.scope !== health.scope
        )
          this.store.event(value.roomId, "connection.changed", value);
      });
      return value;
    });
  }
  constructor(path: string, adapters: Adapter[]) {
    this.store = new Store(path);
    for (const a of adapters) {
      check(!this.adapters.has(a.id), "CONFLICT", "Duplicate adapter");
      this.adapters.set(a.id, a);
    }
    this.store.transaction(() => {
      for (const connection of this.store.list<{
        id: string;
        roomId: string;
        status: string;
      }>("connection")) {
        if (["connecting", "connected"].includes(connection.status)) {
          connection.status = "unknown";
          this.store.put("connection", connection, connection.roomId);
          this.store.event(connection.roomId, "connection.changed", connection);
        }
      }
      for (const run of this.store.activeRuns())
        if (active(run)) {
          run.status = "unknown";
          this.saveRun(run);
          this.store.event(run.roomId, "run.recovery_required", run);
          if (run.taskId) {
            const t = this.task(run.taskId);
            if (!["completed", "cancelled"].includes(t.status)) {
              t.status = "waiting";
              t.waitReason = "state_unknown";
              this.saveTask(t);
            }
          }
        }
    });
  }
  start() {
    check(
      !this.stopped && !this.closing,
      "CLOSED",
      "Core is closing or closed",
    );
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.expirePeers();
        void this.pump();
      }, 20);
      this.timer.unref();
    }
    void this.pump();
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => this.checkConnections(), 5000);
      this.healthTimer.unref();
    }
  }
  task(id: string) {
    return this.store.get<Task>("task", id);
  }
  private room(id: string) {
    return this.store.get<Room>("room", id);
  }
  private member(id: string, roomId: string) {
    const m = this.store.get<Member>("member", id);
    check(m.roomId === roomId, "FORBIDDEN", "Member belongs to another room");
    return m;
  }
  private saveTask(t: Task) {
    t.version++;
    this.store.put("task", t, t.roomId);
    this.store.event(t.roomId, "task.changed", t);
    return t;
  }
  private saveRun(r: Run) {
    this.store.put(
      "session",
      {
        id: r.sessionId,
        roomId: r.roomId,
        memberId: r.memberId,
        adapterId: r.adapterId,
        nativeRef:
          r.nativeRef ||
          this.store
            .list<{ id: string; nativeRef?: string }>("session", r.roomId)
            .find((s) => s.id === r.sessionId)?.nativeRef,
        status: r.status,
        lastRunId: r.id,
      },
      r.roomId,
    );
    this.store.put("run", r, r.roomId);
    this.store.event(r.roomId, "run.changed", r);
    return r;
  }
  private runs(taskId: string) {
    return this.store.runsForTask(taskId);
  }
  private version(t: Task, version: number) {
    check(
      t.version === version,
      "CONFLICT",
      `Task changed; current version ${t.version}`,
    );
  }
  private message(
    roomId: string,
    senderId: string,
    text: string,
    recipients: string[],
    taskId?: string,
    requestId?: string,
  ) {
    const m: Message = {
      id: randomUUID(),
      roomId,
      senderId,
      text,
      recipients,
      taskId,
      requestId,
    };
    this.store.put("message", m, roomId);
    this.store.event(roomId, "message.created", m);
    return m;
  }
  private enqueue(
    member: Member,
    input: string,
    task?: Task,
    purpose: Run["purpose"] = "task",
    peerRequestId?: string,
  ) {
    const run: Run = {
      id: randomUUID(),
      roomId: member.roomId,
      memberId: member.id,
      sessionId: member.sessionId,
      taskId: task?.id,
      input,
      status: "queued",
      requirementsVersion: task?.requirementsVersion ?? 0,
      ownershipVersion: task?.ownershipVersion ?? 0,
      attempt: task?.attempt ?? 0,
      purpose,
      peerRequestId,
      cancelRequested: false,
      config: member.config,
      adapterId: member.adapterId,
    };
    const previous = this.store
      .list<{ id: string; nativeRef?: string }>("session", member.roomId)
      .find((s) => s.id === member.sessionId);
    if (this.adapters.get(member.adapterId)?.capabilities.resume)
      run.nativeRef = previous?.nativeRef;
    this.saveRun(run);
    this.store.db
      .prepare("INSERT INTO dispatch VALUES (?,?)")
      .run(run.id, "pending");
    return run;
  }
  execute(raw: unknown): unknown {
    check(!this.stopped && !this.closing, "CLOSED", "Core is shutting down");
    let command;
    let p: Record<string, any>;
    try {
      command = commandSchema.parse(raw);
      p = payloads[command.operation].parse(command.payload) as Record<
        string,
        any
      >;
    } catch (e) {
      if (e instanceof z.ZodError)
        throw new CoreError(
          "VALIDATION",
          e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      throw e;
    }
    const fingerprint = canonical({ operation: command.operation, payload: p });
    const result = this.store.transaction(() => {
      const previous = this.store.db
        .prepare("SELECT fingerprint,result FROM requests WHERE request_id=?")
        .get(command.requestId) as
        { fingerprint: string; result: string } | undefined;
      if (previous) {
        check(
          previous.fingerprint === fingerprint,
          "CONFLICT",
          "Request ID reused with different payload",
        );
        return JSON.parse(previous.result);
      }
      const result = this.dispatch(command.operation, p);
      // Reads return current state; only writes are cached for retry safety.
      if (
        ![
          "rooms.list",
          "members.list",
          "messages.list",
          "tasks.get",
          "tasks.list",
          "runs.list",
          "artifacts.list",
          "events.read",
          "rooms.snapshot",
        ].includes(command.operation)
      )
        this.store.db
          .prepare("INSERT INTO requests VALUES (?,?,?)")
          .run(command.requestId, fingerprint, JSON.stringify(result));
      return result;
    });
    void this.pump();
    return result;
  }
  private dispatch(op: string, p: Record<string, any>): unknown {
    if (op === "rooms.create") {
      const r: Room = { id: randomUUID(), name: p.name, paused: false };
      this.store.put("room", r, r.id);
      this.store.event(r.id, "room.created", r);
      return r;
    }
    if (op === "rooms.list") return this.store.list<Room>("room");
    if (p.roomId) this.room(p.roomId);
    if (op === "rooms.pause") {
      const r = this.room(p.roomId);
      r.paused = p.paused;
      this.store.put("room", r, r.id);
      this.store.event(r.id, "room.changed", r);
      return r;
    }
    if (op === "members.add") {
      const adapter = this.adapters.get(p.adapterId);
      check(adapter, "CAPABILITY_UNSUPPORTED", "Adapter not registered");
      const config = adapter.validateConfig(p.config);
      const m: Member = {
        id: randomUUID(),
        roomId: p.roomId,
        name: p.name,
        adapterId: p.adapterId,
        config,
        sessionId: randomUUID(),
        simulated: adapter.simulated,
      };
      this.store.put("member", m, m.roomId);
      this.store.event(m.roomId, "member.created", {
        ...m,
        capabilities: adapter.capabilities,
      });
      return m;
    }
    if (op === "members.list")
      return this.store.list<Member>("member", p.roomId);
    if (op === "messages.send") {
      const members = [...new Set<string>(p.recipients)].map((id) =>
        this.member(id, p.roomId),
      );
      const m = this.message(
        p.roomId,
        "user",
        p.text,
        members.map((m) => m.id),
      );
      for (const member of members)
        this.enqueue(member, p.text, undefined, "discussion");
      return m;
    }
    if (op === "messages.list")
      return this.store
        .list<Message>("message", p.roomId)
        .slice(p.after, p.after + p.limit);
    if (op === "tasks.assign") {
      const owner = this.member(p.ownerId, p.roomId);
      const t: Task = {
        id: randomUUID(),
        roomId: p.roomId,
        ownerId: owner.id,
        goal: p.goal,
        criteria: p.criteria,
        version: 1,
        requirementsVersion: 1,
        ownershipVersion: 1,
        status: "queued",
        cancelRequested: false,
        maxRuns: p.maxRuns,
        runCount: 0,
        attempt: 1,
      };
      this.store.put("task", t, t.roomId);
      this.store.event(t.roomId, "task.created", t);
      this.message(t.roomId, "user", t.goal, [owner.id], t.id);
      this.enqueue(owner, t.goal, t);
      return t;
    }
    if (op === "tasks.list") return this.store.list<Task>("task", p.roomId);
    if (op === "runs.list") return this.store.list<Run>("run", p.roomId);
    if (op === "events.read")
      return this.store.events(p.roomId, p.after, p.limit);
    if (op === "rooms.snapshot")
      return {
        room: this.room(p.roomId),
        members: this.store.list<Member>("member", p.roomId),
        tasks: this.store.list<Task>("task", p.roomId),
        runs: this.store.list<Run>("run", p.roomId),
        sequence: this.store.watermark(p.roomId),
      };
    const t = this.task(p.taskId);
    if (op === "tasks.get") return t;
    if (op === "artifacts.list")
      return this.store.historyForTask<Artifact>("artifact", t.id);
    check(
      !this.store.isArchived(t.id),
      "ARCHIVED",
      "Restore archived task before modifying it",
    );
    this.version(t, p.expectedVersion);
    if (op === "tasks.cancel") {
      check(
        t.status !== "completed",
        "CONFLICT",
        "Completed task cannot be cancelled",
      );
      t.cancelRequested = true;
      for (const i of this.store.list<{
        id: string;
        runId: string;
        status: string;
      }>("interaction"))
        if (
          i.status === "pending" &&
          this.runs(t.id).some((r) => r.id === i.runId) &&
          this.permissions.has(i.id)
        )
          this.answerPermission(i.id, null);
      for (const r of this.runs(t.id))
        if (!terminal(r)) {
          r.cancelRequested = true;
          if (r.status === "queued") {
            r.status = "cancelled";
            this.store.db
              .prepare("UPDATE dispatch SET status='done' WHERE run_id=?")
              .run(r.id);
          }
          this.saveRun(r);
        }
      for (const q of this.store.peersForTask(t.id))
        if (q.taskId === t.id && q.status === "pending") {
          q.status = "cancelled";
          this.store.put("peer", q, q.roomId);
        }
      t.status = this.runs(t.id).some(active) ? "waiting" : "cancelled";
      t.waitReason = t.status === "waiting" ? "cancel_pending" : undefined;
      return this.saveTask(t);
    }
    check(
      !t.cancelRequested || op === "tasks.retry",
      "CONFLICT",
      "Task cancellation is active",
    );
    if (op === "tasks.continue") {
      check(t.status === "waiting", "CONFLICT", "Task is not waiting");
      check(
        !this.runs(t.id).some(active),
        "STATE_UNKNOWN",
        "Reconcile or finish active runs first",
      );
      check(
        !this.store
          .peersForTask(t.id)
          .some((q) => q.taskId === t.id && q.status === "pending"),
        "CONFLICT",
        "Peer request is still pending",
      );
      if (p.maxRuns !== undefined) t.maxRuns = p.maxRuns;
      check(
        t.runCount < t.maxRuns,
        "BUDGET_EXCEEDED",
        "Increase the run budget before continuing",
      );
      this.cancelQueued(t.id);
      t.status = "queued";
      t.waitReason = undefined;
      this.message(t.roomId, "user", p.note, [t.ownerId], t.id);
      this.enqueue(
        this.member(t.ownerId, t.roomId),
        t.goal + "\nUser continuation: " + p.note,
        t,
      );
      return this.saveTask(t);
    }
    if (op === "tasks.update") {
      check(
        !["completed", "cancelled", "failed"].includes(t.status),
        "CONFLICT",
        "Task is terminal",
      );
      t.goal = p.goal;
      t.criteria = p.criteria;
      t.requirementsVersion++;
      t.artifactId = undefined;
      if (t.status === "review") {
        t.status = "queued";
        this.enqueue(this.member(t.ownerId, t.roomId), t.goal, t);
      }
      return this.saveTask(t);
    }
    if (op === "tasks.handoff") {
      check(
        !["completed", "cancelled", "failed"].includes(t.status),
        "CONFLICT",
        "Task is terminal",
      );
      check(
        !this.runs(t.id).some(active),
        "CONFLICT",
        "Active runs must finish before handoff",
      );
      check(
        !this.store
          .peersForTask(t.id)
          .some((q) => q.taskId === t.id && q.status === "pending"),
        "CONFLICT",
        "Resolve pending peer request before handoff",
      );
      const owner = this.member(p.ownerId, t.roomId);
      this.cancelQueued(t.id);
      t.ownerId = owner.id;
      t.ownershipVersion++;
      t.artifactId = undefined;
      t.status = "queued";
      t.waitReason = undefined;
      this.message(t.roomId, "user", p.note, [owner.id], t.id);
      this.enqueue(owner, t.goal + "\nHandoff: " + p.note, t);
      return this.saveTask(t);
    }
    if (op === "tasks.retry") {
      check(
        ["failed", "cancelled"].includes(t.status),
        "CONFLICT",
        "Only failed or cancelled tasks may retry",
      );
      check(
        !this.runs(t.id).some(active),
        "STATE_UNKNOWN",
        "Reconcile active run first",
      );
      t.attempt++;
      t.runCount = 0;
      t.cancelRequested = false;
      t.status = "queued";
      t.waitReason = undefined;
      t.artifactId = undefined;
      this.enqueue(this.member(t.ownerId, t.roomId), t.goal, t);
      return this.saveTask(t);
    }
    if (op === "tasks.accept") {
      check(
        t.status === "review" && !this.runs(t.id).some(active),
        "CONFLICT",
        "Task is not ready for acceptance",
      );
      const a = this.store.get<Artifact>("artifact", p.artifactId);
      check(
        !("workspaceId" in a) || this.validatedFileArtifact === a.id,
        "ASYNC_VERIFICATION_REQUIRED",
        "File artifacts must be verified by the service before acceptance",
      );
      check(
        a.taskId === t.id &&
          t.artifactId === a.id &&
          a.requirementsVersion === t.requirementsVersion &&
          p.requirementsVersion === t.requirementsVersion,
        "CONFLICT",
        "Stale artifact or requirements",
      );
      const acceptance = {
        id: randomUUID(),
        taskId: t.id,
        artifactId: a.id,
        requirementsVersion: t.requirementsVersion,
        criteria: t.criteria,
        actor: "user",
        at: new Date().toISOString(),
      };
      this.store.put("acceptance", acceptance, t.roomId);
      this.store.event(t.roomId, "task.accepted", acceptance);
      t.status = "completed";
      return this.saveTask(t);
    }
    if (op === "tasks.reject") {
      check(t.status === "review", "CONFLICT", "Task is not in review");
      this.message(t.roomId, "user", p.reason, [t.ownerId], t.id);
      t.status = "queued";
      t.artifactId = undefined;
      this.enqueue(
        this.member(t.ownerId, t.roomId),
        t.goal + "\nFeedback: " + p.reason,
        t,
      );
      return this.saveTask(t);
    }
    throw new CoreError("VALIDATION", "Unknown operation");
  }
  private cancelQueued(taskId: string) {
    for (const r of this.runs(taskId))
      if (r.status === "queued") {
        r.status = "cancelled";
        this.saveRun(r);
        this.store.db
          .prepare("UPDATE dispatch SET status='done' WHERE run_id=?")
          .run(r.id);
      }
  }
  async pump(): Promise<void> {
    if (this.pumping || this.stopped || this.closing) return;
    this.pumping = true;
    try {
      for (const r of this.store
        .activeRuns()
        .filter((r) => active(r) && r.cancelRequested)) {
        const adapter = this.adapters.get(r.adapterId);
        if (!adapter?.capabilities.cancel) continue;
        if (
          this.cancelInFlight.has(r.id) ||
          this.cancelDelivered.has(r.id) ||
          Date.now() - (this.lastCancelAttempt.get(r.id) ?? 0) < 1000
        )
          continue;
        this.lastCancelAttempt.set(r.id, Date.now());
        this.cancelInFlight.add(r.id);
        void Promise.resolve()
          .then(() => adapter.cancel(r))
          .then((result) => {
            if (result === "requested" || result === "unsupported")
              this.cancelDelivered.add(r.id);
          })
          .catch(() => {
            /* Failure is not a terminal state. */
          })
          .finally(() => this.cancelInFlight.delete(r.id));
      }
      const pending = this.store.db
        .prepare(
          "SELECT run_id FROM dispatch WHERE status='pending' ORDER BY rowid",
        )
        .all() as { run_id: string }[];
      for (const { run_id } of pending) {
        if (this.closing || this.stopped) break;
        let r = this.store.get<Run>("run", run_id);
        if (this.memberControls.has(r.memberId)) continue;
        if (r.status !== "queued" || this.room(r.roomId).paused) continue;
        if (
          r.purpose === "peer" &&
          r.peerRequestId &&
          this.store.get<PeerRequest>("peer", r.peerRequestId).status !==
            "pending"
        ) {
          this.store.transaction(() => {
            r.status = "cancelled";
            this.saveRun(r);
            this.store.db
              .prepare("UPDATE dispatch SET status='done' WHERE run_id=?")
              .run(r.id);
          });
          continue;
        }
        if (this.store.activeRuns(r.sessionId).length > 0) continue;
        const adapter = this.adapters.get(r.adapterId);
        if (!adapter) continue;
        const task = r.taskId ? this.task(r.taskId) : undefined;
        if (task && this.taskHolds.has(task.id)) continue;
        if (task) {
          if (
            task.cancelRequested ||
            ["completed", "cancelled", "failed"].includes(task.status)
          ) {
            this.store.transaction(() => this.cancelQueued(task.id));
            continue;
          }
          if (task.runCount >= task.maxRuns) {
            if (task.waitReason !== "budget_exceeded")
              this.store.transaction(() => {
                task.status = "waiting";
                task.waitReason = "budget_exceeded";
                this.saveTask(task);
              });
            continue;
          }
        }
        this.store.transaction(() => {
          if (adapter.capabilities.resume && !r.nativeRef)
            r.nativeRef = this.store
              .list<{ id: string; nativeRef?: string }>("session", r.roomId)
              .find((s) => s.id === r.sessionId)?.nativeRef;
          r.status = "starting";
          if (task) {
            r.requirementsVersion = task.requirementsVersion;
            r.ownershipVersion = task.ownershipVersion;
            r.contextManifest = {
              goal: task.goal,
              criteria: [...task.criteria],
              requirementsVersion: task.requirementsVersion,
              ownershipVersion: task.ownershipVersion,
              triggerInput: r.input,
            };
            task.runCount++;
            if (r.purpose === "task") {
              task.artifactId = undefined;
              task.status = "running";
              task.waitReason = undefined;
            }
            this.saveTask(task);
          }
          this.saveRun(r);
          this.store.db
            .prepare("UPDATE dispatch SET status='claimed' WHERE run_id=?")
            .run(r.id);
        });
        const runId = r.id;
        // Submission is detached so cancellation and other sessions are never blocked by provider latency.
        void Promise.resolve()
          .then(() => {
            check(
              !this.stopped && !this.closing,
              "CLOSED",
              "Core is shutting down",
            );
            return adapter.start(
              r,
              (e) => this.ingest(runId, e),
              this.tools(runId),
            );
          })
          .then((result) => {
            if (this.stopped || this.store.isArchived(runId)) return;
            this.store.transaction(() => {
              const latest = this.store.get<Run>("run", runId);
              if (result.nativeRef) latest.nativeRef = result.nativeRef;
              if (latest.status === "starting") latest.status = "running";
              this.saveRun(latest);
            });
          })
          .catch(() => {
            if (this.stopped || this.store.isArchived(runId)) return;
            this.store.transaction(() => {
              const latest = this.store.get<Run>("run", runId);
              if (!terminal(latest)) {
                latest.status = "unknown";
                this.saveRun(latest);
                if (latest.taskId) {
                  const t = this.task(latest.taskId);
                  t.status = "waiting";
                  t.waitReason = "submission_unknown";
                  this.saveTask(t);
                }
              }
            });
          });
      }
    } finally {
      this.pumping = false;
    }
  }
  private tools(runId: string): RunTools {
    return {
      listMembers: () => {
        const r = this.toolRun(runId);
        return this.store
          .list<Member>("member", r.roomId)
          .map((m) => ({ id: m.id, name: m.name }));
      },
      requestPermission: (title, options) => {
        const r = this.store.get<Run>("run", runId);
        check(active(r), "FORBIDDEN", "Run is not active");
        check(
          options.length > 0 &&
            options.length <= 50 &&
            new Set(options.map((o) => o.id)).size === options.length,
          "VALIDATION",
          "Invalid permission options",
        );
        const id = randomUUID();
        this.store.put(
          "interaction",
          {
            id,
            roomId: r.roomId,
            runId,
            title,
            options,
            status: "pending",
            expiresAt: Date.now() + 300_000,
          },
          r.roomId,
        );
        this.store.event(r.roomId, "interaction.requested", {
          id,
          runId,
          title,
          options,
        });
        return new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => {
            if (this.permissions.has(id)) this.answerPermission(id, null);
          }, 300_000);
          timer.unref();
          this.permissions.set(id, { resolve, timer });
        });
      },
      requestPeer: (recipient, question, timeout) =>
        this.requestPeer(runId, recipient, question, timeout),
      replyPeer: (request, text) => this.replyPeer(runId, request, text),
    };
  }
  private toolRun(runId: string, requiresPeerTools = true) {
    const r = this.store.get<Run>("run", runId);
    check(
      active(r) && r.status !== "unknown",
      "FORBIDDEN",
      "Run tool scope expired",
    );
    check(
      !requiresPeerTools ||
        this.adapters.get(r.adapterId)?.capabilities.peerMessaging,
      "CAPABILITY_UNSUPPORTED",
      "No peer tools",
    );
    return r;
  }
  requestPeer(
    runId: string,
    recipientId: string,
    question: string,
    timeoutMs = 60_000,
  ): string {
    check(
      typeof question === "string" &&
        question.length > 0 &&
        question.length <= 100_000,
      "VALIDATION",
      "Invalid peer question",
    );
    check(
      Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3_600_000,
      "VALIDATION",
      "Invalid deadline",
    );
    return this.store.transaction(() => {
      const r = this.toolRun(runId);
      check(r.taskId, "VALIDATION", "Peer request needs task");
      const t = this.task(r.taskId);
      check(
        !t.cancelRequested &&
          r.attempt === t.attempt &&
          r.memberId === t.ownerId &&
          r.ownershipVersion === t.ownershipVersion,
        "FORBIDDEN",
        "Only current owner may request a peer",
      );
      const recipient = this.member(recipientId, r.roomId);
      check(recipient.id !== r.memberId, "CONFLICT", "Self waiting cycle");
      check(
        !this.store
          .peersForTask(t.id)
          .some((q) => q.taskId === t.id && q.status === "pending"),
        "CONFLICT",
        "Task already waits for a peer",
      );
      check(t.runCount < t.maxRuns, "BUDGET_EXCEEDED", "Task budget exhausted");
      const q: PeerRequest = {
        id: randomUUID(),
        roomId: r.roomId,
        taskId: t.id,
        sourceRunId: r.id,
        senderId: r.memberId,
        recipientId,
        question,
        status: "pending",
        deadline: Date.now() + timeoutMs,
        resumed: false,
      };
      this.store.put("peer", q, q.roomId);
      this.store.event(q.roomId, "peer.requested", q);
      this.message(q.roomId, r.memberId, question, [recipientId], t.id, q.id);
      t.status = "waiting";
      t.waitReason = "peer";
      this.saveTask(t);
      this.enqueue(recipient, question, t, "peer", q.id);
      return q.id;
    });
  }
  replyPeer(runId: string, requestId: string, text: string): void {
    check(
      typeof text === "string" && text.length > 0 && text.length <= 100_000,
      "VALIDATION",
      "Invalid reply",
    );
    this.store.transaction(() => {
      const r = this.toolRun(runId, false);
      const q = this.store.get<PeerRequest>("peer", requestId);
      check(
        q.roomId === r.roomId &&
          q.recipientId === r.memberId &&
          r.peerRequestId === q.id,
        "FORBIDDEN",
        "Wrong peer reply scope",
      );
      if (q.reply !== undefined) {
        check(q.reply === text, "CONFLICT", "Reply already exists");
        return;
      }
      this.message(q.roomId, r.memberId, text, [q.senderId], q.taskId, q.id);
      q.reply = text;
      if (q.status === "pending")
        q.status = Date.now() > q.deadline ? "expired" : "replied";
      this.store.put("peer", q, q.roomId);
      this.store.event(q.roomId, "peer.replied", q);
      this.resumePeer(q);
    });
  }
  private resumePeer(q: PeerRequest) {
    if (q.status !== "replied" || q.resumed) return;
    const source = this.store.get<Run>("run", q.sourceRunId);
    if (source.status !== "succeeded") return;
    const t = this.task(q.taskId);
    if (
      t.cancelRequested ||
      source.attempt !== t.attempt ||
      source.ownershipVersion !== t.ownershipVersion ||
      ["failed", "completed", "cancelled"].includes(t.status)
    )
      return;
    q.resumed = true;
    this.store.put("peer", q, q.roomId);
    this.enqueue(
      this.member(q.senderId, q.roomId),
      "Peer reply: " + q.reply,
      t,
    );
    t.status = "queued";
    t.waitReason = undefined;
    this.saveTask(t);
  }
  expirePeers() {
    if (this.stopped || this.closing) return;
    this.store.transaction(() => {
      for (const q of this.store.expiredPeers(Date.now()))
        if (q.status === "pending" && q.deadline <= Date.now()) {
          q.status = "expired";
          this.store.put("peer", q, q.roomId);
          this.store.event(q.roomId, "peer.expired", q);
          const t = this.task(q.taskId);
          if (!t.cancelRequested) {
            t.status = "waiting";
            t.waitReason = "peer_timeout";
            this.saveTask(t);
          }
        }
    });
  }
  ingest(runId: string, event: AdapterEvent) {
    if (this.stopped || this.store.isArchived(runId)) return;
    const schema = z.discriminatedUnion("type", [
      z
        .object({
          id: z.string().min(1).max(200),
          type: z.literal("session"),
          nativeRef: z.string().min(1).max(500),
        })
        .strict(),
      z
        .object({
          id: z.string().min(1).max(200),
          type: z.literal("output"),
          text: z.string().max(100_000),
        })
        .strict(),
      z
        .object({
          id: z.string().min(1).max(200),
          type: z.literal("result"),
          content: z.string().min(1).max(1_000_000),
        })
        .strict(),
      z
        .object({
          id: z.string().min(1).max(200),
          type: z.literal("state"),
          state: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
          reason: z.string().max(1000).optional(),
        })
        .strict(),
    ]);
    const e = schema.parse(event);
    this.store.transaction(() => {
      if (
        this.store.db
          .prepare("INSERT OR IGNORE INTO adapter_events VALUES (?,?)")
          .run(runId, e.id).changes === 0
      )
        return;
      const r = this.store.get<Run>("run", runId);
      this.store.event(r.roomId, "adapter." + e.type, {
        runId,
        event: e,
        simulated: this.adapters.get(r.adapterId)?.simulated ?? false,
      });
      if (terminal(r)) return;
      if (e.type === "session") {
        r.nativeRef = e.nativeRef;
        this.saveRun(r);
        return;
      }
      if (e.type === "output") {
        this.message(r.roomId, r.memberId, e.text, [], r.taskId);
        return;
      }
      if (e.type === "result" && r.taskId) {
        const t = this.task(r.taskId);
        const a: Artifact = {
          id: randomUUID(),
          roomId: r.roomId,
          taskId: t.id,
          runId,
          content: e.content,
          digest: createHash("sha256").update(e.content).digest("hex"),
          requirementsVersion: r.requirementsVersion,
          simulated: this.adapters.get(r.adapterId)?.simulated ?? false,
          verification: "unverified",
        };
        this.store.put("artifact", a, a.roomId);
        this.store.event(a.roomId, "artifact.created", a);
        if (
          r.purpose === "task" &&
          !t.cancelRequested &&
          r.attempt === t.attempt &&
          r.memberId === t.ownerId &&
          r.ownershipVersion === t.ownershipVersion &&
          r.requirementsVersion === t.requirementsVersion
        ) {
          t.artifactId = a.id;
          this.saveTask(t);
        }
        return;
      }
      if (e.type === "state") {
        for (const interaction of this.store.list<{
          id: string;
          runId: string;
          status: string;
        }>("interaction"))
          if (
            interaction.runId === r.id &&
            interaction.status === "pending" &&
            this.permissions.has(interaction.id)
          )
            this.answerPermission(interaction.id, null);
        if (e.state === "unknown") {
          r.status = "unknown";
          this.saveRun(r);
          if (r.taskId) {
            const task = this.task(r.taskId);
            task.status = "waiting";
            task.waitReason = "state_unknown";
            this.saveTask(task);
          }
          return;
        }
        r.status = e.state;
        this.saveRun(r);
        this.store.db
          .prepare("UPDATE dispatch SET status='done' WHERE run_id=?")
          .run(r.id);
        if (r.taskId) {
          const t = this.task(r.taskId);
          if (t.cancelRequested) {
            if (!this.runs(t.id).some(active)) {
              t.status = "cancelled";
              t.waitReason = undefined;
              this.saveTask(t);
            }
          } else if (r.purpose === "peer" && e.state !== "succeeded") {
            const q = r.peerRequestId
              ? this.store.get<PeerRequest>("peer", r.peerRequestId)
              : undefined;
            if (q && q.status === "pending") {
              q.status = "expired";
              this.store.put("peer", q, q.roomId);
              t.status = "waiting";
              t.waitReason = "peer_failed";
              this.saveTask(t);
            }
          } else if (currentOwnerRun(t, r)) {
            const requests = this.store.peersForSource(r.id);
            if (e.state !== "succeeded") {
              t.status = "failed";
              t.waitReason = e.reason ?? e.state;
              this.cancelQueued(t.id);
              this.saveTask(t);
            } else if (requests.length) {
              for (const q of requests) this.resumePeer(q);
            } else if (
              t.artifactId &&
              r.requirementsVersion === t.requirementsVersion
            ) {
              t.status = "review";
              t.waitReason = undefined;
              this.saveTask(t);
            } else if (r.requirementsVersion !== t.requirementsVersion) {
              t.status = "queued";
              this.enqueue(this.member(t.ownerId, t.roomId), t.goal, t);
              this.saveTask(t);
            } else {
              t.status = "waiting";
              t.waitReason = "result_required";
              this.saveTask(t);
            }
          }
        }
      }
    });
    void this.pump();
  }
  async reconcile(runId: string) {
    const r = this.store.get<Run>("run", runId);
    check(r.status === "unknown", "CONFLICT", "Run is not unknown");
    const adapter = this.adapters.get(r.adapterId);
    check(adapter, "CAPABILITY_UNSUPPORTED", "Adapter unavailable");
    const state = await adapter.query(r);
    if (state !== "unknown")
      this.ingest(runId, { id: randomUUID(), type: "state", state });
    return state;
  }
  async close() {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }
  private async closeOnce() {
    if (this.stopped) return;
    this.closing = true;
    clearInterval(this.timer);
    clearInterval(this.healthTimer);
    // Disposal only releases adapter resources; it does not claim remote cancellation.
    for (const id of [...this.permissions.keys()])
      this.answerPermission(id, null);
    await Promise.allSettled(
      [...this.adapters.values()].map((a) =>
        Promise.resolve().then(() => a.dispose?.()),
      ),
    );
    this.store.transaction(() => {
      for (const r of this.store.activeRuns())
        if (active(r)) {
          r.status = "unknown";
          this.saveRun(r);
          if (r.taskId) {
            const t = this.task(r.taskId);
            t.status = "waiting";
            t.waitReason = "state_unknown";
            this.saveTask(t);
          }
        }
    });
    this.stopped = true;
    this.store.close();
  }
}
