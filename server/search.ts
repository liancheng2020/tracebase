import { randomUUID } from "node:crypto";
import type { Database } from "./db.ts";
import type { Evidence, Answer } from "../shared/types.ts";
import { tokens } from "./documents.ts";
import { embed, generate } from "./models.ts";
const columns =
  "c.id,c.document_id,c.revision,d.title,c.heading,c.page,c.content";
export async function retrieve(db: Database, space: string, question: string) {
  const terms = tokens(question).slice(0, 150);
  const lexical = await db.query<Evidence>(
    "SELECT " +
      columns +
      ", (SELECT count(*) FROM unnest(c.tokens) t WHERE t=ANY($2::text[]))::float AS score FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.space_id=$1 AND c.revision=d.active_revision AND c.tokens && $2::text[] ORDER BY score DESC,c.id LIMIT 18",
    [space, terms],
  );
  let semantic: Evidence[] = [],
    mode = "关键词检索";
  try {
    const result = await embed([question]);
    if (result) {
      semantic = (
        await db.query<Evidence>(
          "SELECT " +
            columns +
            ", 1-(c.embedding <=> $2::vector) AS score FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.space_id=$1 AND c.revision=d.active_revision AND c.model=$3 AND vector_dims(c.embedding)=$4 AND 1-(c.embedding <=> $2::vector)>0.45 ORDER BY c.embedding <=> $2::vector LIMIT 18",
          [
            space,
            JSON.stringify(result.vectors[0]),
            result.tag,
            result.vectors[0].length,
          ],
        )
      ).rows;
      mode = semantic.length ? "混合检索 · RRF" : "关键词检索 · 无可用语义候选";
    }
  } catch {
    mode = "关键词检索 · 向量服务不可用";
  }
  const ranked = new Map<string, Evidence>();
  for (const list of [lexical.rows, semantic])
    list.forEach((e, i) => {
      const existing = ranked.get(e.id);
      ranked.set(e.id, {
        ...e,
        score: (existing?.score || 0) + 1 / (60 + i + 1),
      });
    });
  const evidence = [...ranked.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  return { evidence, mode };
}
export async function answerQuestion(
  db: Database,
  space: string,
  question: string,
  onProgress: (stage: string) => void = () => {},
) {
  const start = Date.now();
  onProgress("正在检索当前空间的有效文档…");
  const found = await retrieve(db, space, question);
  const answer: Answer = {
    id: randomUUID(),
    question,
    sections: [],
    evidence: found.evidence,
    mode: "abstain",
    notice: "没有找到足够相关的资料，暂时无法确认。请补充文档或更具体的问题。",
    retrieval: found.mode,
    elapsedMs: 0,
  };
  if (found.evidence.length) {
    onProgress("已找到 " + found.evidence.length + " 段证据，正在核对引用…");
    const generated = await generate(question, found.evidence);
    answer.sections =
      generated.sections ||
      found.evidence.slice(0, 3).map((e) => ({
        text: e.content,
        citations: [{ chunkId: e.id, quote: e.content.slice(0, 300) }],
      }));
    answer.mode = generated.sections ? "deepseek" : "extractive";
    answer.notice = generated.notice;
  }
  answer.elapsedMs = Date.now() - start;
  // Persist only if the evidence still belongs to the active revision in this space.
  await db.transaction(async (tx) => {
    if (answer.evidence.length) {
      const valid = await tx.query(
        "SELECT c.id FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.space_id=$1 AND c.revision=d.active_revision AND c.id=ANY($2::uuid[])",
        [space, answer.evidence.map((e) => e.id)],
      );
      if (valid.rows.length !== answer.evidence.length) {
        answer.sections = [];
        answer.evidence = [];
        answer.mode = "abstain";
        answer.notice = "回答期间资料已更新或删除，请重新提问。";
      }
    }
    await tx.query(
      "INSERT INTO answers(id,space_id,question,payload) VALUES($1,$2,$3,$4)",
      [answer.id, space, question, JSON.stringify(answer)],
    );
  });
  return answer;
}
