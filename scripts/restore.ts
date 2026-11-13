import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
const [source, target] = process.argv.slice(2);
if (!source || !target)
  throw new Error(
    "Usage: node dist/scripts/restore.js BACKUP NEW_DATABASE_PATH",
  );
const destination = resolve(target);
if (
  existsSync(destination) ||
  existsSync(destination + "-wal") ||
  existsSync(destination + "-shm")
)
  throw new Error(
    "Restore requires a new database path; existing data is never overwritten",
  );
mkdirSync(dirname(destination), { recursive: true });
const db = new Database(resolve(source), {
  readonly: true,
  fileMustExist: true,
});
try {
  if (db.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error("Backup integrity check failed");
  if (db.pragma("user_version", { simple: true }) !== 1)
    throw new Error("Unsupported backup schema");
  await db.backup(destination);
  console.log(
    JSON.stringify({
      restored: destination,
      externalWorkspacesIncluded: false,
    }),
  );
} finally {
  db.close();
}
