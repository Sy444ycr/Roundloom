import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  realpath,
  stat,
  readdir,
  readFile,
  mkdir,
  writeFile,
  rename,
} from "node:fs/promises";
import { resolve, relative, isAbsolute, join, dirname } from "node:path";
import { Store } from "../../storage/src/index.js";
import {
  CoreError,
  requireThat as check,
  type Task,
  type Run,
} from "../../contracts/src/index.js";
export interface Workspace {
  id: string;
  roomId: string;
  root: string;
  kind: "directory" | "worktree";
  baseRevision?: string;
}
export interface Snapshot {
  digest: string;
  files: { path: string; digest: string; size: number }[];
}
export interface Evidence {
  id: string;
  roomId: string;
  taskId: string;
  workspaceId: string;
  command: string;
  args: string[];
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  status: "running" | "passed" | "failed" | "cancelled" | "unknown" | "stale";
  before: Snapshot;
  after?: Snapshot;
  log: string;
  requirementsVersion: number;
  ownershipVersion: number;
  reason?: string;
}
export async function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 60_000,
): Promise<{ exitCode: number | null; log: string; cancelled: boolean }> {
  if (signal?.aborted) return { exitCode: null, log: "", cancelled: true };
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let log = "",
      cancelled = false,
      finished = false;
    const capture = (chunk: Buffer) => {
      if (log.length < 1_000_000)
        log += chunk.toString().slice(0, 1_000_000 - log.length);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const stop = () => {
      cancelled = true;
      if (child.pid) {
        if (process.platform === "win32")
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).on("error", () => child.kill());
        else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolveResult({ exitCode, log, cancelled });
    };
    child.on("error", () => {
      log += "\nUnable to launch executable";
      finish(null);
    });
    child.on("close", finish);
  });
}
export class Workspaces {
  private running = new Map<string, AbortController>();
  private locked = new Set<string>();
  constructor(private store: Store) {
    for (const e of store.list<Evidence>("evidence"))
      if (e.status === "running") {
        e.status = "unknown";
        e.reason = "Core restarted before command completion";
        store.put("evidence", e, e.roomId);
      }
  }
  async register(roomId: string, path: string) {
    this.store.get("room", roomId);
    const root = await realpath(path);
    check(
      (await stat(root)).isDirectory(),
      "VALIDATION",
      "Workspace must be a directory",
    );
    const existing = this.store
      .list<Workspace>("workspace", roomId)
      .find((w) => w.root === root);
    if (existing) return existing;
    const w: Workspace = { id: randomUUID(), roomId, root, kind: "directory" };
    this.store.transaction(() => {
      this.store.put("workspace", w, roomId);
      this.store.event(roomId, "workspace.registered", w);
    });
    return w;
  }
  async worktree(
    roomId: string,
    repository: string,
    destination: string,
    revision = "HEAD",
  ) {
    check(!revision.startsWith("-"), "VALIDATION", "Invalid revision");
    this.store.get("room", roomId);
    const repo = await realpath(repository);
    const target = resolve(destination);
    const commit = await runCommand(
      "git",
      ["rev-parse", "--verify", revision + "^{commit}"],
      repo,
    );
    check(commit.exitCode === 0, "VALIDATION", "Invalid Git revision");
    const result = await runCommand(
      "git",
      ["worktree", "add", "--detach", target, commit.log.trim()],
      repo,
    );
    check(result.exitCode === 0, "WORKSPACE_ERROR", result.log);
    const w = await this.register(roomId, target);
    w.kind = "worktree";
    w.baseRevision = commit.log.trim();
    this.store.put("workspace", w, roomId);
    return w;
  }
  async path(workspaceId: string, path: string) {
    const w = this.store.get<Workspace>("workspace", workspaceId);
    const full = await realpath(resolve(w.root, path));
    const rel = relative(w.root, full);
    check(
      !isAbsolute(rel) &&
        rel !== ".." &&
        !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")),
      "FORBIDDEN",
      "Path escapes workspace",
    );
    return full;
  }
  async read(workspaceId: string, path: string) {
    const full = await this.path(workspaceId, path);
    check(
      (await stat(full)).size <= 1_000_000,
      "LIMIT_EXCEEDED",
      "File exceeds read limit",
    );
    return { text: await readFile(full, "utf8") };
  }
  async snapshot(workspaceId: string): Promise<Snapshot> {
    const w = this.store.get<Workspace>("workspace", workspaceId);
    const files: Snapshot["files"] = [];
    let bytes = 0;
    const visit = async (dir: string) => {
      for (const e of (await readdir(dir, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if ([".git", "node_modules", ".roundloom"].includes(e.name)) continue;
        const full = join(dir, e.name);
        check(
          !e.isSymbolicLink(),
          "FORBIDDEN",
          "Snapshot contains a symbolic link",
        );
        if (e.isDirectory()) await visit(full);
        else if (e.isFile()) {
          check(
            files.length < 10_000,
            "LIMIT_EXCEEDED",
            "Too many workspace files",
          );
          const info = await stat(full);
          bytes += info.size;
          check(
            bytes <= 100_000_000,
            "LIMIT_EXCEEDED",
            "Workspace snapshot exceeds 100MB",
          );
          const content = await readFile(full);
          files.push({
            path: relative(w.root, full).replaceAll("\\", "/"),
            digest: createHash("sha256").update(content).digest("hex"),
            size: content.length,
          });
        }
      }
    };
    await visit(w.root);
    return {
      digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
      files,
    };
  }
  async write(workspaceId: string, path: string, content: string) {
    const w = this.store.get<Workspace>("workspace", workspaceId);
    const target = resolve(w.root, path);
    const parent = await this.path(
      workspaceId,
      relative(w.root, dirname(target)),
    );
    check(parent !== target, "VALIDATION", "Invalid target");
    try {
      await this.path(workspaceId, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    check(!this.locked.has(w.id), "CONFLICT", "Workspace is being tested");
    const temporary = join(parent, ".roundloom-" + randomUUID());
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, target);
    return this.snapshot(w.id);
  }
  async capture(taskId: string, workspaceId: string, expectedVersion: number) {
    check(
      !this.store.isArchived(taskId),
      "ARCHIVED",
      "Restore task before capturing",
    );
    const task = this.store.get<Task>("task", taskId);
    const w = this.store.get<Workspace>("workspace", workspaceId);
    check(task.roomId === w.roomId, "FORBIDDEN", "Workspace scope mismatch");
    check(
      task.version === expectedVersion &&
        !task.cancelRequested &&
        !["completed", "cancelled", "failed"].includes(task.status),
      "CONFLICT",
      "Task changed or terminal",
    );
    check(
      !this.store
        .list<Run>("run", task.roomId)
        .some(
          (r) =>
            r.taskId === taskId &&
            ["starting", "running", "unknown"].includes(r.status),
        ),
      "CONFLICT",
      "Finish execution before capturing",
    );
    const snapshot = await this.snapshot(workspaceId);
    check(
      this.store.get<Task>("task", taskId).version === expectedVersion,
      "CONFLICT",
      "Task changed during capture",
    );
    const artifact = {
      id: randomUUID(),
      roomId: task.roomId,
      taskId,
      workspaceId,
      kind: "workspace-snapshot",
      digest: snapshot.digest,
      files: snapshot.files,
      requirementsVersion: task.requirementsVersion,
      ownershipVersion: task.ownershipVersion,
      simulated: false,
      verification: "unverified",
    };
    this.store.transaction(() => {
      for (const run of this.store.list<Run>("run", task.roomId))
        if (run.taskId === task.id && run.status === "queued") {
          run.status = "cancelled";
          this.store.put("run", run, run.roomId);
          this.store.event(run.roomId, "run.changed", run);
          this.store.db
            .prepare("UPDATE dispatch SET status='done' WHERE run_id=?")
            .run(run.id);
        }
      this.store.put("artifact", artifact, task.roomId);
      this.store.event(task.roomId, "artifact.created", artifact);
      task.artifactId = artifact.id;
      task.status = "review";
      task.version++;
      this.store.put("task", task, task.roomId);
      this.store.event(task.roomId, "task.changed", task);
    });
    return artifact;
  }
  async inspect(artifactId: string) {
    const a = this.store.get<any>("artifact", artifactId);
    if (!a.workspaceId) return a;
    const snapshot = await this.snapshot(a.workspaceId);
    const task = this.store.get<Task>("task", a.taskId);
    const evidence = this.store
      .historyForTask<Evidence>("evidence", a.taskId)
      .filter(
        (e) =>
          e.taskId === a.taskId &&
          e.workspaceId === a.workspaceId &&
          e.status === "passed" &&
          e.before.digest === a.digest &&
          e.after?.digest === a.digest &&
          e.requirementsVersion === a.requirementsVersion &&
          e.ownershipVersion === a.ownershipVersion,
      );
    const current =
      snapshot.digest === a.digest &&
      task.requirementsVersion === a.requirementsVersion &&
      task.ownershipVersion === a.ownershipVersion;
    return {
      ...a,
      current,
      verification: current && evidence.length ? "verified" : "unverified",
      evidenceIds: evidence.map((e) => e.id),
    };
  }
  async test(
    taskId: string,
    workspaceId: string,
    executable: string,
    args: string[],
    timeoutMs: number,
  ) {
    check(
      !this.store.isArchived(taskId),
      "ARCHIVED",
      "Restore task before testing",
    );
    const t = this.store.get<Task>("task", taskId);
    const w = this.store.get<Workspace>("workspace", workspaceId);
    check(
      w.roomId === t.roomId,
      "FORBIDDEN",
      "Workspace belongs to another room",
    );
    check(!this.locked.has(w.id), "CONFLICT", "Workspace already being tested");
    check(
      !this.store
        .list<Run>("run", t.roomId)
        .some(
          (r) =>
            r.taskId === t.id &&
            ["starting", "running", "unknown"].includes(r.status),
        ),
      "CONFLICT",
      "Finish agent execution before testing",
    );
    this.locked.add(w.id);
    const id = randomUUID();
    const controller = new AbortController();
    this.running.set(id, controller);
    let evidence: Evidence | undefined;
    try {
      evidence = {
        id,
        roomId: t.roomId,
        taskId,
        workspaceId,
        command: executable,
        args,
        startedAt: new Date().toISOString(),
        status: "running",
        before: await this.snapshot(w.id),
        log: "",
        requirementsVersion: t.requirementsVersion,
        ownershipVersion: t.ownershipVersion,
      };
      this.store.put("evidence", evidence, t.roomId);
      this.store.event(t.roomId, "test.started", evidence);
      const result = await runCommand(
        executable,
        args,
        w.root,
        controller.signal,
        timeoutMs,
      );
      evidence = { ...evidence, ...result, endedAt: new Date().toISOString() };
      const after = await this.snapshot(w.id);
      const latest = this.store.get<Task>("task", t.id);
      evidence = {
        ...evidence,
        ...result,
        after,
        endedAt: new Date().toISOString(),
        status: result.cancelled
          ? "cancelled"
          : result.exitCode !== 0
            ? "failed"
            : after.digest !== evidence.before.digest ||
                latest.requirementsVersion !== t.requirementsVersion ||
                latest.ownershipVersion !== t.ownershipVersion
              ? "stale"
              : "passed",
      };
      this.store.put("evidence", evidence, t.roomId);
      this.store.event(t.roomId, "test.finished", evidence);
      return evidence;
    } catch (error) {
      if (evidence) {
        evidence.status = "unknown";
        evidence.reason = "Evidence capture interrupted";
        evidence.endedAt ??= new Date().toISOString();
        const interrupted = evidence;
        this.store.transaction(() => {
          this.store.put("evidence", interrupted, t.roomId);
          this.store.event(t.roomId, "test.finished", interrupted);
        });
      }
      throw error;
    } finally {
      this.running.delete(id);
      this.locked.delete(w.id);
    }
  }
  cancel(id: string) {
    const c = this.running.get(id);
    check(c, "NOT_FOUND", "Test is not running");
    c.abort();
    return { requested: true };
  }
  get busy() {
    return this.running.size > 0;
  }
  dispose() {
    for (const c of this.running.values()) c.abort();
  }
}
