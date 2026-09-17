import { createHash } from "node:crypto";
import { z } from "zod";
import type { Evidence, Section } from "../shared/types.ts";
import {
  prepareEvidence,
  structuredAnswerSchema,
  answerPrompt,
} from "./answer-evidence.ts";
export function embeddingConfig() {
  const base = process.env.EMBEDDING_BASE_URL?.trim(),
    model = process.env.EMBEDDING_MODEL?.trim(),
    key = process.env.EMBEDDING_API_KEY?.trim();
  if (!base || !model || !key) return null;
  return {
    base,
    model,
    key,
    tag: createHash("sha256")
      .update(base + "|" + model)
      .digest("hex"),
  };
}
class ModelError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
async function request(base: string, path: string, key: string, body: unknown) {
  let url: URL;
  try {
    url = new URL(base.trim().replace(/\/$/, "") + path);
  } catch {
    throw new ModelError("endpoint", "模型地址格式不正确，请检查 BASE_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ModelError(
      "endpoint",
      "模型地址必须为无凭据、查询参数的 HTTPS 地址",
    );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      ["TimeoutError", "AbortError"].includes(error.name)
    )
      throw new ModelError("timeout", "模型请求超时（30秒），请稍后重试");
    throw new ModelError("network", "无法连接模型服务，请检查网络连接");
  }
  if (!response.ok) {
    await response.body?.cancel();
    const messages: Record<number, string> = {
      400: "模型请求参数不符合接口要求（400），请检查模型名、输出格式及提示词约束",
      401: "DeepSeek 认证失败（401），请检查 API Key 并重启服务",
      402: "DeepSeek 余额不足（402），请检查账户余额",
      403: "DeepSeek 拒绝访问（403），请检查账户权限",
      404: "模型接口不存在（404），请检查 BASE_URL 和模型名",
      429: "DeepSeek 请求受到限流（429），请稍后重试",
    };
    throw new ModelError(
      "http_" + response.status,
      messages[response.status] ||
        "模型服务请求失败（HTTP " + response.status + "）",
    );
  }
  try {
    return await response.json();
  } catch (error) {
    if (
      error instanceof Error &&
      ["TimeoutError", "AbortError"].includes(error.name)
    )
      throw new ModelError("timeout", "读取模型响应超时（30秒），请稍后重试");
    throw new ModelError("response_format", "模型接口返回的响应不是有效 JSON");
  }
}
export async function embed(texts: string[]) {
  const config = embeddingConfig();
  if (!config) return null;
  const output: number[][] = [];
  let dimension = 0;
  for (let i = 0; i < texts.length; i += 16) {
    const json = await request(config.base, "/embeddings", config.key, {
      model: config.model,
      input: texts.slice(i, i + 16),
    });
    const schema = z.object({
      data: z.array(
        z.object({
          index: z.number().int(),
          embedding: z.array(z.number().finite()).min(2).max(4096),
        }),
      ),
    });
    const batch = schema.parse(json).data.sort((a, b) => a.index - b.index);
    if (
      batch.length !== Math.min(16, texts.length - i) ||
      batch.some((item, index) => item.index !== index)
    )
      throw Error("向量数量不匹配");
    for (const item of batch) {
      dimension ||= item.embedding.length;
      if (
        item.embedding.length !== dimension ||
        !item.embedding.some((v) => v !== 0)
      )
        throw Error("向量维度不一致或为空");
      output.push(item.embedding);
    }
  }
  return { vectors: output, tag: config.tag };
}
const answerSchema = z.object({
  sections: z
    .array(
      z.object({
        title: z.string().optional(),
        text: z.string().trim().min(1).max(1200),
        citations: z
          .array(
            z.object({
              chunkId: z.string().uuid(),
              quote: z.string().trim().min(4).max(850),
            }),
          )
          .min(1)
          .max(5),
      }),
    )
    .min(1)
    .max(4),
});
export function validateAnswer(
  value: unknown,
  evidence: Evidence[],
): Section[] {
  const { sections } = answerSchema.parse(value);
  for (const section of sections)
    for (const cite of section.citations) {
      const source = evidence.find((e) => e.id === cite.chunkId);
      if (!source)
        throw new ModelError(
          "citation_source",
          "引用校验失败：回答引用了不存在的证据",
        );
      if (!source.content.includes(cite.quote))
        throw new ModelError(
          "citation_quote",
          "引用校验失败：引文与原文不一致",
        );
    }
  return sections;
}
export function validateModelResult(value: unknown, evidence: Evidence[]) {
  const result = structuredAnswerSchema.parse(value);
  if (result.status === "insufficient") return result;
  if (
    result.sections[0].title !== "结论" ||
    new Set(result.sections.map((s) => s.title)).size !== result.sections.length
  )
    throw new ModelError(
      "output_schema",
      "回答结构不符合约定：需要先给结论且标题不重复",
    );
  const fragments = new Map(
    prepareEvidence(evidence).flatMap((source, index) =>
      source.fragments.map(
        (fragment) =>
          [
            fragment.id,
            { chunkId: evidence[index].id, quote: fragment.content },
          ] as const,
      ),
    ),
  );
  const sections = result.sections.map((section) => ({
    title: section.title,
    text: section.text,
    citations: [...new Set(section.references)].map((id) => {
      const citation = fragments.get(id);
      if (!citation)
        throw new ModelError(
          "citation_source",
          "引用校验失败：回答引用了不存在的证据片段",
        );
      return citation;
    }),
  }));
  return {
    status: result.status,
    sections: validateAnswer({ sections }, evidence),
  };
}

