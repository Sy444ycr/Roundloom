import { z } from "zod";
export class CoreError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireThat(
  value: unknown,
  code: string,
  message: string,
): asserts value {
  if (!value) throw new CoreError(code, message);
}
const id = z.string().min(1).max(200);
const text = z.string().min(1).max(100_000);
const room = { roomId: id };
const task = { taskId: id, expectedVersion: z.number().int().positive() };
export const payloads = {
  "rooms.create": z.object({ name: text }).strict(),
  "rooms.list": z.object({}).strict(),
  "rooms.pause": z.object({ ...room, paused: z.boolean() }).strict(),
  "members.add": z
    .object({
      ...room,
      name: text,
      adapterId: id,
      config: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  "members.list": z.object(room).strict(),
  "messages.send": z
    .object({ ...room, text, recipients: z.array(id).max(20).default([]) })
    .strict(),
  "messages.list": z
    .object({
      ...room,
      after: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  "tasks.assign": z
    .object({
      ...room,
      ownerId: id,
      goal: text,
      criteria: z.array(text).min(1).max(50),
      maxRuns: z.number().int().min(1).max(100).default(12),
    })
    .strict(),
  "tasks.get": z.object({ taskId: id }).strict(),
  "tasks.list": z.object(room).strict(),
  "tasks.cancel": z.object(task).strict(),
  "tasks.retry": z.object(task).strict(),
  "tasks.continue": z
    .object({
      ...task,
      maxRuns: z.number().int().min(1).max(100).optional(),
      note: text,
    })
    .strict(),
  "tasks.update": z
    .object({ ...task, goal: text, criteria: z.array(text).min(1).max(50) })
    .strict(),
  "tasks.handoff": z.object({ ...task, ownerId: id, note: text }).strict(),
  "tasks.accept": z
    .object({
      ...task,
      artifactId: id,
      requirementsVersion: z.number().int().positive(),
    })
    .strict(),
  "tasks.reject": z.object({ ...task, reason: text }).strict(),
  "runs.list": z.object(room).strict(),
  "artifacts.list": z.object({ taskId: id }).strict(),
  "events.read": z
    .object({
      ...room,
      after: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  "rooms.snapshot": z.object(room).strict(),
} as const;
export type Operation = keyof typeof payloads;
export const commandSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: id,
    operation: z.enum(Object.keys(payloads) as [Operation, ...Operation[]]),
    payload: z.unknown(),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "review"
  | "completed"
  | "failed"
  | "cancelled";
export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";
export interface Room {
  id: string;
  name: string;
  paused: boolean;
}
export interface Member {
  id: string;
  roomId: string;
  name: string;
  adapterId: string;
  config: Record<string, unknown>;
  sessionId: string;
  simulated: boolean;
}
export interface Message {
  id: string;
  roomId: string;
  senderId: string;
  text: string;
  recipients: string[];
  taskId?: string;
  requestId?: string;
}
export interface Task {
  id: string;
  roomId: string;
  ownerId: string;
  goal: string;
  criteria: string[];
  version: number;
  requirementsVersion: number;
  ownershipVersion: number;
  status: TaskStatus;
  waitReason?: string;
  cancelRequested: boolean;
  maxRuns: number;
  runCount: number;
  attempt: number;
  artifactId?: string;
}
export interface Run {
  id: string;
  roomId: string;
  memberId: string;
  sessionId: string;
  taskId?: string;
  input: string;
  status: RunStatus;
  requirementsVersion: number;
  ownershipVersion: number;
  attempt: number;
  purpose: "discussion" | "task" | "peer";
  peerRequestId?: string;
  cancelRequested: boolean;
  config: Record<string, unknown>;
  adapterId: string;
  nativeRef?: string;
  contextManifest?: {
    goal: string;
    criteria: string[];
    requirementsVersion: number;
    ownershipVersion: number;
    triggerInput: string;
  };
}
export interface PeerRequest {
  id: string;
  roomId: string;
  taskId: string;
  sourceRunId: string;
  senderId: string;
  recipientId: string;
  question: string;
  status: "pending" | "replied" | "expired" | "cancelled";
  deadline: number;
  reply?: string;
  resumed: boolean;
}
export interface Artifact {
  id: string;
  roomId: string;
  taskId: string;
  runId: string;
  content: string;
  digest: string;
  requirementsVersion: number;
  simulated: boolean;
  verification: "unverified";
}
export interface StoredEvent {
  eventId: string;
  roomId: string;
  sequence: number;
  type: string;
  at: string;
  payload: unknown;
}
