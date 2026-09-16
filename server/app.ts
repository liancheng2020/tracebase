import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.ts";
import type { Answer } from "../shared/types.ts";
import { createIndexer, saveDocument } from "./library.ts";
import { answerQuestion } from "./search.ts";
import { embeddingConfig } from "./models.ts";
const uuid = (value: unknown) => z.string().uuid().parse(value);
const filename = (value: string) => {
  let name = value;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(value, "latin1"),
    );
  } catch {
    /* Already Unicode or legacy input. */
  }
  return name.replace(/.*[\\/]/, "").slice(0, 180);
};
export function createApi(db: Database) {
  const app = express();
  app.disable("x-powered-by");
  const indexer = createIndexer(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 1 },
  });
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(req.hostname))
      return res.status(403).json({ error: "仅允许本机访问" });
    if (req.headers.origin && req.headers.origin !== "http://" + host)
      return res.status(403).json({ error: "拒绝跨站访问" });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.get("/api/config", (_req, res) =>
    res.json({
      chat: !!process.env.DEEPSEEK_API_KEY?.trim(),
      embedding: !!embeddingConfig(),
      storage: "PGlite + pgvector",
      limits: "单文件 8MB / PDF 100 页 / 文本 15 万字符 / 每空间 100 份文档",
    }),
  );
  app.get("/api/spaces", async (_req, res) =>
    res.json(
      (
        await db.query(
          "SELECT s.*,count(d.id)::int AS documents,count(d.id) FILTER(WHERE d.active_revision IS NOT NULL)::int AS ready FROM spaces s LEFT JOIN documents d ON d.space_id=s.id GROUP BY s.id ORDER BY s.created_at",
        )
      ).rows,
    ),
  );
  app.post("/api/spaces", async (req, res) => {
    const name = z.string().trim().min(1).max(60).parse(req.body.name),
      id = randomUUID();
    await db.query("INSERT INTO spaces(id,name) VALUES($1,$2)", [id, name]);
    res.status(201).json({ id, name });
  });
  app.get("/api/spaces/:space/documents", async (req, res) => {
    res.json(
      (
        await db.query(
          "SELECT d.*,(SELECT count(*)::int FROM chunks c WHERE c.document_id=d.id AND c.revision=d.active_revision) AS chunk_count FROM documents d WHERE d.space_id=$1 ORDER BY d.updated_at DESC",
          [uuid(req.params.space)],
        )
      ).rows,
    );
  });
  const uploadDocument: express.RequestHandler = async (req, res) => {
    const space = uuid(req.params.space),
      id = req.params.id ? uuid(req.params.id) : undefined;
    if (!req.file) {
      res.status(400).json({ error: "请选择文件" });
      return;
    }
    const name = filename(req.file.originalname);
    if (!/\.(md|txt|pdf|html|htm)$/i.test(name)) {
      res.status(400).json({ error: "仅支持 .md、.txt、.pdf、.html、.htm" });
      return;
    }
    const saved = await saveDocument(db, space, name, req.file.buffer, id);
    res.status(202).json({ id: saved });
  };
  app.post(
    "/api/spaces/:space/documents",
    upload.single("file"),
    uploadDocument,
  );
  app.put(
    "/api/spaces/:space/documents/:id",
    upload.single("file"),
    uploadDocument,
  );
  app.post("/api/spaces/:space/documents/:id/reindex", async (req, res) => {
    const { rows } = await db.query(
      "UPDATE documents SET status='pending',error=NULL WHERE id=$1 AND space_id=$2 RETURNING id",
      [uuid(req.params.id), uuid(req.params.space)],
    );
    res
      .status(rows.length ? 202 : 404)
      .json(rows[0] || { error: "文档不存在" });
  });
  app.get("/api/spaces/:space/documents/:id", async (req, res) => {
    const params = [uuid(req.params.id), uuid(req.params.space)];
    const doc = (
      await db.query(
        "SELECT * FROM documents WHERE id=$1 AND space_id=$2",
        params,
      )
    ).rows[0];
    if (!doc) {
      res.status(404).json({ error: "文档不存在" });
      return;
    }
    const chunks = (
      await db.query(
        "SELECT c.id,c.document_id,c.revision,d.title,c.heading,c.page,c.content FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.id=$1 AND d.space_id=$2 AND c.revision=d.active_revision ORDER BY c.position",
        params,
      )
    ).rows;
    const revisions = (
      await db.query(
        "SELECT r.revision,r.filename,r.created_at FROM revisions r JOIN documents d ON d.id=r.document_id WHERE d.id=$1 AND d.space_id=$2 ORDER BY r.revision DESC",
        params,
      )
    ).rows;
    res.json({ document: doc, chunks, revisions });
  });
  app.delete("/api/spaces/:space/documents/:id", async (req, res) => {
    const space = uuid(req.params.space),
      id = uuid(req.params.id);
    await db.transaction(async (tx) => {
      // Delete answer snapshots containing the removed source as well as its chunks/revisions.
      await tx.query(
        "DELETE FROM answers WHERE space_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'evidence') e WHERE e->>'document_id'=$2)",
        [space, id],
      );
      await tx.query("DELETE FROM documents WHERE id=$1 AND space_id=$2", [
        id,
        space,
      ]);
    });
    res.json({ ok: true });
  });
  app.get("/api/spaces/:space/answers", async (req, res) => {
    const { rows } = await db.query<{
      payload: Answer;
      feedback: string | null;
      feedback_note: string;
      created_at: string;
    }>(
      "SELECT payload,feedback,feedback_note,created_at FROM answers WHERE space_id=$1 ORDER BY created_at DESC LIMIT 30",
      [uuid(req.params.space)],
    );
    res.json(
      rows.map((r) => ({
        ...r.payload,
        feedback: r.feedback,
        feedback_note: r.feedback_note,
        created_at: r.created_at,
      })),
    );
  });
  let active = 0;
  app.post("/api/spaces/:space/ask", async (req, res) => {
    const space = uuid(req.params.space),
      question = z.string().trim().min(2).max(1500).parse(req.body.question);
    if (
      !(await db.query("SELECT id FROM spaces WHERE id=$1", [space])).rows
        .length
    ) {
      res.status(404).json({ error: "空间不存在" });
      return;
    }
    if (active >= 2) {
      res.status(429).json({ error: "正在处理其他问题，请稍后重试" });
      return;
    }
    active++;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const send = (event: string, data: unknown) => {
      if (!res.destroyed)
        res.write(
          "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n",
        );
    };
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": keepalive\n\n");
    }, 10000);
    try {
      const answer = await answerQuestion(db, space, question, (stage) =>
        send("progress", stage),
      );
      // Only emit answer text after validating every citation, not unverified model tokens.
      for (const section of answer.sections) send("section", section);
      send("answer", answer);
    } catch {
      send("error", "本次问答未完成，请重试。");
    } finally {
      clearInterval(heartbeat);
      active--;
      res.end();
    }
  });
  app.post("/api/spaces/:space/answers/:id/feedback", async (req, res) => {
    const kind = z.enum(["helpful", "incorrect"]).parse(req.body.kind);
    const note = z.string().max(500).optional().parse(req.body.note) || "";
    const { rows } = await db.query(
      "UPDATE answers SET feedback=$3,feedback_note=$4 WHERE id=$1 AND space_id=$2 RETURNING id",
      [uuid(req.params.id), uuid(req.params.space), kind, note],
    );
    res
      .status(rows.length ? 200 : 404)
      .json(rows[0] || { error: "回答不存在" });
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use(((error, _req, res, _next) => {
    if (error instanceof z.ZodError)
      res
        .status(400)
        .json({ error: "输入格式不正确，请检查名称、问题长度或标识" });
    else if (error instanceof multer.MulterError)
      res
        .status(400)
        .json({ error: "上传失败：单文件最多 8MB，每次仅允许一个文件" });
    else
      res.status(400).json({
        error: /空间不存在|文档不存在|最多 100/.test(error.message)
          ? error.message
          : "操作失败，请检查输入或稍后重试",
      });
  }) as express.ErrorRequestHandler);
  return { app, indexer };
}
