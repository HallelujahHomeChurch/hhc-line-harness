import { test, expect } from "@playwright/test";
import { createServer } from "../../src/bootstrap/server.ts";
const group = "11111111-1111-4111-8111-111111111111",
  job = "22222222-2222-4222-8222-222222222222",
  source = "33333333-3333-4333-8333-333333333333";
let downloadable = false,
  forbidden = false,
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
                contentPath: downloadable
                  ? `/api/line/sources/${source}/content`
                  : null,
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
  downloadable = false;
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
        body: 'globalThis.liff={init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>"fixture-token",getDecodedIDToken:()=>({sub:sessionStorage.getItem("fixture-actor")||"U11111111111111111111111111111111"}),login:()=>{throw new Error("unexpected login")}};',
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

test("transient pickup retries the same job without starting another search", async ({
  page,
}) => {
  let searches = 0,
    reads = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/search")) searches++;
  });
  await page.route("**/groups/*/results/*", async (route) => {
    reads++;
    if (reads === 1)
      return route.fulfill({
        status: 503,
        json: { error: "search_unavailable" },
      });
    return route.continue();
  });
  await page.getByLabel("想找什麼？").fill("排班");
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByRole("button", { name: "查看查詢結果", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("稍後");
  await page.getByRole("button", { name: "查看查詢結果", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(1);
  expect(searches).toBe(1);
});
test("unknown mutation preserves one confirmation operation for result recovery", async ({
  page,
}) => {
  proposal = true;
  const requests: string[] = [];
  await page.route("**/edits/*/confirm", async (route) => {
    requests.push(route.request().url() + route.request().postData());
    return route.fulfill({
      status: requests.length === 1 ? 503 : 200,
      json: { ok: true },
    });
  });
  await page.getByLabel("想找什麼？").fill("刪除");
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByRole("button", { name: "查看查詢結果", exact: true }).click();
  await page.getByRole("button", { name: "預覽變更草稿" }).click();
  await page.getByRole("button", { name: "確認執行這項變更" }).click();
  await page.getByRole("button", { name: "重試確認結果" }).click();
  await expect(page.getByRole("status")).toContainText("變更已完成");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
});

for (const next of ["search", "reset"]) {
  test(`an old failed download cannot fence a newer ${next}`, async ({
    page,
  }) => {
    downloadable = true;
    await page.getByLabel("想找什麼？").fill("排班");
    await page.getByRole("button", { name: "搜尋", exact: true }).click();
    await page
      .getByRole("button", { name: "查看查詢結果", exact: true })
      .click();
    let releaseDownload!: () => void,
      downloadEntered!: () => void,
      releaseNext!: () => void;
    const downloadWait = new Promise<void>((r) => {
        releaseDownload = r;
      }),
      entered = new Promise<void>((r) => {
        downloadEntered = r;
      }),
      nextWait = new Promise<void>((r) => {
        releaseNext = r;
      });
    await page.route("**/sources/*/content", async (route) => {
      downloadEntered();
      await downloadWait;
      await route.fulfill({ status: 503, body: "" });
    });
    await page.getByRole("button", { name: "下載原件（未掃毒）" }).click();
    await entered;
    await page.route(`**/groups/*/${next}`, async (route) => {
      await nextWait;
      await route.fulfill({
        json: next === "search" ? { id: job } : { ok: true },
      });
    });
    if (next === "reset") page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", {
        name: next === "search" ? "搜尋" : "重設我的對話",
        exact: true,
      })
      .click();
    const failed = page.waitForResponse((r) => r.url().endsWith("/content"));
    releaseDownload();
    await failed;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    releaseNext();
    await expect(
      page.getByRole("button", { name: "搜尋", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "重設我的對話", exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole("status")).toContainText(
      next === "search" ? "已受理查詢" : "已重設",
    );
  });
}

test("pickup serializes repeated clicks while a response is pending", async ({
  page,
}) => {
  let release!: () => void,
    entered!: () => void,
    reads = 0;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  await page.route("**/groups/*/results/*", async (route) => {
    reads++;
    entered();
    await wait;
    await route.continue();
  });
  await page.getByLabel("想找什麼？").fill("排班");
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  const refresh = page.getByRole("button", {
    name: "查看查詢結果",
    exact: true,
  });
  await refresh.click();
  await started;
  try {
    await expect(refresh).toBeDisabled();
    await refresh.evaluate((button: HTMLButtonElement) => button.click());
    expect(reads).toBe(1);
  } finally {
    release();
  }
  await expect(page.locator("article")).toHaveCount(1);
  await expect(refresh).toBeEnabled();
});

test("unknown confirmation cannot be discarded by result refresh or a new query", async ({
  page,
}) => {
  proposal = true;
  const requests: string[] = [];
  await page.route("**/edits/*/confirm", (route) => {
    requests.push(route.request().url() + route.request().postData());
    return route.fulfill({
      status: requests.length === 1 ? 503 : 200,
      json: { ok: true },
    });
  });
  await page.getByLabel("想找什麼？").fill("刪除");
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByRole("button", { name: "查看查詢結果", exact: true }).click();
  await page.getByRole("button", { name: "預覽變更草稿" }).click();
  await page.getByRole("button", { name: "確認執行這項變更" }).click();
  await expect(
    page.getByRole("button", { name: "重試確認結果" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "查看查詢結果", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "搜尋", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "重設我的對話" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "重試確認結果" }).click();
  await expect(page.getByRole("status")).toContainText("變更已完成");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
  await expect(
    page.getByRole("button", { name: "搜尋", exact: true }),
  ).toBeEnabled();
});

test("submitted confirmation survives page reload and is scoped to actor and group", async ({
  page,
}) => {
  proposal = true;
  const requests: string[] = [];
  await page.route("**/edits/*/confirm", (route) => {
    requests.push(route.request().url() + route.request().postData());
    return route.fulfill({
      status: requests.length === 1 ? 503 : 200,
      json: { ok: true },
    });
  });
  await page.getByLabel("想找什麼？").fill("刪除");
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByRole("button", { name: "查看查詢結果", exact: true }).click();
  await page.getByRole("button", { name: "預覽變更草稿" }).click();
  await page.getByRole("button", { name: "確認執行這項變更" }).click();
  await expect(
    page.getByRole("button", { name: "重試確認結果" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.entries(sessionStorage)
        .filter(([key]) => key.startsWith("hhc-line-harness-edit:"))
        .map(([, value]) => JSON.parse(value)),
    ),
  ).toEqual([{ id: job, token: "a".repeat(43), group }]);
  await page.evaluate(() =>
    sessionStorage.setItem(
      "fixture-actor",
      "U22222222222222222222222222222222",
    ),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "搜尋", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "重試確認結果" })).toHaveCount(
    0,
  );
  await page.evaluate(() => sessionStorage.removeItem("fixture-actor"));
  await page.goto(`${origin}/api/line/harness/app#group=${source}`);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "搜尋", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "重試確認結果" })).toHaveCount(
    0,
  );
  await page.goto(`${origin}/api/line/harness/app#group=${group}`);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "重試確認結果" }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "重試確認結果" }).click();
  await expect(page.getByRole("status")).toContainText("變更已完成");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "搜尋", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "重試確認結果" })).toHaveCount(
    0,
  );
});
