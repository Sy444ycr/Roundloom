import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Core } from "../packages/core/src/index.js";
import { AcpAdapter } from "../packages/adapters/src/acp.js";
import type { Room, Member, Run } from "../packages/contracts/src/index.js";
const [executable, ...args] = process.argv.slice(2);
if (!executable) throw new Error("Provide ACP executable and arguments");
const dir = mkdtempSync(join(tmpdir(), "roundloom-live-"));
const c = new Core(":memory:", [new AcpAdapter()]);
const call = <T>(operation: string, payload: unknown) =>
  c.execute({
    protocolVersion: 1,
    requestId: randomUUID(),
    operation,
    payload,
  }) as T;
try {
  c.start();
  const room = call<Room>("rooms.create", { name: "Isolated ACP smoke test" });
  const member = call<Member>("members.add", {
    roomId: room.id,
    name: "Installed ACP agent",
    adapterId: "acp",
    config: { executable, args, cwd: dir },
  });
  await c.connectMember(member.id);
  console.log(JSON.stringify({ stage: "handshake", ok: true }));
  call("messages.send", {
    roomId: room.id,
    recipients: [member.id],
    text: "Reply with exactly ROUNDLOOM_OK. Do not use tools, inspect files, execute commands or modify anything.",
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const i of c.store.list<any>("interaction"))
      if (i.status === "pending") c.answerPermission(i.id, null);
    const [r] = c.store.list<Run>("run");
    if (
      r &&
      ["succeeded", "failed", "cancelled", "unknown"].includes(r.status)
    ) {
      const messages = c.store
        .list<any>("message", room.id)
        .filter((m) => m.senderId === member.id);
      console.log(
        JSON.stringify({
          stage: "prompt",
          status: r.status,
          receivedExpectedReply: messages.some((m) =>
            m.text.includes("ROUNDLOOM_OK"),
          ),
          runs: 1,
        }),
      );
      process.exitCode = r.status === "succeeded" ? 0 : 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (
    !process.exitCode &&
    c.store
      .list<Run>("run")
      .some((r) => ["running", "starting"].includes(r.status))
  ) {
    console.log(JSON.stringify({ stage: "prompt", status: "timeout" }));
    process.exitCode = 1;
  }
} catch {
  console.log(
    JSON.stringify({ stage: "connection-or-prompt", status: "failed" }),
  );
  process.exitCode = 1;
} finally {
  await c.close();
  rmSync(dir, { recursive: true, force: true });
}
