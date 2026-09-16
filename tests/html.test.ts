import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseDocument } from "../server/documents.ts";
import { openDatabase } from "../server/db.ts";
import { createApi } from "../server/app.ts";
import { extractHtml, stripTemplates } from "../server/html.ts";
import { saveDocument } from "../server/library.ts";
import { retrieve, answerQuestion } from "../server/search.ts";

const prototype =
  '<!doctype html><html><head><title>设备管理原型</title><style>ignored-css</style></head><body><h1>设备分组</h1><p>支持<strong>批量</strong>添加 &amp; 删除设备。</p><h2>新增分组</h2><label>分组名称<input placeholder="请输入名称"></label><button onclick="ignored-event()">保存分组</button><table><tr><th>字段</th><th>规则</th></tr><tr><td>名称</td><td>最多20字</td></tr></table><img src="https://example.invalid/image.png" alt="设备列表示意"><script>throw Error("ignored-script")</script><iframe src="https://example.invalid">ignored-frame</iframe><p hidden>ignored-hidden</p><p style="display: none">ignored-style</p><input type="PASSWORD" value="ignored-password"></body></html>';

test("HTML/HTM 保留标题、表单、按钮、表格及实体，剔除可执行和隐藏内容", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw Error("HTML parser must not request network");
  });
  for (const name of ["prototype.html", "prototype.HTM"]) {
    const parts = await parseDocument(name, Buffer.from(prototype));
    const text = parts.map((p) => p.heading + "\n" + p.content).join("\n");
    for (const value of [
      "设备管理原型",
      "设备分组",
      "批量",
      "&",
      "请输入名称",
      "保存分组",
      "最多20字",
      "设备列表示意",
    ])
      assert.ok(text.includes(value), value);
    assert.ok(!text.includes("ignored-"));
    assert.ok(!text.includes("example.invalid"));
    assert.ok(parts.some((p) => p.heading === "新增分组"));
  }
});

test("HTML 不把纯脚本页面或标题当正文；拒绝无效编码与超长正文", async () => {
  await assert.rejects(
    parseDocument(
      "app.html",
      Buffer.from(
        '<title>原型</title><div id="app"></div><script>document.body.textContent="动态正文"</script>',
      ),
    ),
    /静态正文/,
  );
  await assert.rejects(parseDocument("bad.html", Buffer.from([0xff])), /UTF-8/);
  await assert.rejects(
    parseDocument(
      "large.html",
      Buffer.from("<p>" + "字".repeat(150001) + "</p>"),
    ),
    /15 万/,
  );
});

test("HTML multipart 上传、索引、检索与失败更新保留旧版", async () => {
  delete process.env.EMBEDDING_API_KEY;
  const db = await openDatabase(),
    space = randomUUID();
  await db.query("INSERT INTO spaces(id,name) VALUES($1,$2)", [
    space,
    "HTML fixture",
  ]);
  const { app, indexer } = createApi(db);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  try {
    const upload = async (body: string, id?: string) => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([body], { type: "text/html" }),
        "prototype.html",
      );
      return fetch(
        base + "/api/spaces/" + space + "/documents" + (id ? "/" + id : ""),
        { method: id ? "PUT" : "POST", body: form },
      );
    };
    const response = await upload(prototype);
    assert.equal(response.status, 202);
    const { id } = await response.json();
    await indexer.tick();
    const found = await retrieve(db, space, "新增分组名称规则");
    assert.ok(found.evidence.some((e) => e.content.includes("最多20字")));
    await upload("<script>dynamic()</script>", id);
    await indexer.tick();
    const { rows } = await db.query<{
      status: string;
      active_revision: number;
      error: string;
    }>("SELECT status,active_revision,error FROM documents WHERE id=$1", [id]);
    assert.equal(rows[0].status, "failed");
    assert.equal(rows[0].active_revision, 1);
    assert.match(rows[0].error, /静态正文/);
    assert.ok((await retrieve(db, space, "新增分组名称规则")).evidence.length);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});

