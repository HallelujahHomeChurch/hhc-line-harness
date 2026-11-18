import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceClient } from "../src/providers/http.ts";
import { LineClient } from "../src/providers/line.ts";
import { AccountClient } from "../src/providers/account.ts";
test("LINE resource actions open the protected page without putting its URL in reply text", async () => {
  let body:
    | {
        messages: {
          text: string;
          quickReply: { items: { action: unknown }[] };
        }[];
      }
    | undefined;
  const client = new LineClient("fixture", async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({});
  });
  const uri =
    "https://liff.line.me/123456-test?group=11111111-1111-4111-8111-111111111111&result=22222222-2222-4222-8222-222222222222";
  await client.reply("token", "找到這份資料。", [{ label: "查看資料", uri }]);
  assert.equal(body!.messages[0]!.text, "找到這份資料。");
  assert.deepEqual(body!.messages[0]!.quickReply.items[0]!.action, {
    type: "uri",
    label: "查看資料",
    uri,
  });
  await assert.rejects(
    client.reply("token", "回答", [
      { label: "查看", uri: "https://evil.invalid/" },
    ]),
    /invalid_reply/,
  );
});
test("bounded service request refuses redirects, oversized metadata and non-HTTPS origins", async () => {
  assert.throws(() => new ServiceClient("http://localhost", {}));
  const client = new ServiceClient(
    "https://fixture.invalid",
    {},
    async (_url, init) => {
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      return new Response("a".repeat(32769));
    },
  );
  await assert.rejects(
    client.json("/private", "GET"),
    /dependency_unavailable/,
  );
});
test("LINE Reply sends once without retry key; membership rejects wrong user", async () => {
  let calls = 0;
  const client = new LineClient("synthetic-token", async (url, init) => {
    calls++;
    assert.ok(String(url).startsWith("https://api.line.me/v2/bot/"));
    assert.equal(new Headers(init?.headers).get("X-Line-Retry-Key"), null);
    if (String(url).endsWith("/message/reply")) throw new Error("uncertain");
    return Response.json({ userId: `U${"b".repeat(32)}` });
  });
  await assert.rejects(client.reply("reply-token", "reply"));
  assert.equal(calls, 1);
  assert.equal(
    await client.member(`C${"c".repeat(32)}`, `U${"a".repeat(32)}`),
    false,
  );
});
test("Account uses dedicated exact caller and validates authority versions", async () => {
  const client = new AccountClient(
    "https://account.invalid",
    "a".repeat(64),
    "new-profile",
    "channel",
    async (url, init) => {
      assert.equal(
        String(url),
        "https://account.invalid/priv/account/v1/line-harness/admin-authority",
      );
      assert.equal(
        new Headers(init?.headers).get("X-HHC-Account-Service-Caller"),
        "hhc-line-harness",
      );
      return Response.json({
        version: 2,
        bound: true,
        allowed: true,
        actorUserId: "arbitrary",
      });
    },
  );
  await assert.rejects(
    client.authority(`U${"a".repeat(32)}`),
    /dependency_unavailable/,
  );
});

