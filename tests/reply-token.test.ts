import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplyTokenCipher } from "../src/reply/token.ts";
test("reply tokens are authenticated and bound to one delivery", () => {
  const cipher = new ReplyTokenCipher("a".repeat(64));
  const sealed = cipher.seal("synthetic-reply-token", "delivery-1");
  assert.notEqual(sealed, cipher.seal("synthetic-reply-token", "delivery-1"));
  assert.doesNotMatch(sealed, /synthetic/);
  assert.equal(cipher.open(sealed, "delivery-1"), "synthetic-reply-token");
  assert.throws(() => cipher.open(sealed, "delivery-2"));
  assert.throws(() =>
    new ReplyTokenCipher("b".repeat(64)).open(sealed, "delivery-1"),
  );
  assert.throws(() => cipher.open(sealed.slice(1), "delivery-1"));
  assert.throws(() => new ReplyTokenCipher("short"));
});
test("protected product payloads have a separate bounded size from reply tokens", () => {
  const cipher = new ReplyTokenCipher("a".repeat(64)),
    value = "中文".repeat(1000);
  const encrypted = cipher.sealPayload(value, "checkpoint:fixture");
  assert.equal(cipher.openPayload(encrypted, "checkpoint:fixture"), value);
  assert.throws(() => cipher.open(encrypted, "checkpoint:fixture"));
  assert.throws(() => cipher.seal(value, "fixture"));
  assert.throws(() => cipher.sealPayload("中".repeat(22000), "fixture"));
});
