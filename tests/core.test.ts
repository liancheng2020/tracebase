import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, type Database } from "../server/db.ts";
import { tokens, splitText, parseDocument } from "../server/documents.ts";
import { saveDocument, createIndexer } from "../server/library.ts";
import { retrieve, answerQuestion } from "../server/search.ts";
import { validateAnswer, embed, generate } from "../server/models.ts";
import { createApi } from "../server/app.ts";
import type { Evidence } from "../shared/types.ts";
import type { Server } from "node:http";
let db: Database, server: Server, base: string;
const space = randomUUID(),
  other = randomUUID();
let doc: string;
let indexer: ReturnType<typeof createIndexer>;
before(async () => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_MODEL;
  db = await openDatabase();
  await db.query("INSERT INTO spaces(id,name) VALUES($1,$2),($3,$4)", [
    space,
    "测试项目",
    other,
    "隔离项目",
  ]);
  const api = createApi(db);
  indexer = api.indexer;
  server = api.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

test("中文双字与英文术语去重，按标题切分且长段重叠", () => {
  assert.ok(tokens("部署配置 DeepSeek DeepSeek").includes("部署"));
  assert.equal(tokens("Redis redis").length, 1);
  const parts = splitText("# 配置\nPORT=3400\n## 说明\n" + "知识".repeat(900));
  assert.equal(parts[0].heading, "配置");
  assert.equal(parts[0].content, "PORT=3400");
  assert.ok(parts.every((p) => p.content.length <= 850));
  assert.ok(parts.length > 2);
});
test("UTF-8、空文档和非法文件拒绝", async () => {
  assert.equal(
    (await parseDocument("a.md", Buffer.from("# 配置\n测试内容")))[0].heading,
    "配置",
  );
  await assert.rejects(parseDocument("a.txt", Buffer.from([0xff, 0xfe])));
  await assert.rejects(parseDocument("empty.txt", Buffer.from("  ")));
  await assert.rejects(parseDocument("a.pdf", Buffer.from("not pdf")));
  await assert.rejects(parseDocument("a.exe", Buffer.from("abc")));
});
test("文字型 PDF 提取页码和原文", async () => {
  const stream = "BT /F1 12 Tf 72 720 Td (TraceBase PDF test) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += i + 1 + " 0 obj\n" + o + "\nendobj\n";
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF";
  const parts = await parseDocument("fixture.pdf", Buffer.from(pdf));
  assert.equal(parts[0].page, 1);
  assert.match(parts[0].content, /TraceBase PDF test/);
});
test("真实 pgvector 可用且上传进入索引队列", async () => {
  const vector = await db.query<{ distance: number }>(
    "SELECT '[1,0,0]'::vector <=> '[1,0,0]'::vector AS distance",
  );
  assert.equal(vector.rows[0].distance, 0);
  doc = await saveDocument(
    db,
    space,
    "配置.md",
    Buffer.from("# 部署配置\n端口环境变量 PORT 默认为 3400。"),
  );
  await indexer.tick();
  const { rows } = await db.query<{ status: string; active_revision: number }>(
    "SELECT status,active_revision FROM documents WHERE id=$1",
    [doc],
  );
  assert.equal(rows[0].status, "ready");
  assert.equal(rows[0].active_revision, 1);
});
test("检索空间隔离，无 Key 摘录和资料不足拒答", async () => {
  assert.ok((await retrieve(db, space, "部署端口配置")).evidence.length > 0);
  assert.equal((await retrieve(db, other, "部署端口配置")).evidence.length, 0);
  const answer = await answerQuestion(db, space, "部署端口配置");
  assert.equal(answer.mode, "extractive");
  assert.ok(answer.sections[0].citations.length);
  assert.equal(
    (await answerQuestion(db, space, "zxywunknown")).mode,
    "abstain",
  );
});
test("更新成功原子切换，更新失败保留旧版", async () => {
  await saveDocument(
    db,
    space,
    "配置.md",
    Buffer.from("# 部署配置\n端口环境变量 PORT 默认为 4500。"),
    doc,
  );
  assert.match(
    (await retrieve(db, space, "端口配置")).evidence[0].content,
    /3400/,
  );
  await indexer.tick();
  assert.match(
    (await retrieve(db, space, "端口配置")).evidence[0].content,
    /4500/,
  );
  assert.equal((await retrieve(db, space, "端口配置")).evidence[0].revision, 2);
  await saveDocument(db, space, "bad.txt", Buffer.from(""), doc);
  await indexer.tick();
  assert.equal(
    (
      await db.query<{ status: string }>(
        "SELECT status FROM documents WHERE id=$1",
        [doc],
      )
    ).rows[0].status,
    "failed",
  );
  assert.equal((await retrieve(db, space, "端口配置")).evidence[0].revision, 2);
});
test("引用必须存在且逐字匹配原文", () => {
  const evidence = [
    { id: randomUUID(), content: "端口默认为 4500。" },
  ] as Evidence[];
  const sections = [
    {
      text: "端口是 4500。",
      citations: [{ chunkId: evidence[0].id, quote: "端口默认为 4500。" }],
    },
  ];
  assert.equal(validateAnswer({ sections }, evidence).length, 1);
  assert.throws(() =>
    validateAnswer(
      {
        sections: [
          {
            ...sections[0],
            citations: [{ chunkId: randomUUID(), quote: "伪造来源" }],
          },
        ],
      },
      evidence,
    ),
  );
  assert.throws(() =>
    validateAnswer(
      {
        sections: [
          {
            ...sections[0],
            citations: [
              { chunkId: evidence[0].id, quote: "端口默认为 9900。" },
            ],
          },
        ],
      },
      evidence,
    ),
  );
});
test("模拟向量服务验证混合检索及模型切换隔离", async (t) => {
  process.env.EMBEDDING_API_KEY = "test-only";
  process.env.EMBEDDING_BASE_URL = "https://embedding.example/v1";
  process.env.EMBEDDING_MODEL = "fixture-model";
  const mock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const input = JSON.parse(String(init.body)).input;
      return new Response(
        JSON.stringify({
          data: input.map((_: string, index: number) => ({
            index,
            embedding: [1, 0, 0],
          })),
        }),
        { status: 200 },
      );
    },
  );
  try {
    const id = await saveDocument(
      db,
      space,
      "向量.md",
      Buffer.from("# 系统设置\n项目的服务器监听地址可以在配置里指定。"),
    );
    await indexer.tick();
    const result = await retrieve(db, space, "监听地址");
    assert.equal(result.mode, "混合检索 · RRF");
    assert.ok(result.evidence.some((e) => e.document_id === id));
    process.env.EMBEDDING_MODEL = "another-model";
    const changed = await retrieve(db, space, "完全不同问法");
    assert.ok(!changed.mode.startsWith("混合"));
    mock.mock.restore();
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [0, 0, 0] }] }),
          { status: 200 },
        ),
    );
    await assert.rejects(embed(["query"]));
  } finally {
    t.mock.restoreAll();
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
  }
});
test("HTTP 拒绝跨站与空间越界，反馈及删除同时清理索引和回答", async () => {
  const cross = await fetch(base + "/api/spaces", {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(cross.status, 403);
  const denied = await fetch(
    base + "/api/spaces/" + other + "/documents/" + doc,
  );
  assert.equal(denied.status, 404);
  const answer = await answerQuestion(db, space, "端口配置");
  const response = await fetch(
    base + "/api/spaces/" + space + "/answers/" + answer.id + "/feedback",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "incorrect", note: "测试反馈" }),
    },
  );
  assert.equal(response.status, 200);
  const deleted = await fetch(
    base + "/api/spaces/" + space + "/documents/" + doc,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 200);
  assert.equal(
    (await db.query("SELECT id FROM chunks WHERE document_id=$1", [doc])).rows
      .length,
    0,
  );
  assert.equal(
    (await db.query("SELECT * FROM revisions WHERE document_id=$1", [doc])).rows
      .length,
    0,
  );
  assert.equal(
    (await db.query("SELECT id FROM answers WHERE id=$1", [answer.id])).rows
      .length,
    0,
  );
});

test("DeepSeek 模拟成功与异常均保留可追溯降级", async (t) => {
  const evidence = [
    { id: randomUUID(), content: "端口默认是 4500。" },
  ] as Evidence[];
  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-only";
  try {
    let invalid = false;
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        assert.equal(body.model, "deepseek-chat");
        assert.match(body.messages[0].content, /不可信数据/);
        const content = invalid
          ? "not-json"
          : JSON.stringify({
              status: "answered",
              sections: [
                {
                  text: "默认端口为4500。",
                  title: "结论",
                  references: ["S1F1"],
                },
              ],
            });
        return new Response(
          JSON.stringify({ choices: [{ message: { content } }] }),
          { status: 200 },
        );
      },
    );
    assert.equal((await generate("端口是什么", evidence)).sections?.length, 1);
    invalid = true;
    const fallback = await generate("端口是什么", evidence);
    assert.equal(fallback.sections, null);
    assert.match(fallback.notice, /回退/);
  } finally {
    t.mock.restoreAll();
    if (saved) process.env.DEEPSEEK_API_KEY = saved;
    else delete process.env.DEEPSEEK_API_KEY;
  }
});
