import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Core } from "../packages/core/src/index.js";
import { Services } from "../packages/core/src/services.js";
import { NativeAdapter } from "../packages/adapters/src/native.js";
import { AcpAdapter } from "../packages/adapters/src/acp.js";
import type {
  Room,
  Member,
  Task,
  PeerRequest,
  Run,
  Artifact,
} from "../packages/contracts/src/index.js";
const [claude, opencode, mode] = process.argv.slice(2);
const coding = mode === "--coding";
if (!claude || !opencode)
  throw new Error("Provide Claude and OpenCode executable paths");
const dir = mkdtempSync(join(tmpdir(), "roundloom-collaboration-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace);
const c = new Core(join(dir, "core.db"), [
  new NativeAdapter("claude"),
  new AcpAdapter(),
]);
const services = new Services(c, join(dir, "data"));
const service = <T>(operation: string, payload: unknown) =>
  services.execute({
    protocolVersion: 1,
    requestId: randomUUID(),
    operation,
    payload,
  }) as Promise<T>;
const call = <T>(operation: string, payload: unknown) =>
  c.execute({
    protocolVersion: 1,
    requestId: randomUUID(),
    operation,
    payload,
  }) as T;
try {
  const room = call<Room>("rooms.create", { name: "Cross-agent smoke" });
  const peer = call<Member>("members.add", {
    roomId: room.id,
    name: "OpenCode reviewer",
    adapterId: "acp",
    config: { executable: opencode, args: ["--pure", "acp"], cwd: workspace },
  });
  const owner = call<Member>("members.add", {
    roomId: room.id,
    name: "Claude implementer",
    adapterId: "claude",
    config: { executable: claude, cwd: workspace, timeoutMs: 90000 },
  });
  const task = call<Task>("tasks.assign", {
    roomId: room.id,
    ownerId: owner.id,
    goal: `Use mcp__roundloom__peer_request to ask member ${peer.id}: What is 19 + 23? Reply only the number, without tools or file access. After requesting, end your turn. When the platform resumes you with the peer reply, ${coding ? `use Write to create ${join(workspace, "add.mjs")} containing an exported JavaScript function add(a,b) that returns a+b for any numbers, then` : ""} return exactly ROUNDLOOM_COLLAB_42 and do not request another peer. ${coding ? "Only the Write tool for that one file is permitted; no shell commands." : "Do not use other tools or access files."}`,
    criteria: [
      "Peer request and reply recorded; owner resumed with final answer",
    ],
    maxRuns: 4,
  });
  c.start();
  const deadline = Date.now() + 180000;
  let ok = false;
  while (Date.now() < deadline) {
    for (const i of c.store.list<any>("interaction"))
      if (i.status === "pending") {
        let allow = false;
        try {
          const request = JSON.parse(i.title);
          allow =
            coding &&
            request.tool === "Write" &&
            typeof request.input?.file_path === "string" &&
            resolve(workspace, request.input.file_path) ===
              join(workspace, "add.mjs");
        } catch {
          /* Non-native permissions are denied. */
        }
        c.answerPermission(i.id, allow ? "allow" : null);
      }
    const current = c.task(task.id);
    if (["review", "failed", "cancelled"].includes(current.status)) {
      const peers = c.store.list<PeerRequest>("peer");
      const artifact = current.artifactId
        ? c.store.get<Artifact>("artifact", current.artifactId)
        : undefined;
      ok =
        current.status === "review" &&
        peers.length === 1 &&
        peers[0].status === "replied" &&
        peers[0].resumed &&
        artifact?.content.includes("ROUNDLOOM_COLLAB_42") === true;
      console.log(
        JSON.stringify({
          status: current.status,
          peerRequests: peers.length,
          peerReplied: peers[0]?.status === "replied",
          ownerResumed: peers[0]?.resumed,
          runs: c.store.list<Run>("run").map((r) => ({
            adapter: r.adapterId,
            purpose: r.purpose,
            status: r.status,
          })),
          expectedResult: ok,
        }),
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ok) {
    process.exitCode = 1;
    console.log(
      JSON.stringify({ verified: false, taskStatus: c.task(task.id).status }),
    );
  } else if (coding) {
    const w = await service<{ id: string }>("workspaces.register", {
      roomId: room.id,
      path: workspace,
    });
    const evidence = await service<{ status: string }>("tests.execute", {
      taskId: task.id,
      workspaceId: w.id,
      executable: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        "import assert from 'node:assert/strict'; import {add} from './add.mjs'; for(const [a,b] of [[19,23],[-5,2],[0,0],[1.5,2.25],[100,-100]]) assert.equal(add(a,b),a+b);",
      ],
    });
    if (evidence.status !== "passed")
      throw new Error("Generated code failed independent tests");
    const artifact = await service<{ id: string }>("artifacts.capture", {
      taskId: task.id,
      workspaceId: w.id,
      expectedVersion: c.task(task.id).version,
    });
    const inspected = await service<{ verification: string }>(
      "artifacts.inspect",
      { artifactId: artifact.id },
    );
    if (inspected.verification !== "verified")
      throw new Error("File artifact not verified");
    if (c.task(task.id).status !== "review")
      throw new Error("Tests must not automatically accept a task");
    console.log(
      JSON.stringify({
        stage: "coding",
        tests: evidence.status,
        artifact: inspected.verification,
        taskStatus: c.task(task.id).status,
        acceptanceRequired: true,
      }),
    );
    const reportDir = resolve(".roundloom", "live-evidence", randomUUID());
    mkdirSync(reportDir, { recursive: true });
    const backup = await service<{ path: string }>("storage.backup", {});
    copyFileSync(backup.path, join(reportDir, "core.db"));
    copyFileSync(join(workspace, "add.mjs"), join(reportDir, "add.mjs"));
    writeFileSync(
      join(reportDir, "report.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          scenario: "claude-opencode-coding",
          evidence,
          artifact: inspected,
          task: c.task(task.id),
          acceptanceRequired: true,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ stage: "evidence", directory: reportDir }));
  }
} finally {
  await services.close();
  await c.close();
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch {
    console.log(
      JSON.stringify({ cleanup: "directory-retained", directory: dir }),
    );
    process.exitCode = 1;
  }
}
