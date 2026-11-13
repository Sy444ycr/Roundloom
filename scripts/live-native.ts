import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Core } from "../packages/core/src/index.js";
import { NativeAdapter } from "../packages/adapters/src/native.js";
import { AcpAdapter } from "../packages/adapters/src/acp.js";
import type { Room, Member, Run } from "../packages/contracts/src/index.js";
const [id, executable, ...args] = process.argv.slice(2);
if (id !== "claude" && id !== "codex" && id !== "acp")
  throw new Error(
    "Usage: live-native.js claude|codex|acp [executable] [ACP arguments]",
  );
const dir = mkdtempSync(join(tmpdir(), "roundloom-live-native-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace);
const make = () =>
  new Core(join(dir, "core.db"), [
    id === "acp" ? new AcpAdapter() : new NativeAdapter(id),
  ]);
let c = make();
const call = <T>(operation: string, payload: unknown) =>
  c.execute({
    protocolVersion: 1,
    requestId: randomUUID(),
    operation,
    payload,
  }) as T;
try {
  const room = call<Room>("rooms.create", { name: "Native smoke" });
  const member = call<Member>("members.add", {
    roomId: room.id,
    name: id,
    adapterId: id,
    config: { cwd: workspace, executable, ...(id === "acp" ? { args } : {}) },
  });
  const secret = randomUUID();
  for (let turn = 1; turn <= 2; turn++) {
    if (turn === 2) {
      await c.close();
      c = make();
    }
    const previous = new Set(c.store.list<Run>("run").map((r) => r.id));
    const previousMessages = new Set(
      c.store.list<{ id: string }>("message", room.id).map((m) => m.id),
    );
    call("messages.send", {
      roomId: room.id,
      recipients: [member.id],
      text:
        turn === 1
          ? `Remember this marker for our next turn: ${secret}. Reply only ROUNDLOOM_OK. Do not use tools or access files.`
          : "Return only the marker I asked you to remember in our previous turn. Do not use tools or access files.",
    });
    c.start();
    const deadline = Date.now() + 60000;
    let ok = false;
    while (Date.now() < deadline) {
      for (const i of c.store.list<any>("interaction"))
        if (i.status === "pending") c.answerPermission(i.id, null);
      const r = c.store.list<Run>("run").find((r) => !previous.has(r.id));
      if (
        r &&
        ["succeeded", "failed", "cancelled", "unknown"].includes(r.status)
      ) {
        const expected = turn === 1 ? "ROUNDLOOM_OK" : secret;
        const response = c.store
          .list<any>("message", room.id)
          .filter(
            (m) => m.senderId === member.id && !previousMessages.has(m.id),
          )
          .map((m) => m.text)
          .join("");
        ok = r.status === "succeeded" && response.includes(expected);
        console.log(
          JSON.stringify({
            adapter: id,
            turn,
            status: r.status,
            expectedReply: ok,
            sessionPersisted: !!r.nativeRef,
          }),
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ok) {
      process.exitCode = 1;
      console.log(JSON.stringify({ adapter: id, turn, verified: false }));
      break;
    }
  }
} finally {
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
      JSON.stringify({
        stage: "cleanup",
        status: "directory-retained",
        directory: dir,
      }),
    );
    process.exitCode = 1;
  }
}
