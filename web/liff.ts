import type { SearchResult } from "../src/search/search.ts";
declare const liff: {
  init: (options: { liffId: string }) => Promise<void>;
  isLoggedIn: () => boolean;
  login: () => void;
  getIDToken: () => string | null;
  getDecodedIDToken: () => { sub: string } | null;
};
const form = document.querySelector<HTMLFormElement>("#search")!;
const submit = document.querySelector<HTMLButtonElement>("#submit")!,
  reset = document.querySelector<HTMLButtonElement>("#reset")!,
  refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
const status = document.querySelector<HTMLElement>("#status")!,
  results = document.querySelector<HTMLElement>("#results")!;
let group = "",
  job = "",
  generation = 0,
  resetting = false,
  pickingUp = false;
type Confirmation = { id: string; token: string; group: string };
let confirmation: Confirmation | undefined,
  recoveryKey = "";
const confirmationPanel = document.createElement("section");
results.after(confirmationPanel);
function finishConfirmation() {
  try {
    sessionStorage.removeItem(recoveryKey);
  } catch {
    /* A retained receipt only retries the same operation. */
  }
  confirmation = undefined;
  confirmationPanel.replaceChildren();
  submit.disabled = resetting;
  reset.disabled = resetting;
  refresh.disabled = resetting || pickingUp;
}
function confirmOperation(operation: Confirmation, button: HTMLButtonElement) {
  if (button.disabled || (confirmation && confirmation.id !== operation.id))
    return;
  try {
    // Store only the operation receipt, never the ID token or source contents.
    sessionStorage.setItem(recoveryKey, JSON.stringify(operation));
  } catch {
    status.textContent =
      "無法保存確認收據，尚未送出變更。請允許此頁使用工作階段儲存後重試。";
    return;
  }
  confirmation = operation;
  submit.disabled = reset.disabled = refresh.disabled = button.disabled = true;
  void request(
    `/api/line/harness/groups/${operation.group}/edits/${operation.id}/confirm`,
    { token: operation.token },
  ).then(
    () => {
      if (confirmation !== operation) return;
      finishConfirmation();
      clear();
      status.textContent = "變更已完成，請重新查詢。";
    },
    (e) => {
      if (confirmation !== operation) return;
      if (denied(e)) {
        finishConfirmation();
        clear();
      } else {
        button.disabled = false;
        button.textContent = "重試確認結果";
      }
      status.textContent = message(e);
    },
  );
}
function restoreConfirmation() {
  let value: unknown;
  try {
    value = JSON.parse(sessionStorage.getItem(recoveryKey) ?? "null");
  } catch {
    return;
  }
  if (!value || typeof value !== "object") return;
  const p = value as Record<string, unknown>;
  if (
    p.group !== group ||
    typeof p.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(p.id) ||
    typeof p.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(p.token)
  )
    return;
  const operation = { id: p.id, token: p.token, group };
  confirmation = operation;
  const note = document.createElement("p"),
    button = document.createElement("button");
  note.textContent =
    "先前送出的變更結果尚待確認。請核對同一筆操作，不會重新建立變更。";
  button.textContent = "重試確認結果";
  button.onclick = () => confirmOperation(operation, button);
  confirmationPanel.replaceChildren(note, button);
  submit.disabled = reset.disabled = refresh.disabled = true;
  status.textContent = "請先確認上一筆變更結果。";
}
const labels: Record<string, string> = {
  semantic_index_unavailable: "語意索引暫時不可用，目前使用關鍵字搜尋",
  agent_unavailable_basic_search:
    "智能查詢暫時無法完成，目前顯示關鍵字搜尋結果",
  pending_index: "文字尚在整理",
  index_failed: "部分文字無法整理，原件仍可下載",
  cached_values: "僅包含試算表儲存的值",
  unsupported_spreadsheet: "此試算表格式僅可搜尋檔名",
  metadata_only: "僅可搜尋附件資料",
  no_embedded_text: "文件沒有可擷取文字（不進行文字辨識）",
  malformed_document: "文件文字無法擷取",
  encrypted_document: "文件受密碼保護",
  limit_exceeded: "文件超出文字擷取上限",
  applicable_period_not_confirmed: "尚未確認適用期間",
  version_not_confirmed: "尚未確認版本關係",
  index_coverage_incomplete: "部分資料尚未完成文字整理",
  candidate_limit: "符合資料過多，請縮小查詢範圍",
};
function denied(error: unknown) {
  return (
    error instanceof Error && ["forbidden", "gone"].includes(error.message)
  );
}
function message(error: unknown) {
  return error instanceof Error && error.message === "forbidden"
    ? "目前無權查看。請回原群組重新開啟，並確認仍是群組成員。"
    : error instanceof Error && error.message === "gone"
      ? "這筆資料或對話已失效，請重新查詢。"
      : "目前無法完成，請稍後再試。";
}
async function request(path: string, body?: unknown): Promise<Response> {
  const token = liff.getIDToken();
  if (!token) throw new Error("forbidden");
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      [401, 403].includes(response.status)
        ? "forbidden"
        : response.status === 410
          ? "gone"
          : "unavailable",
    );
  }
  return response;
}
function clear() {
  generation++;
  results.replaceChildren();
  refresh.hidden = true;
  pickingUp = false;
  refresh.disabled = resetting || !!confirmation;
}
async function download(id: string, name: string) {
  const response = await request(`/api/line/sources/${id}/content`);
  if (!response.body) throw new Error();
  const deadline = Date.parse(
    response.headers.get("X-HHC-Source-Expires-At") ?? "",
  );
  if (!Number.isFinite(deadline) || deadline <= Date.now()) {
    await response.body.cancel();
    throw new Error("gone");
  }
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 200 * 1024 * 1024 || Date.now() >= deadline)
      throw new Error("gone");
    parts.push(chunk);
  }
  const url = URL.createObjectURL(
    new Blob(parts, { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
function render(result: SearchResult) {
  results.replaceChildren();
  status.textContent = result.items.length
    ? `找到 ${result.items.length} 筆相關資料${result.status === "ambiguous" ? "，請確認要找的版本" : ""}。`
    : result.status === "not_found"
      ? "未找到符合的資料，試試其他關鍵字。"
      : result.status === "unavailable"
        ? "文字搜尋暫時無法完成，請稍後重試。"
        : "部分資料仍在整理，請稍後再查。";
  for (const item of result.items) {
    const article = document.createElement("article"),
      title = document.createElement("h2"),
      meta = document.createElement("p"),
      text = document.createElement("p"),
      gaps = document.createElement("p");
    title.textContent = item.name;
    meta.className = "meta";
    meta.textContent = `作者：${item.authorId ?? "未知"} · 發布：${new Date(item.publishedAt).toLocaleString("zh-TW")} · 到期：${new Date(item.expiresAt).toLocaleDateString("zh-TW")}`;
    text.className = "snippet";
    text.textContent = item.snippet;
    gaps.className = "gaps";
    gaps.textContent = [...new Set([...item.gaps, ...result.gaps])]
      .map((x) => labels[x] ?? "部分內容無法確認")
      .join("；");
    article.append(title, meta, text, gaps);
    for (const version of item.versions) {
      const evidence = document.createElement("p");
      evidence.className = "gaps";
      evidence.textContent = `${version.status === "confirmed" ? "已確認版本關係" : "可能的版本關係"}：${version.name}（${version.producer === "model" ? "模型自評，未校準" : "信心"} ${Math.round(version.confidence * 100)}%）\n依據：${version.evidence || "來源連結已記錄"}`;
      article.append(evidence);
    }
    if (item.contentPath) {
      const button = document.createElement("button");
      button.textContent = "下載原件（未掃毒）";
      button.onclick = () => {
        const current = generation;
        button.disabled = true;
        void download(item.id, item.name)
          .catch((e) => {
            if (current !== generation) return;
            clear();
            status.textContent = message(e);
          })
          .finally(() => {
            button.disabled = false;
          });
      };
      article.append(button);
    }
    if (!confirmation && result.proposal?.sourceId === item.id) {
      const draft = result.proposal,
        button = document.createElement("button");
      button.textContent = "預覽變更草稿";
      button.onclick = () => {
        if (confirmation) return;
        const current = generation;
        button.disabled = true;
        void (async () => {
          const edit =
            draft.kind === "delete"
              ? { kind: "delete" }
              : { kind: "description", text: draft.text };
          const preview = (await (
            await request(
              `/api/line/harness/groups/${group}/sources/${item.id}/preview`,
              edit,
            )
          ).json()) as { id: string; token: string; text: string };
          if (current !== generation || !article.isConnected || confirmation)
            return;
          const full = document.createElement("p"),
            confirm = document.createElement("button");
          full.textContent = preview.text;
          confirm.textContent = "確認執行這項變更";
          confirm.onclick = () => {
            if (!confirmation && current !== generation) return;
            if (confirmation && confirmation.id !== preview.id) return;
            confirmationPanel.replaceChildren(full, confirm);
            confirmOperation(
              { id: preview.id, token: preview.token, group },
              confirm,
            );
          };
          article.append(full, confirm);
        })().catch((e) => {
          if (current === generation) {
            clear();
            status.textContent = message(e);
          }
        });
      };
      article.append(button);
    }
    results.append(article);
  }
}
async function pickup() {
  if (pickingUp || resetting || confirmation) return;
  pickingUp = true;
  refresh.disabled = true;
  const current = generation;
  try {
    const value = (await (
      await request(`/api/line/harness/groups/${group}/results/${job}`)
    ).json()) as { state: string; result?: SearchResult };
    if (current !== generation || confirmation) return;
    if (value.result) render(value.result);
    else {
      results.replaceChildren();
      status.textContent =
        value.state === "failed"
          ? "查詢無法完成，請重新搜尋。"
          : "查詢處理中，請稍後點選查看結果。";
    }
    refresh.hidden = value.state === "failed";
  } catch (e) {
    if (current === generation && !confirmation) {
      if (denied(e)) clear();
      else {
        results.replaceChildren();
        refresh.hidden = false;
      }
      status.textContent = message(e);
    }
  } finally {
    if (current === generation) {
      pickingUp = false;
      refresh.disabled = resetting || !!confirmation;
    }
  }
}
form.onsubmit = (event) => {
  event.preventDefault();
  if (submit.disabled || resetting || confirmation) return;
  clear();
  const current = generation;
  submit.disabled = true;
  status.textContent = "正在受理查詢…";
  const kind = document.querySelector<HTMLSelectElement>("#kind")!.value;
  void request(`/api/line/harness/groups/${group}/search`, {
    query: document.querySelector<HTMLInputElement>("#query")!.value,
    ...(kind ? { kind } : {}),
  })
    .then((r) => r.json())
    .then((r: { id: string }) => {
      if (current !== generation) return;
      job = r.id;
      refresh.hidden = false;
      status.textContent = "已受理查詢，點選查看結果。不會另行推播。";
    })
    .catch((e) => {
      if (current === generation) status.textContent = message(e);
    })
    .finally(() => {
      if (current === generation && !resetting) submit.disabled = false;
    });
};
refresh.onclick = () => {
  void pickup();
};
reset.onclick = () => {
  if (resetting || confirmation) return;
  if (!confirm("清除你在本群組的對話與查詢結果？群組原始資料仍會保留。"))
    return;
  clear();
  const current = generation;
  resetting = true;
  reset.disabled = true;
  submit.disabled = true;
  refresh.disabled = true;
  void request(`/api/line/harness/groups/${group}/reset`, {})
    .then(() => {
      if (current !== generation) return;
      job = "";
      status.textContent = "已重設你的對話，可以開始新的查詢。";
    })
    .catch((e) => {
      if (current === generation) status.textContent = message(e);
    })
    .finally(() => {
      if (current !== generation) return;
      resetting = false;
      reset.disabled = false;
      submit.disabled = false;
      refresh.disabled = false;
    });
};
async function initialize() {
  const config = (await (
    await fetch("/api/line/harness/app-config", { cache: "no-store" })
  ).json()) as { liffId: string };
  await liff.init({ liffId: config.liffId });
  const fragment = new URLSearchParams(location.hash.slice(1)),
    query = new URLSearchParams(location.search);
  group = fragment.get("group") ?? query.get("group") ?? "";
  job = fragment.get("result") ?? query.get("result") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(group)) throw new Error("forbidden");
  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }
  if (!liff.getIDToken()) throw new Error("forbidden");
  // Decoded identity scopes local UI storage only; every API request still sends
  // the raw ID token for independent server verification (LINE LIFF API contract).
  const subject = liff.getDecodedIDToken()?.sub;
  if (!subject || !/^U[0-9a-f]{32}$/i.test(subject))
    throw new Error("forbidden");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${config.liffId}:${subject}:${group}`),
  );
  recoveryKey = `hhc-line-harness-edit:${Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("")}`;
  submit.disabled = false;
  reset.disabled = false;
  status.textContent = "輸入關鍵字，搜尋這個群組的資料。";
  restoreConfirmation();
  if (confirmation) return;
  if (/^[0-9a-f-]{36}$/.test(job)) {
    refresh.hidden = false;
    await pickup();
  }
}
void initialize().catch((e) => {
  clear();
  status.textContent = message(e);
});
