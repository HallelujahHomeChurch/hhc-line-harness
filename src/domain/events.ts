export type EventType =
  | "message"
  | "postback"
  | "unsend"
  | "leave"
  | "join"
  | "memberLeft"
  | "memberJoined"
  | "accountLink"
  | "other";
export type MessageType =
  "text" | "file" | "image" | "audio" | "video" | "unsupported";
export interface Message {
  id: string;
  type: MessageType;
  text?: string;
  fileName?: string;
  size?: number;
  quotedMessageId?: string;
  mentionsBot: boolean;
}
export interface LineEvent {
  id: string;
  type: EventType;
  publishedAt: Date;
  scope: "group" | "user" | "room";
  scopeId: string;
  actorId?: string;
  replyToken?: string;
  message?: Message;
  postback?: string;
  unsentMessageId?: string;
  accountLink?: { nonce: string; result: "ok" | "failed" };
}
const types = new Set<EventType>([
  "message",
  "postback",
  "unsend",
  "leave",
  "join",
  "memberLeft",
  "memberJoined",
  "accountLink",
]);
const messageTypes = new Set<MessageType>([
  "text",
  "file",
  "image",
  "audio",
  "video",
]);
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid_payload");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 512): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    throw new Error("invalid_payload");
  return value;
}
function opaque(value: unknown): string {
  const id = string(value, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid_payload");
  return id;
}
function identity(value: unknown, prefix: string): string {
  const id = string(value, 33);
  if (!new RegExp(`^${prefix}[0-9a-f]{32}$`).test(id))
    throw new Error("invalid_payload");
  return id;
}
export function parseEvents(payload: unknown, botId: string): LineEvent[] {
  identity(botId, "U");
  const envelope = object(payload);
  if (
    envelope.destination !== botId ||
    !Array.isArray(envelope.events) ||
    envelope.events.length > 100
  )
    throw new Error("invalid_payload");
  return envelope.events.flatMap((raw: unknown): LineEvent[] => {
    const e = object(raw);
    if (
      e.type === "accountLink" &&
      e.source === undefined &&
      object(e.link).result === "failed"
    ) {
      opaque(e.webhookEventId);
      string(object(e.link).nonce, 255);
      return [];
    }
    const source = object(e.source);
    if (
      source.type !== "group" &&
      source.type !== "user" &&
      source.type !== "room"
    )
      throw new Error("invalid_payload");
    const scopeId =
      source.type === "group"
        ? identity(source.groupId, "C")
        : source.type === "room"
          ? identity(source.roomId, "R")
          : identity(source.userId, "U");
    if (
      !Number.isSafeInteger(e.timestamp) ||
      Number(e.timestamp) < 0 ||
      Number(e.timestamp) > 8_640_000_000_000_000
    )
      throw new Error("invalid_payload");
    const type = string(e.type, 64);
    const result: LineEvent = {
      id: opaque(e.webhookEventId),
      type: types.has(type as EventType) ? (type as EventType) : "other",
      publishedAt: new Date(Number(e.timestamp)),
      scope: source.type,
      scopeId,
    };
    if (source.userId !== undefined)
      result.actorId = identity(source.userId, "U");
    if (e.replyToken !== undefined) result.replyToken = string(e.replyToken);
    if (result.type === "message") {
      const m = object(e.message);
      const kind = string(m.type, 32);
      const message: Message = {
        id: opaque(m.id),
        type: messageTypes.has(kind as MessageType)
          ? (kind as MessageType)
          : "unsupported",
        mentionsBot: false,
      };
      if (message.type === "text") {
        message.text = string(m.text, 32768);
        if (m.mention !== undefined) {
          const mention = object(m.mention);
          if (
            !Array.isArray(mention.mentionees) ||
            mention.mentionees.length > 100
          )
            throw new Error("invalid_payload");
          message.mentionsBot = mention.mentionees.some((entry: unknown) => {
            const item = object(entry);
            return item.type === "user" && item.userId === botId;
          });
        }
      }
      if (m.fileName !== undefined) message.fileName = string(m.fileName, 1024);
      if (m.fileSize !== undefined) {
        if (!Number.isSafeInteger(m.fileSize) || Number(m.fileSize) < 0)
          throw new Error("invalid_payload");
        message.size = Number(m.fileSize);
      }
      if (m.quotedMessageId !== undefined)
        message.quotedMessageId = opaque(m.quotedMessageId);
      result.message = message;
    }
    if (result.type === "postback")
      result.postback = string(object(e.postback).data, 300);
    if (result.type === "unsend")
      result.unsentMessageId = opaque(object(e.unsend).messageId);
    if (result.type === "accountLink") {
      const link = object(e.link);
      if (link.result !== "ok" && link.result !== "failed")
        throw new Error("invalid_payload");
      result.accountLink = {
        nonce: string(link.nonce, 253),
        result: link.result,
      };
    }
    return [result];
  });
}
