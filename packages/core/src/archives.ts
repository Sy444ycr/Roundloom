import { randomUUID } from "node:crypto";
import { Store } from "../../storage/src/index.js";
import { requireThat as check, type Task } from "../../contracts/src/index.js";

type Row = { id: string; kind: string; room_id: string; data: string };
type Metadata = {
  dispatch: { run_id: string; status: string }[];
  adapterEvents: { run_id: string; source_id: string }[];
};
export class Archives {
  constructor(private store: Store) {}
  list(roomId: string, limit: number, offset: number) {
    this.store.get("room", roomId);
    return this.store.db
      .prepare(
        "SELECT id,task_id AS taskId,room_id AS roomId,archived_at AS archivedAt FROM archives WHERE room_id=? ORDER BY archived_at DESC,id LIMIT ? OFFSET ?",
      )
      .all(roomId, limit, offset);
  }
  read(id: string) {
    const archive = this.store.db
      .prepare(
        "SELECT id,task_id AS taskId,room_id AS roomId,archived_at AS archivedAt FROM archives WHERE id=?",
      )
      .get(id) as
      | { id: string; taskId: string; roomId: string; archivedAt: string }
      | undefined;
    check(archive, "NOT_FOUND", "Archive not found");
    const objects = (
      this.store.db
        .prepare(
          "SELECT kind,data FROM archived_objects WHERE archive_id=? ORDER BY rowid",
        )
        .all(id) as Row[]
    ).map((row) => ({ kind: row.kind, value: JSON.parse(row.data) }));
    return { ...archive, objects, externalFilesIncluded: false };
  }
  create(taskId: string, expectedVersion: number) {
    return this.store.transaction(() => {
      check(
        !this.store.isArchived(taskId),
        "ARCHIVED",
        "Task is already archived",
      );
      const task = this.store.get<Task>("task", taskId);
      check(
        task.version === expectedVersion,
        "CONFLICT",
        "Task version changed",
      );
      check(
        ["completed", "cancelled", "failed"].includes(task.status),
        "CONFLICT",
        "Only terminal tasks can be archived",
      );
      check(
        this.store
          .runsForTask(taskId)
          .every((r) =>
            ["succeeded", "failed", "cancelled"].includes(r.status),
          ),
        "CONFLICT",
        "Task has unfinished runs",
      );
      const rows = this.store.db
        .prepare(
          `SELECT id,kind,room_id,data FROM objects WHERE room_id=@room AND
        (id=@task OR json_extract(data,'$.taskId')=@task OR
        (kind='interaction' AND json_extract(data,'$.runId') IN
          (SELECT id FROM objects WHERE kind='run' AND json_extract(data,'$.taskId')=@task))) ORDER BY rowid`,
        )
        .all({ room: task.roomId, task: taskId }) as Row[];
      check(
        rows.length <= 50000 &&
          rows.reduce((sum, r) => sum + Buffer.byteLength(r.data), 0) <=
            100_000_000,
        "LIMIT_EXCEEDED",
        "Archive exceeds transaction size limit",
      );
      for (const row of rows) {
        const value = JSON.parse(row.data);
        check(
          !(row.kind === "peer" && value.status === "pending") &&
            !(row.kind === "evidence" && value.status === "running") &&
            !(row.kind === "interaction" && value.status === "pending"),
          "CONFLICT",
          "Task has pending work",
        );
      }
      const runIds = rows.filter((r) => r.kind === "run").map((r) => r.id);
      const metadata: Metadata = { dispatch: [], adapterEvents: [] };
      const id = randomUUID(),
        archivedAt = new Date().toISOString();
      for (const run of runIds) {
        metadata.dispatch.push(
          ...(this.store.db
            .prepare("SELECT * FROM dispatch WHERE run_id=?")
            .all(run) as Metadata["dispatch"]),
        );
        metadata.adapterEvents.push(
          ...(this.store.db
            .prepare("SELECT * FROM adapter_events WHERE run_id=?")
            .all(run) as Metadata["adapterEvents"]),
        );
      }
      check(
        metadata.dispatch.every((r) => r.status === "done"),
        "CONFLICT",
        "Dispatch is not settled",
      );
      check(
        Buffer.byteLength(JSON.stringify(metadata)) <= 100_000_000,
        "LIMIT_EXCEEDED",
        "Archive metadata exceeds transaction size limit",
      );
      this.store.db
        .prepare("INSERT INTO archives VALUES (?,?,?,?,?)")
        .run(id, taskId, task.roomId, archivedAt, JSON.stringify(metadata));
      for (const row of rows)
        this.store.db
          .prepare("INSERT INTO archived_objects VALUES (?,?,?,?,?)")
          .run(row.id, id, row.kind, row.room_id, row.data);
      for (const run of runIds) {
        this.store.db.prepare("DELETE FROM dispatch WHERE run_id=?").run(run);
        this.store.db
          .prepare("DELETE FROM adapter_events WHERE run_id=?")
          .run(run);
      }
      for (const row of rows)
        this.store.db.prepare("DELETE FROM objects WHERE id=?").run(row.id);
      const result = {
        id,
        taskId,
        roomId: task.roomId,
        archivedAt,
        objectCount: rows.length,
      };
      this.store.event(task.roomId, "history.archived", result);
      return result;
    });
  }
  restore(id: string) {
    return this.store.transaction(() => {
      const archive = this.read(id);
      const metadata = JSON.parse(
        (
          this.store.db
            .prepare("SELECT metadata FROM archives WHERE id=?")
            .get(id) as { metadata: string }
        ).metadata,
      ) as Metadata;
      // A plain INSERT fails on any collision; the whole restore rolls back.
      this.store.db
        .prepare(
          "INSERT INTO objects SELECT id,kind,room_id,data FROM archived_objects WHERE archive_id=? ORDER BY rowid",
        )
        .run(id);
      for (const r of metadata.dispatch)
        this.store.db
          .prepare("INSERT INTO dispatch VALUES (?,?)")
          .run(r.run_id, r.status);
      for (const e of metadata.adapterEvents)
        this.store.db
          .prepare("INSERT INTO adapter_events VALUES (?,?)")
          .run(e.run_id, e.source_id);
      this.store.db
        .prepare("DELETE FROM archived_objects WHERE archive_id=?")
        .run(id);
      this.store.db.prepare("DELETE FROM archives WHERE id=?").run(id);
      const result = { taskId: archive.taskId, restored: true };
      this.store.event(archive.roomId, "history.restored", result);
      return result;
    });
  }
}
