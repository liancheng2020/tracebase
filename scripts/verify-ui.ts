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
  await page.locator(".citation").first().click();
  await page.locator(".source-chunk.selected").waitFor();
  assert.match(
    await page.locator(".source-chunk.selected").innerText(),
    /环境变量|部署/,
  );
  await page.screenshot({ path: "artifacts/answer.png", fullPage: true });
  await page.getByRole("button", { name: "关闭原文" }).click();
  await page.getByRole("button", { name: "不准确", exact: true }).click();
  await page.locator("nav").getByRole("button", { name: "知识健康" }).click();
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
      '<!doctype html><title>部署原型</title><h1>部署配置</h1><p>PORT 默认改为 5600。此文档是 UI 测试版本。</p><script>throw Error("不得执行原型代码")</script>',
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
