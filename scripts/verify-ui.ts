import { chromium } from "playwright";
import express from "express";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.ts";
import { createApi } from "../server/app.ts";
// Real API + real in-memory PostgreSQL. No user documents or paid model calls.
delete process.env.DEEPSEEK_API_KEY;
delete process.env.EMBEDDING_API_KEY;
const db = await openDatabase();
const { app, indexer } = createApi(db);
app.use(express.static(resolve("dist")));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
const timer = setInterval(() => void indexer.tick(), 100);
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || "msedge",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  assert.doesNotMatch(await page.locator(".brand").innerText(), /LOCAL/);
  await page.getByRole("button", { name: "创建第一个知识空间" }).click();
  await page.getByLabel("空间名称").fill("星桥 · 项目知识");
  await page.getByRole("button", { name: "创建空间", exact: true }).click();
  await page.getByRole("button", { name: "从示例开始", exact: true }).click();
  await page.getByText("已就绪", { exact: true }).waitFor({ timeout: 20000 });
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/library.png", fullPage: true });
  await page.locator("nav").getByRole("button", { name: "问答工作台" }).click();
  await page
    .getByLabel("你的问题")
    .fill("这个项目部署时需要配置哪些环境变量？");
  await page.getByRole("button", { name: "提问 ↗", exact: true }).click();
  await page
    .getByText("原文摘录 · 非生成回答", { exact: true })
    .first()
    .waitFor();
  assert.match(await page.locator(".answer-card").innerText(), /PORT/);
  const cards = await page.evaluate(() => {
    const left = document
      .querySelector(".answer-card")!
      .getBoundingClientRect();
    const right = document.querySelector(".history")!.getBoundingClientRect();
    return {
      heightDifference: Math.abs(left.height - right.height),
      rightWidth: right.width,
    };
  });
  assert.ok(cards.heightDifference < 1);
  assert.ok(cards.rightWidth >= 280);
  await page.locator("nav").getByRole("button", { name: "知识空间" }).click();
  await page.locator("nav").getByRole("button", { name: "问答工作台" }).click();
  await page.locator(".history > button").first().waitFor();
  assert.equal(await page.getByLabel("你的问题").inputValue(), "");
  assert.equal(await page.locator(".answer-card").count(), 0);
  await page.getByText("从一个具体问题开始", { exact: true }).waitFor();
  const emptyCards = await page.evaluate(() =>
    Math.abs(
      document.querySelector(".answer-column > .card")!.getBoundingClientRect()
        .height -
        document.querySelector(".history")!.getBoundingClientRect().height,
    ),
  );
  assert.ok(emptyCards < 1);
  await page.locator(".history > button").first().click();
  await page.locator(".answer-card").waitFor();
  await page.locator(".citation").first().click();
  await page.locator(".source-chunk.selected").waitFor();
  assert.match(
    await page.locator(".source-chunk.selected").innerText(),
    /环境变量|部署/,
  );
  await page.screenshot({ path: "artifacts/answer.png", fullPage: true });
  await page.getByRole("button", { name: "关闭原文" }).click();
  let feedbackPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/feedback"))
      feedbackPosts++;
  });
  await page.getByRole("button", { name: "不准确", exact: true }).click();
  const feedbackSubmit = page.locator('.feedback button[type="submit"]');
  await page.getByLabel("反馈说明").fill("希望补充配置示例");
  await page.getByText("修改尚未提交", { exact: true }).waitFor();
  // Selection and typing alone must not persist feedback.
  assert.equal(feedbackPosts, 0);
  let feedbackRequests = 0;
  await page.route("**/answers/*/feedback", async (route) => {
    feedbackRequests++;
    if (feedbackRequests === 1) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "测试保存失败" }),
      });
    } else {
      await route.continue();
    }
  });
  await feedbackSubmit.click();
  await page.locator(".feedback [role=alert]").waitFor();
  assert.equal(
    await page.getByLabel("反馈说明").inputValue(),
    "希望补充配置示例",
  );
  await feedbackSubmit.click();
  await page.getByText("反馈已保存", { exact: true }).waitFor();
  assert.equal(await feedbackSubmit.isDisabled(), true);
  assert.equal(await feedbackSubmit.innerText(), "已保存");
  assert.equal(await feedbackSubmit.getAttribute("aria-busy"), "false");
  assert.equal(
    await feedbackSubmit.evaluate((el) => getComputedStyle(el).cursor),
    "not-allowed",
  );
  assert.equal(feedbackRequests, 2);
  await page.unroute("**/answers/*/feedback");
  await page.locator("nav").getByRole("button", { name: "知识空间" }).click();
  await page.locator("nav").getByRole("button", { name: "问答工作台" }).click();
  await page.locator(".history > button").first().click();
  assert.equal(
    await page.getByLabel("反馈说明").inputValue(),
    "希望补充配置示例",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "不准确", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.getByLabel("反馈说明").fill("希望补充完整配置示例");
  let refreshRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /\/(spaces|documents|answers)$/.test(request.url())
    )
      refreshRequests++;
  });
  await feedbackSubmit.click();
  await page.getByText("反馈已保存", { exact: true }).waitFor();
  // Observe more than two polling intervals: idle feedback must not refresh lists.
  await page.waitForTimeout(5500);
  assert.equal(refreshRequests, 0, "保存反馈后不应持续请求列表");
  const postsBeforeTimeout = feedbackPosts;
  await page.route("**/answers/*/feedback", () => {});
  await page.getByLabel("反馈说明").fill("超时后保留的说明");
  assert.equal(await feedbackSubmit.innerText(), "提交反馈");
  assert.equal(
    await feedbackSubmit.evaluate((el) => getComputedStyle(el).cursor),
    "pointer",
  );
  await feedbackSubmit.click();
  const savingButton = page.locator(
    '.feedback button[type="submit"][aria-busy="true"]',
  );
  await savingButton.waitFor();
  assert.equal(await savingButton.innerText(), "提交中…");
  assert.equal(
    await savingButton.evaluate((el) => getComputedStyle(el).cursor),
    "wait",
  );
  await page
    .locator(".feedback [role=alert]")
    .filter({ hasText: "请求超时" })
    .waitFor({ timeout: 15000 });
  assert.equal(await feedbackSubmit.isEnabled(), true);
  assert.equal(feedbackPosts, postsBeforeTimeout + 1, "超时不应自动重复提交");
  assert.equal(
    await page.getByLabel("反馈说明").inputValue(),
    "超时后保留的说明",
  );
  await page.unroute("**/answers/*/feedback");
  await feedbackSubmit.click();
  await page.getByText("反馈已保存", { exact: true }).waitFor();
  await page.locator("nav").getByRole("button", { name: "知识健康" }).click();
  await page.getByText("反馈：超时后保留的说明", { exact: true }).waitFor();
  await page
    .getByText("这个项目部署时需要配置哪些环境变量？", { exact: true })
    .waitFor();
  await page.locator("nav").getByRole("button", { name: "知识空间" }).click();
  // Update and verify the new revision is committed, not mixed with old chunks.
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "更新", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "修订.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      '<!doctype html><title>部署原型</title><nav>导航噪声</nav><main><h1>部署配置 {{ title }}</h1><p>PORT 默认改为 5600。此文档是 UI 测试版本。{{ config.name }}</p></main><script>throw Error("不得执行原型代码")</script>',
    ),
  });
  await page.getByText(/v2 ·/).waitFor();
  await page.getByText("已就绪", { exact: true }).waitFor();
  await page.locator("nav").getByRole("button", { name: "问答工作台" }).click();
  await page.getByLabel("你的问题").fill("部署端口 PORT 配置");
  await page.getByRole("button", { name: "提问 ↗", exact: true }).click();
  await page
    .getByText("原文摘录 · 非生成回答", { exact: true })
    .first()
    .waitFor();
  assert.match(await page.locator(".answer-card").innerText(), /5600/);
  assert.match(
    await page.locator(".answer-card").innerText(),
    /静态提取可能不完整/,
  );
  assert.doesNotMatch(
    await page.locator(".answer-card").innerText(),
    /导航噪声|config.name|\{\{/,
  );
  await page.locator(".citation").first().click();
  await page
    .locator(".evidence-panel")
    .getByText(/静态提取可能不完整/)
    .waitFor();
  await page.getByRole("button", { name: "关闭原文" }).click();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: "artifacts/answer-" + width + ".png",
      fullPage: true,
    });
  }
  await page.locator("nav").getByRole("button", { name: "知识空间" }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByRole("button", { name: "从示例开始", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: create, import, index, ask, source, feedback, update, delete, responsive layouts; no page errors",
  );
} finally {
  clearInterval(timer);
  indexer.stop();
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  while (indexer.isBusy()) await new Promise((r) => setTimeout(r, 50));
  await db.close();
}
