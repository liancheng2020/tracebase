// npm run build && npx tsx scripts/record-demo.ts
// Isolated in-memory database, synthetic documents, no user credentials.
import { chromium } from "playwright";
import express from "express";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../server/db.ts";
import { createApi } from "../server/app.ts";
import { saveDocument } from "../server/library.ts";

delete process.env.DEEPSEEK_API_KEY;
delete process.env.EMBEDDING_API_KEY;
const encoder = process.env.FFMPEG_PATH || "ffmpeg";
assert.match(
  execFileSync(encoder, ["-hide_banner", "-encoders"], {
    encoding: "utf8",
    windowsHide: true,
  }),
  /libx264/,
);
const output = resolve("docs/media");
const scratch = await mkdtemp(join(tmpdir(), "tracebase-recording-"));
await mkdir(output, { recursive: true });
const db = await openDatabase();
const { app, indexer } = createApi(db);
app.use(express.static(resolve("dist")));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || "msedge",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: scratch, size: { width: 1440, height: 1000 } },
  reducedMotion: "reduce",
});
let timer: ReturnType<typeof setInterval> | undefined;
let completed = false;
const page = await context.newPage();
const video = page.video()!;
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(20000);
const pause = (ms = 2200) => page.waitForTimeout(ms);
async function chapter(text: string) {
  console.log(text);
  await page.evaluate((text) => {
    let caption = document.getElementById("recording-caption");
    if (!caption) {
      caption = document.createElement("div");
      caption.id = "recording-caption";
      caption.style.cssText =
        "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;background:#173d32f2;color:white;padding:13px 26px;border-radius:12px;font:500 18px 'Microsoft Yahei',sans-serif;box-shadow:0 6px 24px #0002;pointer-events:none;white-space:nowrap";
      document.body.append(caption);
    }
    caption.textContent = text;
  }, text);
  await pause(1000);
}
async function screenshot(name: string) {
  await page.locator("#recording-caption").evaluate((el) => {
    (el as HTMLElement).style.visibility = "hidden";
  });
  await page.screenshot({ path: join(output, name) });
  await page.locator("#recording-caption").evaluate((el) => {
    (el as HTMLElement).style.visibility = "visible";
  });
}
try {
  const makeLibrary = async (name: string) => {
    const response = await context.request.post(base + "/api/spaces", {
      data: { name },
    });
    assert.equal(response.status(), 201);
    return (await response.json()).id as string;
  };
  await makeLibrary("星桥 · 项目手册");
  const prototype = await makeLibrary("产品原型 · 示例资料");
  await saveDocument(
    db,
    prototype,
    "任务创建原型.html",
    Buffer.from(
      '<!doctype html><title>任务创建原型（虚构示例）</title><main><h1>任务创建</h1><p>此原型为演示资料，不代表真实业务。</p><label>任务名称</label><input placeholder="请输入任务名称"><label>负责人</label><input placeholder="选择负责人"><button>保存任务</button></main>',
    ),
  );
  await indexer.tick();
  timer = setInterval(() => void indexer.tick(), 200);
  await page.goto(base);
  await page.locator(".library-card").first().waitFor();
  await chapter("01 / 知识空间：集中管理多个知识库");
  await pause();
  await page.locator(".library-card").filter({ hasText: "星桥" }).click();
  await chapter("02 / 导入示例资料：真实解析、自动索引");
  await page.getByRole("button", { name: "从示例开始", exact: true }).click();
  await page.getByText("已就绪", { exact: true }).waitFor();
  await pause();
  await screenshot("tracebase-documents.png");
  await page.locator("nav").getByRole("button", { name: "知识空间" }).click();
  await screenshot("tracebase-libraries.png");
  await pause();
  await page.locator("nav").getByRole("button", { name: "问答工作台" }).click();
  await chapter("03 / 统一问答：从全部知识库中寻找依据");
  await page
    .getByLabel("你的问题")
    .pressSequentially("星桥项目的 PORT 和 DATA_DIR 默认值是什么？", {
      delay: 65,
    });
  await pause(1000);
  await page.getByRole("button", { name: "提问 ↗", exact: true }).click();
  await page.locator(".answer-card").waitFor();
  assert.match(await page.locator(".answer-card").innerText(), /3400/);
  await chapter("无 Key 演示：展示检索原文，不伪造模型解读");
  await page.locator(".answer-card").scrollIntoViewIfNeeded();
  await pause(3000);
  await screenshot("tracebase-answer.png");
  await page.locator(".citation").first().click();
  await page.locator(".source-chunk.selected").waitFor();
  await chapter("04 / 点击引用：核对来源知识库与原文上下文");
  await pause(3500);
  await screenshot("tracebase-demo-poster.png");
  await page.getByRole("button", { name: "关闭原文" }).click();
  await page.locator(".feedback").scrollIntoViewIfNeeded();
  await chapter("05 / 提交反馈：保留需要人工核实的问题");
  await page.getByRole("button", { name: "不准确", exact: true }).click();
  await page
    .getByLabel("反馈说明")
    .pressSequentially("演示反馈：请人工复核部署环境是否适用。", { delay: 65 });
  await page.getByRole("button", { name: "提交反馈", exact: true }).click();
  await page.getByText("反馈已保存", { exact: true }).waitFor();
  await pause();
  await page.locator("nav").getByRole("button", { name: "知识健康" }).click();
  await chapter("06 / 知识健康：统一查看索引状态与反馈");
  await page
    .getByText("反馈：演示反馈：请人工复核部署环境是否适用。", { exact: true })
    .waitFor();
  await pause(3000);
  await screenshot("tracebase-health.png");
  assert.deepEqual(errors, []);
  completed = true;
} finally {
  clearInterval(timer);
  indexer.stop();
  await context.close();
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  while (indexer.isBusy()) await new Promise((r) => setTimeout(r, 50));
  await db.close();
}
if (completed) {
  const pending = join(scratch, "tracebase-demo.mp4");
  execFileSync(
    encoder,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      await video.path(),
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-movflags",
      "+faststart",
      pending,
    ],
    { windowsHide: true, stdio: "inherit" },
  );
  const staged = join(output, "tracebase-demo.tmp.mp4");
  await copyFile(pending, staged);
  await rename(staged, join(output, "tracebase-demo.mp4"));
  console.log(
    "Saved MP4 and screenshots to docs/media; raw recording: " + scratch,
  );
}
