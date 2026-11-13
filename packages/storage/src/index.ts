import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CoreError,
  type StoredEvent,
  type Run,
  type PeerRequest,
} from "../../contracts/src/index.js";
export type Kind =
  | "room"
  | "member"
  | "message"
  | "task"
  | "run"
  | "peer"
  | "artifact"
  | "acceptance"
  | "workspace"
  | "evidence"
  | "interaction"
  | "connection"
  | "session";
export class Store {
  private unlock = () => {};
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    if (path !== ":memory:") {
      const lock = path + ".lock";
      const token = randomUUID();
      const acquire = () =>
        writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), {
          flag: "wx",
        });
      try {
        acquire();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner: { pid: number; token: string };
        try {
          owner = JSON.parse(readFileSync(lock, "utf8"));
        } catch {
          throw new CoreError("DATABASE_LOCKED", "Database lock is unreadable");
        }
        let dead = false;
        try {
          process.kill(owner.pid, 0);
        } catch (e) {
          dead = (e as NodeJS.ErrnoException).code === "ESRCH";
        }
        if (!dead)
          throw new CoreError(
            "DATABASE_LOCKED",
            "Another Core owns this database",
          );
        const reclaim = lock + ".reclaim";
        try {
          writeFileSync(reclaim, token, { flag: "wx" });
        } catch {
          throw new CoreError(
            "DATABASE_LOCKED",
            "Database recovery is already in progress",
          );
        }
        try {
          const current = JSON.parse(readFileSync(lock, "utf8"));
          if (current.token !== owner.token)
            throw new CoreError(
              "DATABASE_LOCKED",
              "Database owner changed during recovery",
            );
          unlinkSync(lock);
          acquire();
        } finally {
          unlinkSync(reclaim);
        }
      }
      this.unlock = () => {
        try {
          if (JSON.parse(readFileSync(lock, "utf8")).token === token)
            unlinkSync(lock);
        } catch {}
      };
    }
    try {
      this.db = new Database(path);
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.pragma("busy_timeout = 3000");
      const version = this.db.pragma("user_version", {
        simple: true,
      }) as number;
      if (version > 1) {
        this.db.close();
        throw new CoreError(
          "SCHEMA_TOO_NEW",
          "Database schema is newer than this application",
        );
      }
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, kind TEXT NOT NULL, room_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX IF NOT EXISTS objects_scope ON objects(kind, room_id);
        CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(room_id, sequence));
        CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS dispatch (run_id TEXT PRIMARY KEY REFERENCES objects(id), status TEXT NOT NULL CHECK(status IN ('pending','claimed','done')));
        CREATE TABLE IF NOT EXISTS adapter_events (run_id TEXT NOT NULL REFERENCES objects(id), source_id TEXT NOT NULL, PRIMARY KEY(run_id,source_id));
        CREATE INDEX IF NOT EXISTS objects_active_runs ON objects(json_extract(data, '$.sessionId'))
          WHERE kind='run' AND json_extract(data, '$.status') IN ('starting','running','unknown');
        CREATE INDEX IF NOT EXISTS objects_run_task ON objects(json_extract(data, '$.taskId')) WHERE kind='run';
        CREATE INDEX IF NOT EXISTS objects_peer_task ON objects(json_extract(data, '$.taskId')) WHERE kind='peer';
        CREATE INDEX IF NOT EXISTS objects_peer_source ON objects(json_extract(data, '$.sourceRunId')) WHERE kind='peer';
        CREATE INDEX IF NOT EXISTS objects_pending_peer_deadline ON objects(json_extract(data, '$.deadline'))
          WHERE kind='peer' AND json_extract(data, '$.status')='pending';
        CREATE INDEX IF NOT EXISTS dispatch_pending ON dispatch(status) WHERE status='pending';
        PRAGMA user_version = 1;
      `);
      })();
    } catch (error) {
      this.unlock();
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  private selectObjects<T>(sql: string, ...params: (string | number)[]): T[] {
    return (this.db.prepare(sql).all(...params) as { data: string }[]).map(
      (row) => JSON.parse(row.data) as T,
    );
  }
  activeRuns(sessionId?: string): Run[] {
    const base =
      "SELECT data FROM objects INDEXED BY objects_active_runs WHERE kind='run' AND json_extract(data, '$.status') IN ('starting','running','unknown')";
    return sessionId === undefined
      ? this.selectObjects<Run>(base + " ORDER BY rowid")
      : this.selectObjects<Run>(
          base + " AND json_extract(data, '$.sessionId')=? ORDER BY rowid",
          sessionId,
        );
  }
  runsForTask(taskId: string): Run[] {
    return this.selectObjects<Run>(
      "SELECT data FROM objects WHERE kind='run' AND json_extract(data, '$.taskId')=? ORDER BY rowid",
      taskId,
    );
  }
  peersForTask(taskId: string): PeerRequest[] {
    return this.selectObjects<PeerRequest>(
      "SELECT data FROM objects WHERE kind='peer' AND json_extract(data, '$.taskId')=? ORDER BY rowid",
      taskId,
    );
  }
  peersForSource(sourceRunId: string): PeerRequest[] {
    return this.selectObjects<PeerRequest>(
      "SELECT data FROM objects WHERE kind='peer' AND json_extract(data, '$.sourceRunId')=? ORDER BY rowid",
      sourceRunId,
    );
  }
  expiredPeers(now: number): PeerRequest[] {
    return this.selectObjects<PeerRequest>(
      "SELECT data FROM objects INDEXED BY objects_pending_peer_deadline WHERE kind='peer' AND json_extract(data, '$.status')='pending' AND json_extract(data, '$.deadline')<=? ORDER BY rowid",
      now,
    );
  }
  put<T extends { id: string }>(kind: Kind, value: T, roomId: string): T {
    this.db
      .prepare(
        "INSERT INTO objects VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(value.id, kind, roomId, JSON.stringify(value));
    return value;
  }
  get<T>(kind: Kind, id: string): T {
    const row = this.db
      .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    if (!row) throw new CoreError("NOT_FOUND", `${kind} not found`);
    return JSON.parse(row.data) as T;
  }
  list<T>(kind: Kind, roomId?: string): T[] {
    const rows = (
      roomId === undefined
        ? this.db
            .prepare("SELECT data FROM objects WHERE kind=? ORDER BY rowid")
            .all(kind)
        : this.db
            .prepare(
              "SELECT data FROM objects WHERE kind=? AND room_id=? ORDER BY rowid",
            )
            .all(kind, roomId)
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }
  event(roomId: string, type: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO events SELECT ?,?,COALESCE(MAX(sequence),0)+1,?,?,? FROM events WHERE room_id=?`,
      )
      .run(
        randomUUID(),
        roomId,
        type,
        new Date().toISOString(),
        JSON.stringify(payload),
        roomId,
      );
  }
  events(roomId: string, after = 0, limit = 100): StoredEvent[] {
    const first = (
      this.db
        .prepare("SELECT MIN(sequence) AS n FROM events WHERE room_id=?")
        .get(roomId) as { n: number | null }
    ).n;
    if (first !== null && after < first - 1)
      throw new CoreError(
        "CURSOR_EXPIRED",
        "History was pruned; load a snapshot before subscribing",
      );
    return (
      this.db
        .prepare(
          "SELECT event_id as eventId,room_id as roomId,sequence,type,at,payload FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(roomId, after, limit) as (Omit<StoredEvent, "payload"> & {
        payload: string;
      })[]
    ).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
  }
  watermark(roomId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE room_id=?",
        )
        .get(roomId) as { n: number }
    ).n;
  }
  close() {
    this.db.close();
    this.unlock();
  }
}