export async function generate(
  question: string,
  evidence: Evidence[],
  onProgress: (message: string) => void = () => {},
) {
  if (!process.env.DEEPSEEK_API_KEY?.trim())
    return {
      status: "fallback" as const,
      sections: null,
      errorCode: "missing_key",
      notice: "未配置 DeepSeek，以下仅为原文摘录，不是生成式回答。",
    };
  try {
    const messages = [
      { role: "system", content: answerPrompt },
      {
        role: "user",
        content: JSON.stringify({
          question,
          evidence: prepareEvidence(evidence),
        }),
      },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const json = await request(
        process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
        "/chat/completions",
        process.env.DEEPSEEK_API_KEY.trim(),
        {
          model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
          temperature: 0.1,
          max_tokens: 1800,
          response_format: { type: "json_object" },
          messages,
        },
      );
      const choice = json.choices?.[0];
      try {
        if (choice?.finish_reason === "length")
          throw new ModelError(
            "truncated",
            "模型回答达到长度上限，未展示不完整回答",
          );
        if (choice?.finish_reason === "content_filter")
          throw new ModelError(
            "filtered",
            "模型服务未提供可用回答（内容过滤）",
          );
        let value: unknown;
        try {
          value = JSON.parse(choice?.message?.content || "");
        } catch {
          throw new ModelError(
            "output_format",
            "模型输出格式不正确：未返回有效 JSON",
          );
        }
        const result = validateModelResult(value, evidence);
        return {
          ...result,
          notice:
            result.status === "insufficient"
              ? "无法确认：现有证据不足以回答这个问题，请补充包含具体规则或正文的资料。"
              : "DeepSeek 基于证据归纳；引用由系统从原文回填。引用存在不代表结论语义一定正确，请核对依据。",
        };
      } catch (error) {
        const repairable =
          error instanceof z.ZodError ||
          (error instanceof ModelError &&
            [
              "output_format",
              "output_schema",
              "citation_source",
              "citation_quote",
              "truncated",
            ].includes(error.code));
        if (attempt || !repairable) throw error;
        onProgress("回答结构或引用未通过校验，正在修复一次…");
        const reason =
          error instanceof ModelError
            ? error.message
            : "输出字段或类型不符合 JSON 约定";
        // Do not feed untrusted failed output back as an assistant instruction.
        messages.push({
          role: "user",
          content:
            "上一轮未通过校验：" +
            reason +
            "。请根据同一批证据重新输出完整 JSON，缩短回答，仅选择提供的片段 id，不足则返回 insufficient。",
        });
      }
    }
    throw new ModelError("unexpected", "未能生成通过校验的回答");
  } catch (error) {
    return generationFailure(error);
  }
}

function generationFailure(error: unknown) {
  const failure =
    error instanceof ModelError
      ? error
      : error instanceof z.ZodError
        ? new ModelError(
            "output_schema",
            "模型输出结构不符合约定，未接受该回答",
          )
        : new ModelError(
            "unexpected",
            "模型处理发生异常，未接受未经校验的回答",
          );
  return {
    status: "fallback" as const,
    sections: null,
    errorCode: failure.code,
    notice:
      failure.message +
      "；未生成可信回答，已回退为可展开的原文参考（不代表问题已得到回答）。",
  };
}
