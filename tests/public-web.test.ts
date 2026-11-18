import assert from "node:assert/strict";
import test from "node:test";
import { publicLookup, webAnswer } from "../src/agent/public-web.ts";

test("only a public topic quoted from the current turn or its explicit URL leaves the group", () => {
  assert.deepEqual(publicLookup("介紹哈利路亞家教會", "哈利路亞家教會"), {
    topic: "哈利路亞家教會",
  });
  assert.deepEqual(publicLookup("官網：http://www.alive.org.tw/", "歷史訊息"), {
    url: "http://www.alive.org.tw/",
  });
  assert.equal(
    publicLookup("介紹這個地方", "another member's private quote"),
    undefined,
  );
  for (const link of [
    "http://127.0.0.1",
    "https://intranet.local/",
    "https://user:pass@example.com/",
    "https://example.com/file?token=abc",
    "https://liff.line.me/123",
    "https://example.com/share/secret",
  ]) {
    assert.equal(publicLookup("官網：" + link, "官網"), undefined);
  }
});
test("a failed page open or missing source never yields a sourced page summary", () => {
  assert.equal(
    webAnswer(
      { status: "completed", output: [] },
      { url: "https://www.alive.org.tw/" },
    ),
    undefined,
  );
});
test("private mixed statements and invitation links stay local; URL-only discloses no surrounding prose", () => {
  assert.equal(
    publicLookup("介紹哈利路亞家教會，我的病歷有這個名字", "哈利路亞家教會"),
    undefined,
  );
  for (const link of [
    "https://meet.google.com/abc-abcd-abc",
    "https://discord.gg/secret",
    "https://zoom.us/j/123",
  ])
    assert.equal(publicLookup(link, link), undefined);
  assert.deepEqual(
    publicLookup("我的名字在這裡 https://www.alive.org.tw/", "我的名字在這裡"),
    { url: "https://www.alive.org.tw/" },
  );
});
