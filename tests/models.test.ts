import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generate, validateModelResult } from "../server/models.ts";
import type { Evidence } from "../shared/types.ts";
import { openDatabase } from "../server/db.ts";
import { createIndexer, saveDocument } from "../server/library.ts";
import { answerQuestion } from "../server/search.ts";
const evidence: Evidence[] = [
  {
    id: randomUUID(),
    document_id: randomUUID(),
    revision: 1,
    title: "测试",
    heading: "设置",
    page: null,
    content: "投票设置包含标题和截止时间。",
    score: 1,
  },
];
const valid = {
  status: "answered",
  sections: [
    {
      text: "包含标题和截止时间。",
      title: "结论",
      references: ["S1F1"],
    },
  ],
};
const response = (value: unknown, finish = "stop") =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: finish,
          message: {
            content: typeof value === "string" ? value : JSON.stringify(value),
          },
        },
      ],
    }),
  );

test("片段编号回填真实引文，拒绝模型自写引文和伪造来源", () => {
  assert.equal(
    validateModelResult(valid, evidence).sections[0].citations[0].chunkId,
    evidence[0].id,
  );
  assert.throws(
    () =>
      validateModelResult(
        {
          ...valid,
          sections: [
            {
              ...valid.sections[0],
              references: ["S2F1"],
            },
          ],
        },
        evidence,
      ),
    /不存在/,
  );
  assert.throws(() =>
    validateModelResult(
      {
        ...valid,
        sections: [
          {
            ...valid.sections[0],
            citations: [
              { sourceId: "S1", quote: "投票设置包含标题、头像和截止时间。" },
            ],
          },
        ],
      },
      evidence,
    ),
  );
  assert.throws(() =>
    validateModelResult(
      { status: "insufficient", sections: valid.sections },
      evidence,
    ),
  );
  assert.throws(() =>
    validateModelResult(
      { status: "insufficient", sections: [], text: "编造字段" },
      evidence,
    ),
  );
});

test("HTTP、网络、超时、格式、截断与引用错误分别提示，绝不泄漏上游正文", async (t) => {
  process.env.DEEPSEEK_API_KEY = "test-only";
  delete process.env.DEEPSEEK_BASE_URL;
  const cases: Array<{ code: string; request: () => Promise<Response> }> = [
    ...[401, 402, 403, 404, 429, 500].map((status) => ({
      code: "http_" + status,
      request: async () => new Response("secret-upstream", { status }),
    })),
    {
      code: "network",
      request: async () => {
        throw new TypeError("secret-network");
      },
    },
    {
      code: "timeout",
      request: async () => {
        throw new DOMException("secret-timeout", "TimeoutError");
      },
    },
    { code: "response_format", request: async () => new Response("not json") },
    { code: "output_format", request: async () => response("not json") },
    { code: "output_schema", request: async () => response({ sections: [] }) },
    { code: "truncated", request: async () => response(valid, "length") },
    {
      code: "citation_source",
      request: async () =>
        response({
          ...valid,
          sections: [
            {
              text: "说明",
              title: "结论",
              references: ["S2F1"],
            },
          ],
        }),
    },
    {
      code: "output_schema",
      request: async () =>
        response({
          ...valid,
          sections: [
            {
              text: "说明",
              citations: [{ sourceId: "S1", quote: "并不存在的字段" }],
            },
          ],
        }),
    },
  ];
  try {
    for (const item of cases) {
      const mock = t.mock.method(globalThis, "fetch", item.request);
      const result = await generate("投票设置有哪些", evidence);
      assert.equal(result.status, "fallback");
      assert.equal("errorCode" in result ? result.errorCode : null, item.code);
      assert.match(result.notice, /回退/);
      assert.doesNotMatch(result.notice, /secret-|模型不可用或/);
      mock.mock.restore();
    }
  } finally {
    t.mock.restoreAll();
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("证据不足作为正常拒答保存，不回退摘录或输出未验证内容", async (t) => {
  delete process.env.EMBEDDING_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-only";
  const db = await openDatabase(),
    space = randomUUID();
  try {
    await db.query("INSERT INTO spaces(id,name) VALUES($1,$2)", [
      space,
      "fixture",
    ]);
    await saveDocument(
      db,
      space,
      "menu.txt",
      Buffer.from("直播管理\n投票设置\n操作日志"),
    );
    await createIndexer(db).tick();
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const input = JSON.parse(body.messages[1].content);
        assert.equal(input.evidence[0].sourceId, "S1");
        assert.equal(input.evidence[0].id, undefined);
        assert.match(body.messages[0].content, /菜单名称/);
        return response({ status: "insufficient", sections: [] });
      },
    );
    const answer = await answerQuestion(db, space, "投票设置包含哪些字段");
    assert.equal(answer.mode, "abstain");
    assert.deepEqual(answer.sections, []);
    assert.match(answer.notice, /无法确认/);
    assert.doesNotMatch(answer.notice, /模型不可用|回退/);
    assert.ok(answer.evidence.length);
    const stored = await db.query<{
      payload: { mode: string; sections: unknown[] };
    }>("SELECT payload FROM answers WHERE id=$1", [answer.id]);
    assert.equal(stored.rows[0].payload.mode, "abstain");
    assert.deepEqual(stored.rows[0].payload.sections, []);
  } finally {
    t.mock.restoreAll();
    delete process.env.DEEPSEEK_API_KEY;
    await db.close();
  }
});
