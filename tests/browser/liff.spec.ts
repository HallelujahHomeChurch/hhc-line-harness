import { test, expect } from "@playwright/test";
import { createServer } from "../../src/bootstrap/server.ts";
const group = "11111111-1111-4111-8111-111111111111",
  job = "22222222-2222-4222-8222-222222222222",
  source = "33333333-3333-4333-8333-333333333333";
let forbidden = false,
  proposal = false,
  previews = 0,
  confirmations = 0;
const app = createServer({
  channelSecret: "synthetic",
  checkDatabase: async () => {},
  searchAccess: {
    edits: {
      preview: async () => {
        previews++;
        return {
          id: job,
          token: "a".repeat(43),
          text: "完整預覽：刪除排班原始資料",
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        };
      },
      confirm: async () => {
        confirmations++;
      },
    },
    liffId: "1234567890-abcdefgh",
    identity: async (token) => {
      if (token !== "fixture-token") throw new Error("search_forbidden");
      return "fixture-actor";
    },
    service: {
      start: async () => ({ id: job, generation: "1" }),
      read: async () => {
        if (forbidden) throw new Error("search_forbidden");
        return {
          state: "ready",
          result: {
            status: "success",
            ...(proposal
              ? { proposal: { sourceId: source, kind: "delete" as const } }
              : {}),
            gaps: [],
            items: [
              {
                id: source,
                revision: "1",
                descriptionRevision: "1",
                name: '<img src=x onerror="alert(1)">同工排班',
                authorId: null,
                publishedAt: "2026-11-13T00:00:00Z",
                expiresAt: "2027-02-11T00:00:00Z",
                kind: "file",
                description: null,
                snippet: "十二月同工排班，請依原群組公告為準。",
                indexState: "ready",
                gaps: ["version_not_confirmed"],
                contentPath: null,
                versions: [],
              },
            ],
          },
        };
      },
      reset: async () => {},
    },
  },
});
let origin: string;
test.beforeAll(async () => {
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await app.close();
});
test.beforeEach(async ({ page }) => {
  forbidden = false;
  proposal = false;
  previews = 0;
  confirmations = 0;
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin + "/")) return route.continue();
    if (url === "https://static.line-scdn.net/liff/edge/versions/2.31.1/sdk.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: 'globalThis.liff={init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>"fixture-token",login:()=>{throw new Error("unexpected login")}};',
      });
    return route.abort();
  });
  await page.goto(`${origin}/api/line/harness/app#group=${group}`);
  await expect(
    page.getByRole("button", { name: "搜尋", exact: true }),
  ).toBeEnabled();
});
test("mobile search renders untrusted names as text and clears results when membership is denied", async ({
  page,
}) => {
  await page.getByLabel("想找什麼？").fill("同工排班");
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByRole("button", { name: "查看查詢結果", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2 })).toContainText(
    "<img src=x",
  );
  await expect(page.locator("article img")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".artifacts/browser/liff-mobile.png",
    fullPage: true,
  });
  forbidden = true;
  await page.getByRole("button", { name: "查看查詢結果", exact: true }).click();
  await expect(page.locator("#results article")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("目前無權查看");
});
test("reset confirms its scope and removes only the current user's displayed result", async ({
  page,
}) => {
  await page.getByLabel("想找什麼？").fill("排班");
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByRole("button", { name: "查看查詢結果", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(1);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("群組原始資料仍會保留");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "重設我的對話" }).click();
  await expect(page.getByRole("status")).toContainText("已重設你的對話");
  await expect(page.locator("article")).toHaveCount(0);
});

test("an Agent draft requires a separate complete preview and human confirmation", async ({
  page,
}) => {
  proposal = true;
  await page.getByLabel("想找什麼？").fill("排班");
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByRole("button", { name: "查看查詢結果", exact: true }).click();
  expect(previews).toBe(0);
  expect(confirmations).toBe(0);
  await page.getByRole("button", { name: "預覽變更草稿" }).click();
  await expect(page.getByText("完整預覽：刪除排班原始資料")).toBeVisible();
  expect(previews).toBe(1);
  expect(confirmations).toBe(0);
  await page.getByRole("button", { name: "確認執行這項變更" }).click();
  await expect(page.getByRole("status")).toContainText("變更已完成");
  expect(confirmations).toBe(1);
});

test("reset serializes search and stale search completion cannot unlock it", async ({
  page,
}) => {
  let releaseSearch!: () => void;
  const oldSearch = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  await page.route("**/groups/*/search", async (route) => {
    await oldSearch;
    await route.fulfill({ json: { id: job } });
  });
  await page.getByLabel("想找什麼？").fill("重設前查詢");
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  let releaseReset!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseReset = resolve;
  });
  await page.route("**/groups/*/reset", async (route) => {
    await held;
    await route.fulfill({ json: { ok: true } });
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "重設我的對話" }).click();
  try {
    releaseSearch();
    await expect(
      page.getByRole("button", { name: "搜尋", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "查看查詢結果", exact: true }),
    ).toBeHidden();
  } finally {
    releaseReset();
  }
  await expect(
    page.getByRole("button", { name: "搜尋", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("想找什麼？").fill("重設後查詢");
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByRole("button", { name: "查看查詢結果", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(1);
});
