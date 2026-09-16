import { randomUUID } from "node:crypto";
import type { Database } from "./db.ts";
import { parseDocument, tokens } from "./documents.ts";
import { embed } from "./models.ts";
export function createIndexer(db: Database) {
  let busy = false,
    stopped = false;
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const { rows } = await db.query<{
        id: string;
        revision: number;
        filename: string;
        body: Uint8Array;
      }>(
        "SELECT d.id,d.revision,r.filename,r.body FROM documents d JOIN revisions r ON r.document_id=d.id AND r.revision=d.revision WHERE d.status='pending' ORDER BY d.updated_at LIMIT 1",
      );
      const doc = rows[0];
      if (!doc) return;
      await db.query(
        "UPDATE documents SET status='indexing',error=NULL WHERE id=$1 AND revision=$2",
        [doc.id, doc.revision],
      );
      try {
        const parts = await parseDocument(doc.filename, doc.body);
        let vectors: Awaited<ReturnType<typeof embed>> = null,
          warning: string | null = null;
        try {
          vectors = await embed(parts.map((p) => p.heading + "\n" + p.content));
        } catch {
          warning =
            "向量服务失败，本次仅完成关键词索引；配置恢复后请重新索引。";
        }
        await db.transaction(async (tx) => {
          const current = await tx.query(
            "SELECT id FROM documents WHERE id=$1 AND revision=$2",
            [doc.id, doc.revision],
          );
          if (!current.rows.length) return;
          await tx.query("DELETE FROM chunks WHERE document_id=$1", [doc.id]);
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            await tx.query(
              "INSERT INTO chunks(id,document_id,revision,position,heading,page,content,tokens,embedding,model) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10)",
              [
                randomUUID(),
                doc.id,
                doc.revision,
                i,
                p.heading,
                p.page,
                p.content,
                tokens(p.heading + " " + p.content),
                vectors ? JSON.stringify(vectors.vectors[i]) : null,
                vectors?.tag ?? null,
              ],
            );
          }
          await tx.query(
            "UPDATE documents SET status='ready',active_revision=$2,error=$3,mode=$4 WHERE id=$1",
            [doc.id, doc.revision, warning, vectors ? "hybrid" : "keyword"],
          );
        });
      } catch (e) {
        await db.query(
          "UPDATE documents SET status='failed',error=$3 WHERE id=$1 AND revision=$2",
          [
            doc.id,
            doc.revision,
            e instanceof Error &&
            /PDF|文本|文档|切片|编码|文件|Markdown/.test(e.message)
              ? e.message
              : "解析失败，请检查文件是否损坏、加密或没有可读文本",
          ],
        );
      }
    } finally {
      busy = false;
    }
  }
  return {
    tick,
    stop: () => {
      stopped = true;
    },
    isBusy: () => busy,
  };
}
export async function saveDocument(
  db: Database,
  space: string,
  filename: string,
  body: Uint8Array,
  id?: string,
) {
  return db.transaction(async (tx) => {
    const exists = await tx.query("SELECT id FROM spaces WHERE id=$1", [space]);
    if (!exists.rows.length) throw Error("知识空间不存在");
    if (id) {
      const result = await tx.query<{ revision: number }>(
        "UPDATE documents SET revision=revision+1,status='pending',error=NULL,updated_at=now() WHERE id=$1 AND space_id=$2 RETURNING revision",
        [id, space],
      );
      if (!result.rows.length) throw Error("文档不存在");
      await tx.query(
        "INSERT INTO revisions(document_id,revision,filename,body) VALUES($1,$2,$3,$4)",
        [id, result.rows[0].revision, filename, body],
      );
    } else {
      id = randomUUID();
      const count = await tx.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM documents WHERE space_id=$1",
        [space],
      );
      if (count.rows[0].count >= 100) throw Error("每个空间最多 100 份文档");
      await tx.query(
        "INSERT INTO documents(id,space_id,title) VALUES($1,$2,$3)",
        [id, space, filename],
      );
      await tx.query(
        "INSERT INTO revisions(document_id,revision,filename,body) VALUES($1,1,$2,$3)",
        [id, filename, body],
      );
    }
    return id;
  });
}
