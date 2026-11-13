import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Core } from "../packages/core/src/index.js";
import { NativeAdapter } from "../packages/adapters/src/native.js";
import type { Room, Member, Run } from "../packages/contracts/src/index.js";
const [id, executable] = process.argv.slice(2);
if (id !== "claude" && id !== "codex")
  throw new Error("Usage: live-native.js claude|codex [executable]");
const dir = mkdtempSync(join(tmpdir(), "roundloom-live-native-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace);
const make = () => new Core(join(dir, "core.db"), [new NativeAdapter(id)]);
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
    config: { cwd: workspace, executable },
  });
  const secret = randomUUID();
  for (let turn = 1; turn <= 2; turn++) {
    if (turn === 2) {
      await c.close();
      c = make();
    }
    const previous = new Set(c.store.list<Run>("run").map((r) => r.id));
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
        ok =
          r.status === "succeeded" &&
          c.store
            .list<any>("message", room.id)
            .some((m) => m.senderId === member.id && m.text.includes(expected));
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