test("Go zero timestamps do not mark live Asset collections or items deleted", async () => {
  const { AssetClient } = await import("../src/providers/asset.ts");
  const { AssetOriginalClient } =
    await import("../src/providers/asset-original.ts");
  const { AssetPublicationClient } =
    await import("../src/providers/asset-publication.ts");
  const id = "11111111-1111-4111-8111-111111111111",
    zero = "0001-01-01T00:00:00Z";
  const client = new AssetClient("https://asset.invalid", "token", async () =>
    Response.json({
      collection: {
        id,
        sourcePolicyVersion: 1,
        namespace: "line.group.media-sync",
        aclRevision: 1,
        bindingGeneration: 1,
        deletedAt: zero,
      },
      acls: [
        {
          id,
          collectionId: id,
          subjectType: "role",
          subjectId: id,
          permission: "read",
          revokedAt: zero,
        },
      ],
    }),
  );
  assert.equal((await client.collection(id)).audience.length, 1);
  const original = new AssetOriginalClient("https://asset.invalid", "token", [
    "https://blob.invalid",
  ]);
  assert.equal(
    original.record(
      {
        id,
        ownerService: "hhc-line-harness",
        namespace: "line.group.file",
        securityProfile: "line-source-unscanned-v1",
        processingProfile: "no-processing-v1",
        visibility: "restricted",
        sourcePolicy: {
          version: 1,
          ref: id,
          revision: id,
          publishedAt: "2026-01-01T00:00:00Z",
          expiresAt: "2026-04-01T00:00:00Z",
        },
        processingReadiness: { version: 2, state: "ready" },
        safetyEvidence: { kind: "not-scanned" },
        uploadStatus: "completed",
        scanStatus: "not_required",
        processingStatus: "not_required",
        deletedAt: zero,
      },
      true,
    ).ready,
    true,
  );
  assert.equal(
    new AssetPublicationClient(client.http).record({
      item: {
        id,
        collectionId: id,
        assetId: id,
        sourceRevision: id,
        publicationState: "active",
        deletedAt: zero,
      },
    }).state,
    "active",
  );
});

test("publication metadata recovery preserves terminal deletion for cleanup", async () => {
  const { AssetPublicationClient } =
    await import("../src/providers/asset-publication.ts");
  const client = new AssetPublicationClient(
    new ServiceClient("https://asset.invalid", {}),
  );
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    client.record({
      item: {
        id,
        collectionId: id,
        assetId: "",
        sourceRevision: id,
        publicationState: "active",
        deletedAt: "2026-11-12T00:00:00Z",
      },
    }).state,
    "deleted",
  );
});

test("service requests carry Asset audit correlation using its canonical header", async () => {
  const client = new ServiceClient(
    "https://asset.invalid",
    {},
    async (_url, init) => {
      assert.match(
        new Headers(init?.headers).get("X-HHC-Request-ID") ?? "",
        /^[0-9a-f]{32}$/,
      );
      return Response.json({ ok: true });
    },
  );
  await client.json("/priv/assets/collections", "GET");
});

test("group labels validate the exact LINE group and never retain icon URLs", async () => {
  const group = `C${"c".repeat(32)}`;
  const client = new LineClient("token", async () =>
    Response.json({
      groupId: group,
      groupName: "週日小組",
      pictureUrl: "https://unused.invalid/icon",
    }),
  );
  assert.equal(await client.groupName(group), "週日小組");
  await assert.rejects(
    client.groupName(`C${"d".repeat(32)}`),
    /dependency_unavailable/,
  );
});

test("Account directory resolves exact IDs and rejects malformed or substituted subjects", async () => {
  const actor = "11111111-1111-4111-8111-111111111111";
  const id = "22222222-2222-4222-8222-222222222222";
  let substitute = false;
  const client = new AccountClient(
    "https://account.invalid",
    "a".repeat(64),
    "profile",
    "channel",
    async (url, init) => {
      assert.match(String(url), /\/line-harness\/acl-subjects\/search$/);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.userId, actor);
      assert.equal(body.query, id);
      return Response.json({
        subjects: [
          {
            id: substitute ? actor : id,
            type: "role",
            displayName: "Readers",
            email: "",
          },
        ],
        page: 1,
        perPage: 20,
        hasMore: false,
      });
    },
  );
  assert.deepEqual(await client.subject(actor, "role", id), {
    id,
    type: "role",
    label: "Readers",
  });
  substitute = true;
  await assert.rejects(
    client.subject(actor, "role", id),
    /subject_unavailable/,
  );
});

