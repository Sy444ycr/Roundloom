import type { Run } from "../../contracts/src/index.js";
export type AdapterEvent = { id: string } & (
  | { type: "session"; nativeRef: string }
  | { type: "output"; text: string }
  | { type: "result"; content: string }
  | {
      type: "state";
      state: "succeeded" | "failed" | "cancelled" | "unknown";
      reason?: string;
    }
);
export interface RunTools {
  listMembers(): { id: string; name: string }[];
  requestPermission(
    title: string,
    options: { id: string; label: string }[],
  ): Promise<string | null>;
  requestPeer(
    recipientId: string,
    question: string,
    timeoutMs?: number,
  ): string;
  replyPeer(requestId: string, text: string): void;
}
export interface Adapter {
  readonly id: string;
  readonly simulated: boolean;
  readonly capabilities: {
    cancel: boolean;
    resume: boolean;
    peerMessaging: boolean;
  };
  validateConfig(config: Record<string, unknown>): Record<string, unknown>;
  start(
    run: Run,
    emit: (event: AdapterEvent) => void,
    tools: RunTools,
  ): Promise<{ nativeRef: string }>;
  cancel(run: Run): Promise<"requested" | "unsupported" | "unknown">;
  query(run: Run): Promise<"succeeded" | "failed" | "cancelled" | "unknown">;
  dispose?(): void | Promise<void>;
  connect?(
    sessionId: string,
    config: Record<string, unknown>,
  ): Promise<unknown>;
  authenticate?(sessionId: string, methodId: string): Promise<unknown>;
  disconnect?(sessionId: string): Promise<void>;
}
