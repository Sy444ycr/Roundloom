import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
  type ThreadEvent,
} from "@openai/codex-sdk";
import {
  query,
  tool,
  createSdkMcpServer,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  Adapter,
  AdapterEvent,
  RunTools,
} from "../../adapter-sdk/src/index.js";
import { CoreError, type Run } from "../../contracts/src/index.js";
const schema = z
  .object({
    cwd: z.string().min(1),
    executable: z.string().optional(),
    model: z.string().optional(),
    maxTurns: z.number().int().min(1).max(30).default(6),
    maxBudgetUsd: z.number().positive().max(20).default(1),
    sandboxMode: z.enum(["read-only", "workspace-write"]).default("read-only"),
    timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  })
  .strict();
type State = "succeeded" | "failed" | "cancelled" | "unknown";
export interface CodexClient {
  startThread(options: ThreadOptions): {
    runStreamed(
      input: string,
      options: { signal: AbortSignal },
    ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
  };
  resumeThread(
    id: string,
    options: ThreadOptions,
  ): ReturnType<CodexClient["startThread"]>;
}
export type ClaudeQuery = (input: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;
export class NativeAdapter implements Adapter {
  readonly simulated = false;
  readonly capabilities;
  private active = new Map<string, AbortController>();
  private states = new Map<string, State>();
  private sessions = new Map<string, string>();
  private disposed = false;
  private pending = new Set<Promise<void>>();
  constructor(
    readonly id: "codex" | "claude",
    private codexFactory: (options: CodexOptions) => CodexClient = (options) =>
      new Codex(options),
    private claudeQuery: ClaudeQuery = query,
  ) {
    this.capabilities = {
      cancel: true,
      resume: true,
      peerMessaging: id === "claude",
    };
  }
  validateConfig(value: Record<string, unknown>) {
    const c = schema.parse(value);
    c.cwd = realpathSync(c.cwd);
    if (!statSync(c.cwd).isDirectory())
      throw new CoreError("VALIDATION", "cwd must be a directory");
    if (c.executable) {
      c.executable = realpathSync(c.executable);
      if (!statSync(c.executable).isFile())
        throw new CoreError("VALIDATION", "Invalid executable");
    }
    return c;
  }
  async start(run: Run, emit: (e: AdapterEvent) => void, tools: RunTools) {
    if (this.disposed) throw new CoreError("CLOSED", "Adapter disposed");
    const config = this.validateConfig(run.config);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    this.active.set(run.id, controller);
    this.states.set(run.id, "unknown");
    const send = (event: AdapterEvent) => {
      if (!this.disposed) emit(event);
    };
    const session = (nativeRef: string) => {
      if (this.sessions.get(run.sessionId) === nativeRef) return;
      this.sessions.set(run.sessionId, nativeRef);
      send({ id: randomUUID(), type: "session", nativeRef });
    };
    const prior = run.nativeRef || this.sessions.get(run.sessionId);
    const prompt = JSON.stringify({
      input: run.input,
      context: run.contextManifest,
      collaboration:
        run.purpose === "peer"
          ? {
              requestId: run.peerRequestId,
              instruction:
                this.id === "claude"
                  ? "Use peer_reply to answer the request, then end your turn."
                  : "Return your answer as your final response. The platform routes it to the requester.",
            }
          : {
              instruction:
                "Use peer_request only for a necessary question. After requesting a peer, end this turn; the platform resumes you with the reply.",
            },
    });
    const pending = (async () => {
      let outcome: State = "unknown";
      let reason: string | undefined;
      let result = "";
      try {
        if (this.id === "codex") {
          const client = this.codexFactory({
            codexPathOverride: config.executable,
          });
          const options: ThreadOptions = {
            workingDirectory: config.cwd,
            model: config.model,
            sandboxMode: config.sandboxMode,
            approvalPolicy: "never",
            skipGitRepoCheck: true,
            networkAccessEnabled: false,
            webSearchMode: "disabled",
          };
          const thread = prior
            ? client.resumeThread(prior, options)
            : client.startThread(options);
          const { events } = await thread.runStreamed(prompt, {
            signal: controller.signal,
          });
          for await (const event of events) {
            if (event.type === "thread.started") session(event.thread_id);
            if (
              event.type === "item.completed" &&
              event.item.type === "agent_message"
            ) {
              result = event.item.text;
              send({ id: randomUUID(), type: "output", text: result });
            }
            if (event.type === "turn.completed") {
              outcome = "succeeded";
              break;
            }
            if (event.type === "error" || event.type === "turn.failed") {
              const message =
                event.type === "error" ? event.message : event.error.message;
              reason =
                /10054|connection|connect|stream disconnected|ECONN|fetch failed/i.test(
                  message,
                )
                  ? "provider_connection_failed"
                  : "provider_error";
            }
            if (event.type === "turn.failed") {
              outcome = "failed";
              break;
            }
          }
        } else {
          const response = (value: unknown) => ({
            content: [{ type: "text" as const, text: JSON.stringify(value) }],
          });
          const server = createSdkMcpServer({
            name: "roundloom",
            version: "1.0.0",
            tools: [
              tool(
                "members",
                "List members available in this project room.",
                {},
                async () => response(tools.listMembers()),
              ),
              tool(
                "peer_request",
                "Ask another project member; end this turn after sending.",
                { recipientId: z.string(), question: z.string() },
                async (args) =>
                  response({
                    requestId: tools.requestPeer(
                      args.recipientId,
                      args.question,
                    ),
                  }),
              ),
              tool(
                "peer_reply",
                "Reply to the task-associated peer request.",
                { requestId: z.string(), text: z.string() },
                async (args) => {
                  tools.replyPeer(args.requestId, args.text);
                  return response({ accepted: true });
                },
              ),
            ],
          });
          const messages = this.claudeQuery({
            prompt,
            options: {
              cwd: config.cwd,
              pathToClaudeCodeExecutable: config.executable,
              model: config.model,
              resume: prior,
              abortController: controller,
              maxTurns: config.maxTurns,
              maxBudgetUsd: config.maxBudgetUsd,
              permissionMode: "default",
              settingSources: [],
              mcpServers: { roundloom: server },
              canUseTool: async (name, input) => {
                if (
                  [
                    "mcp__roundloom__members",
                    "mcp__roundloom__peer_request",
                    "mcp__roundloom__peer_reply",
                  ].includes(name)
                )
                  return { behavior: "allow", updatedInput: input };
                const selection = await tools.requestPermission(
                  JSON.stringify({ tool: name, input }),
                  [
                    { id: "allow", label: "Allow once" },
                    { id: "deny", label: "Deny" },
                  ],
                );
                return selection === "allow"
                  ? { behavior: "allow", updatedInput: input }
                  : { behavior: "deny", message: "Denied by Roundloom user" };
              },
            },
          });
          for await (const message of messages) {
            if (
              "session_id" in message &&
              typeof message.session_id === "string"
            )
              session(message.session_id);
            if (message.type === "assistant") {
              for (const block of message.message.content)
                if (block.type === "text")
                  send({ id: randomUUID(), type: "output", text: block.text });
            }
            if (message.type === "result") {
              outcome =
                message.subtype === "success" && !message.is_error
                  ? "succeeded"
                  : "failed";
              if (message.subtype === "success") result = message.result;
            }
          }
        }
        if (outcome === "succeeded" && result && run.taskId) {
          if (
            run.purpose === "peer" &&
            run.peerRequestId &&
            this.id === "codex"
          )
            tools.replyPeer(run.peerRequestId, result);
          else if (run.purpose !== "peer")
            send({ id: randomUUID(), type: "result", content: result });
        }
      } catch {
        outcome = controller.signal.aborted ? "cancelled" : "unknown";
      } finally {
        clearTimeout(timer);
        if (timedOut) {
          outcome = "unknown";
          reason ??= "provider_timeout";
        }
        if (outcome === "succeeded") reason = undefined;
        this.active.delete(run.id);
        this.states.set(run.id, outcome);
        send({ id: randomUUID(), type: "state", state: outcome, reason });
      }
    })();
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
    return { nativeRef: prior ?? "" };
  }
  async cancel(run: Run): Promise<"requested" | "unknown"> {
    const c = this.active.get(run.id);
    if (!c) return "unknown";
    c.abort();
    return "requested";
  }
  async query(run: Run) {
    return this.states.get(run.id) ?? "unknown";
  }
  async dispose() {
    this.disposed = true;
    for (const c of this.active.values()) c.abort();
    this.active.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
