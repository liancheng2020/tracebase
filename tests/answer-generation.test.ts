import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generate, validateModelResult } from "../server/models.ts";
import { prepareEvidence, answerPrompt } from "../server/answer-evidence.ts";
import type { Evidence } from "../shared/types.ts";
const evidence: Evidence[] = [
  {
    id: randomUUID(),
    document_id: randomUUID(),
    revision: 1,
    title: "设备需求",
    heading: "设备绑定",
    page: null,
    content: "关联设备组数量替换设备组名称。\n删除逻辑本次不做调整。",
    score: 1,
  },
];
const valid = {
  status: "answered",
  sections: [
    {
      title: "结论",
      text: "调整设备组展示，删除逻辑保持不变。",
      references: ["S1F1"],
    },
  ],
};
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(value) } },
      ],
    }),
  );

test("JSON 输出模式提示词满足 DeepSeek 接口前置约束", () => {
  assert.match(answerPrompt, /json/i);
});

test("长文本保留空白换行，片段逐字回溯且不跨来源合并", () => {
  const sources = [
    evidence[0],
    {
      ...evidence[0],
      id: randomUUID(),
      space_name: "另一知识库",
      content: "原文 保留空格。\n".repeat(170) + "尾部说明",
    },
  ];
  const prepared = prepareEvidence(sources);
  assert.equal(prepared[1].knowledgeBase, "另一知识库");
  assert.ok(prepared[1].fragments.length > 1);
  for (const [index, source] of prepared.entries())
    for (const fragment of source.fragments) {
      assert.ok(sources[index].content.includes(fragment.content));
      assert.ok(fragment.content.length <= 600);
    }
  const selected = prepared[1].fragments.at(-1)!;
  const result = validateModelResult(
    {
      ...valid,
      sections: [
        { ...valid.sections[0], references: [selected.id, selected.id] },
      ],
    },
    sources,
  );
  assert.equal(result.sections[0].citations.length, 1);
  assert.equal(result.sections[0].citations[0].chunkId, sources[1].id);
  assert.equal(result.sections[0].citations[0].quote, selected.content);
});

test("先结论且标题不重复，空引用和伪造片段均拒绝", () => {
  for (const sections of [
    [{ ...valid.sections[0], title: "具体改动" }],
    [valid.sections[0], valid.sections[0]],
    [{ ...valid.sections[0], references: [] }],
    [{ ...valid.sections[0], references: ["S1F999"] }],
  ])
    assert.throws(() =>
      validateModelResult({ status: "answered", sections }, evidence),
    );
});

test("引用失败修复一次，成功结果回填原文并保留标题", async (t) => {
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-only";
  let calls = 0;
  const progress: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.response_format.type, "json_object");
      assert.ok(
        body.messages.some((message: { content: string }) =>
          /json/i.test(message.content),
        ),
      );
      assert.equal(
        JSON.parse(body.messages[1].content).evidence[0].fragments[0].id,
        "S1F1",
      );
      calls++;
      if (calls === 1)
        return response({
          ...valid,
          sections: [{ ...valid.sections[0], references: ["S2F1"] }],
        });
      assert.match(body.messages.at(-1).content, /不存在/);
      return response(valid);
    },
  );
  try {
    const result = await generate("设备绑定有哪些改动", evidence, (message) =>
      progress.push(message),
    );
    assert.equal(result.status, "answered");
    assert.equal(calls, 2);
    assert.equal(progress.length, 1);
    assert.equal(result.sections?.[0].citations[0].quote, evidence[0].content);
    assert.equal(result.sections?.[0].title, "结论");
  } finally {
    t.mock.restoreAll();
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldKey;
  }
});

test("持续引用错误最多两次，认证失败只调用一次且不输出无效回答", async (t) => {
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-only";
  try {
    for (const status of [200, 401]) {
      let calls = 0;
      const mock = t.mock.method(globalThis, "fetch", async () => {
        calls++;
        return status === 200
          ? response({
              ...valid,
              sections: [{ ...valid.sections[0], references: ["S1F99"] }],
            })
          : new Response("private", { status });
      });
      const result = await generate("设备绑定", evidence);
      assert.equal(result.status, "fallback");
      assert.equal(result.sections, null);
      assert.equal(calls, status === 200 ? 2 : 1);
      assert.doesNotMatch(result.notice, /private/);
      mock.mock.restore();
    }
  } finally {
    t.mock.restoreAll();
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldKey;
  }
});
