import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEvents } from "../src/domain/events.ts";

const bot = `U${"b".repeat(32)}`;
const actor = `U${"a".repeat(32)}`;
const group = `C${"c".repeat(32)}`;
const event = {
  type: "message",
  webhookEventId: "event_01",
  timestamp: 1_800_000_000_000,
  replyToken: "r".repeat(32),
  source: { type: "group", groupId: group, userId: actor },
  message: {
    id: "123456789",
    type: "text",
    text: "@Bot 設定群組",
    mention: { mentionees: [{ type: "user", userId: bot }] },
  },
};
test("bounded webhook projection preserves trusted actor and explicit Bot mention", () => {
  const events = parseEvents({ destination: bot, events: [event] }, bot);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actorId, actor);
  assert.equal(events[0]?.scopeId, group);
  assert.equal(events[0]?.message?.text, "@Bot 設定群組");
  assert.equal(events[0]?.message?.mentionsBot, true);
  assert.equal(parseEvents({ destination: bot, events: [] }, bot).length, 0);
});
test("wrong destination, unbounded batches and malformed identity fail before persistence", () => {
  for (const payload of [
    { destination: actor, events: [event] },
    { destination: bot, events: Array(101).fill(event) },
    { destination: bot, events: [null] },
    { destination: bot, events: [{ ...event, timestamp: NaN }] },
    {
      destination: bot,
      events: [{ ...event, source: { type: "group", groupId: "other" } }],
    },
    {
      destination: bot,
      events: [
        { ...event, message: { ...event.message, text: "x".repeat(32769) } },
      ],
    },
  ])
    assert.throws(() => parseEvents(payload, bot));
});
test("unknown events carry no content and attachment context never comes from adjacent text", () => {
  const projected = parseEvents(
    {
      destination: bot,
      events: [
        {
          ...event,
          type: "future-event",
          secret: "never-retain",
          message: undefined,
        },
      ],
    },
    bot,
  )[0];
  assert.equal(projected?.type, "other");
  assert.equal(projected?.message, undefined);
  assert.doesNotMatch(JSON.stringify(projected), /never-retain/);
});

test("source-less failed account-link event is safely ignored without inventing an actor", () => {
  assert.deepEqual(
    parseEvents(
      {
        destination: `U${"b".repeat(32)}`,
        events: [
          {
            type: "accountLink",
            webhookEventId: "failed",
            timestamp: Date.now(),
            link: { result: "failed", nonce: "synthetic-nonce" },
          },
        ],
      },
      `U${"b".repeat(32)}`,
    ),
    [],
  );
});
