import "dotenv/config";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import express from "express";
import { lock } from "proper-lockfile";
import { openDatabase } from "./db.ts";
import { createApi } from "./app.ts";
const port = Number(process.env.PORT || 3200);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("PORT 必须为 1–65535 的整数");
const directory = resolve(process.env.DATA_DIR || ".data");
await mkdir(directory, { recursive: true });
const unlock = await lock(directory, { retries: 0 }).catch(() => {
  console.error(
    "数据目录已被另一个服务占用，请先关闭旧服务；异常退出后等待约10秒再试。",
  );
  process.exit(1);
});
const db = await openDatabase(directory);
await db.query("UPDATE documents SET status='pending' WHERE status='indexing'");
const { app, indexer } = createApi(db);
let closeFrontend: (() => Promise<void>) | undefined;
if (process.argv.includes("--production")) {
  app.use(express.static(resolve("dist")));
  app.get("/", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
  closeFrontend = () => vite.close();
}
const timer = setInterval(
  () =>
    indexer.tick().catch(() => console.error("索引队列暂不可用，将自动重试")),
  1000,
);
const server = app.listen(port, "127.0.0.1", () =>
  console.log("TraceBase: http://localhost:" + port),
);
server.on("error", async (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === "EADDRINUSE"
      ? "端口已被占用，请关闭旧服务或修改 PORT。"
      : "启动失败：" + error.message,
  );
  clearInterval(timer);
  await closeFrontend?.();
  await db.close();
  await unlock();
  process.exitCode = 1;
});
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    indexer.stop();
    clearInterval(timer);
    server.close();
    const timeout = setTimeout(() => process.exit(0), 5000);
    timeout.unref();
    while (indexer.isBusy()) await new Promise((r) => setTimeout(r, 100));
    await closeFrontend?.();
    await db.close();
    await unlock();
    process.exit(0);
  });