test("模板表达式清洗保留标签文案，支持嵌套对象、引号及跨行", () => {
  assert.equal(
    stripTemplates(
      '名称：{{ bizConfig.name }}，状态：{{ active ? "运行中" : "停用" }}',
    ),
    "名称：，状态：",
  );
  assert.equal(
    stripTemplates('前{{ JSON.stringify({a: "}}", b: {c: 1}}) }}后'),
    "前后",
  );
  assert.equal(stripTemplates("前{{\n name\n}}后"), "前后");
  const result = extractHtml(
    '<title>直播 {{ name }}</title><nav>导航噪声</nav><div class="sidebar">侧栏噪声</div><main><h1>直播设置 {{ name }}</h1><p>允许直播录制</p><input placeholder="搜索 {{ keyword }}"><div>{{bizConfig.name}}</div><span>&#123;&#123;f.label&#125;&#125;</span></main>',
  );
  assert.match(result.text, /直播设置/);
  assert.match(result.text, /允许直播录制/);
  assert.match(result.text, /搜索/);
  assert.doesNotMatch(
    result.text,
    /导航噪声|侧栏噪声|\{\{|bizConfig|f.label|keyword/,
  );
  assert.match(result.warning!, /静态提取可能不完整/);
});

test("导航去噪不误删正文中的菜单说明或未知布局里的侧栏", () => {
  const html =
    '<nav>顶部菜单噪声</nav><main><header>设置说明</header><aside class="sidebar">直播菜单包含录制功能</aside><p>菜单中可以调整直播权限</p></main>';
  const result = extractHtml(html);
  assert.doesNotMatch(result.text, /顶部菜单噪声/);
  assert.match(result.text, /直播菜单包含录制功能/);
  assert.match(result.text, /设置说明/);
  assert.equal(result.warning, null);
  assert.match(
    extractHtml('<div class="sidebar">原型的完整需求说明</div>').text,
    /完整需求说明/,
  );
  assert.throws(
    () => extractHtml("<title>原型</title><main>{{ onlyDynamic }}</main>"),
    /静态正文/,
  );
  assert.match(
    extractHtml('<main><p v-text="name">显示名称</p></main>').warning!,
    /静态提取可能不完整/,
  );
});

test("动态警告随有效版本传递至文档、引用、问答，更新失败保留、静态更新清除", async () => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.EMBEDDING_API_KEY;
  const db = await openDatabase(),
    space = randomUUID();
  await db.query("INSERT INTO spaces(id,name) VALUES($1,$2)", [
    space,
    "动态原型",
  ]);
  const { indexer } = createApi(db);
  try {
    const id = await saveDocument(
      db,
      space,
      "live.html",
      Buffer.from(
        "<main><h1>直播设置</h1><p>支持录制、评论管理</p><p>{{ config }}</p></main>",
      ),
    );
    await indexer.tick();
    const doc = await db.query<{ extraction_warning: string }>(
      "SELECT extraction_warning FROM documents WHERE id=$1",
      [id],
    );
    assert.match(doc.rows[0].extraction_warning, /静态提取可能不完整/);
    const answer = await answerQuestion(db, space, "直播设置");
    assert.match(answer.notice, /静态提取可能不完整/);
    assert.match(answer.evidence[0].extraction_warning!, /静态提取可能不完整/);
    assert.doesNotMatch(answer.sections[0].text, /\{\{/);
    await saveDocument(
      db,
      space,
      "live.html",
      Buffer.from("<main>{{ nothing }}</main>"),
      id,
    );
    await indexer.tick();
    assert.match(
      (await retrieve(db, space, "直播设置")).evidence[0].extraction_warning!,
      /静态提取可能不完整/,
    );
    await saveDocument(
      db,
      space,
      "live.html",
      Buffer.from("<main><h1>直播设置</h1><p>支持录制、评论管理</p></main>"),
      id,
    );
    await indexer.tick();
    assert.equal(
      (await retrieve(db, space, "直播设置")).evidence[0].extraction_warning,
      null,
    );
  } finally {
    await db.close();
  }
});