test("Asset reader addition carries CAS, immutable operation and trusted audit actor", async () => {
  const { AssetClient } = await import("../src/providers/asset.ts");
  const id = "11111111-1111-4111-8111-111111111111";
  const client = new AssetClient(
    "https://asset.invalid",
    "token",
    async (url, init) => {
      assert.equal(
        String(url),
        `https://asset.invalid/priv/assets/collections/${id}/acl`,
      );
      assert.deepEqual(JSON.parse(String(init?.body)), {
        subjectType: "role",
        subjectId: id,
        permission: "read",
        expectedAclRevision: 7,
      });
      assert.equal(new Headers(init?.headers).get("X-HHC-Actor-ID"), id);
      assert.equal(
        new Headers(init?.headers).get("Idempotency-Key"),
        "a".repeat(64),
      );
      return Response.json({});
    },
  );
  await client.addReader(
    id,
    { type: "role", id, label: "Readers" },
    7,
    "a".repeat(64),
    id,
  );
});

test("Asset reader revocation sends If-Match and a recoverable operation without expanding authority", async () => {
  const { AssetClient } = await import("../src/providers/asset.ts");
  const id = "11111111-1111-4111-8111-111111111111";
  const client = new AssetClient(
    "https://asset.invalid",
    "token",
    async (url, init) => {
      assert.equal(
        String(url),
        `https://asset.invalid/priv/assets/collections/${id}/acl/${id}`,
      );
      assert.equal(init?.method, "DELETE");
      assert.equal(new Headers(init?.headers).get("If-Match"), '"7"');
      assert.equal(new Headers(init?.headers).get("X-HHC-Actor-ID"), id);
      assert.equal(
        new Headers(init?.headers).get("Idempotency-Key"),
        "a".repeat(64),
      );
      return Response.json({});
    },
  );
  await client.revokeReader(id, id, 7, "a".repeat(64), id);
});

test("publication names match owner-validated Unicode fixtures without altering source metadata", async () => {
  const { readFile } = await import("node:fs/promises");
  const { AssetPublicationClient } =
    await import("../src/providers/asset-publication.ts");
  const rows = JSON.parse(
    await readFile("tests/fixtures/publication-names.json", "utf8"),
  ) as { input: string; output: string }[];
  for (const row of rows) {
    const client = new AssetPublicationClient(
      new ServiceClient("https://asset.example", {}, async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.displayName, row.output);
        return Response.json({
          item: {
            id: "item",
            collectionId: "collection",
            assetId: "asset",
            sourceRevision: "operation",
            publicationState: "staged",
          },
        });
      }),
    );
    const source = {
      id: "source",
      asset_id: "asset",
      file_name: row.input,
    } as import("../src/worker/original.ts").Source;
    await client.stage(
      {
        id: "operation",
        collection_id: "collection",
        binding_generation: "1",
        acl_revision: "1",
      } as import("../src/worker/publication.ts").Publication,
      source,
    );
    assert.equal(source.file_name, row.input);
  }
});

test("Account subject authority preserves optional linked actor and rejects malformed linked identity", async () => {
  const actor = "11111111-1111-7111-8111-111111111111",
    line = "U" + "a".repeat(32);
  let response: Record<string, unknown> = {
    version: 1,
    allowed: true,
    bound: true,
    actorUserId: actor,
    bindingGeneration: 1,
    adminAuthorizationRevision: 2,
    lineUserId: line,
  };
  const client = new AccountClient(
    "https://account.invalid",
    "a".repeat(64),
    "helper",
    "channel",
    async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { userId: actor });
      return Response.json(response);
    },
  );
  assert.equal((await client.subjectAuthority(actor)).lineUserId, line);
  for (const invalid of [
    null,
    123,
    "U" + "z".repeat(32),
    "C" + "a".repeat(32),
  ]) {
    response.lineUserId = invalid;
    await assert.rejects(
      client.subjectAuthority(actor),
      /dependency_unavailable/,
    );
  }
  delete response.lineUserId;
  assert.equal((await client.subjectAuthority(actor)).lineUserId, undefined);
  response.bound = false;
  delete response.bindingGeneration;
  assert.equal((await client.subjectAuthority(actor)).allowed, true);
  response.lineUserId = line;
  await assert.rejects(
    client.subjectAuthority(actor),
    /dependency_unavailable/,
  );
});
