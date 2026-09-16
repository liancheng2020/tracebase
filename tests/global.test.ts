import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/db.ts";
import { saveDocument } from "../server/library.ts";
import { answerQuestion, retrieve } from "../server/search.ts";
import { createApi } from "../server/app.ts";

test("统一范围：跨库证据、旧历史、反馈、删除清理", async () => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.EMBEDDING_API_KEY;
  const db = await openDatabase();
  const { app, indexer } = createApi(db);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  try {
    const a = randomUUID(),
      b = randomUUID();
    await db.query(
      "INSERT INTO spaces(id,name) VALUES($1,'甲库'),($2,'乙库')",
      [a, b],
    );
    const first = await saveDocument(
      db,
      a,
      "a.txt",
      Buffer.from("部署端口 7100，属于甲库"),
    );
    const second = await saveDocument(
      db,
      b,
      "b.txt",
      Buffer.from("部署端口 7200，属于乙库"),
    );
    await indexer.tick();
    await indexer.tick();
    const old = await answerQuestion(db, a, "部署端口");
    const answer = await answerQuestion(db, null, "部署端口");
    assert.equal(answer.space_id, null);
    assert.deepEqual(
      new Set(answer.evidence.map((e) => e.space_id)),
      new Set([a, b]),
    );
    assert.ok(answer.evidence.every((e) => e.space_name));
    assert.ok(
      (await retrieve(db, a, "部署端口")).evidence.every(
        (e) => e.space_id === a,
      ),
    );
    const history = await (await fetch(base + "/api/answers")).json();
    assert.ok(history.some((v: any) => v.id === old.id));
    assert.ok(history.some((v: any) => v.id === answer.id));
    assert.equal(
      (await (await fetch(base + "/api/documents")).json()).length,
      2,
    );
    assert.equal(
      (
        await fetch(base + "/api/answers/" + answer.id + "/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "incorrect", note: "统一反馈" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await fetch(base + "/api/answers")).json()).find(
        (v: any) => v.id === answer.id,
      ).feedback_note,
      "统一反馈",
    );
    const source = answer.evidence.find((e) => e.document_id === second)!;
    assert.equal(
      (
        await fetch(
          base +
            "/api/spaces/" +
            source.space_id +
            "/documents/" +
            source.document_id,
        )
      ).status,
      200,
    );
    await fetch(base + "/api/spaces/" + a + "/documents/" + second, {
      method: "DELETE",
    });
    assert.equal(
      (await db.query("SELECT id FROM answers WHERE id=$1", [answer.id])).rows
        .length,
      1,
    );
    assert.equal(
      (
        await fetch(base + "/api/spaces/" + b + "/documents/" + second, {
          method: "DELETE",
        })
      ).status,
      200,
    );
    assert.equal(
      (await db.query("SELECT id FROM answers WHERE id=$1", [answer.id])).rows
        .length,
      0,
    );
    assert.equal(
      (await db.query("SELECT id FROM documents WHERE id=$1", [first])).rows
        .length,
      1,
    );
    const survivor = await saveDocument(
      db,
      b,
      "keep.txt",
      Buffer.from("其他知识库保留的资料"),
    );
    await indexer.tick();
    const globalBeforeDelete = await answerQuestion(db, null, "部署端口");
    assert.equal(
      (await fetch(base + "/api/spaces/" + a, { method: "DELETE" })).status,
      200,
    );
    assert.equal(
      (await db.query("SELECT id FROM documents WHERE id=$1", [first])).rows
        .length,
      0,
    );
    assert.equal(
      (await db.query("SELECT id FROM chunks WHERE document_id=$1", [first]))
        .rows.length,
      0,
    );
    assert.equal(
      (
        await db.query("SELECT revision FROM revisions WHERE document_id=$1", [
          first,
        ])
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query("SELECT id FROM answers WHERE id=ANY($1::uuid[])", [
          [old.id, globalBeforeDelete.id],
        ])
      ).rows.length,
      0,
    );
    assert.equal(
      (await db.query("SELECT id FROM documents WHERE id=$1", [survivor])).rows
        .length,
      1,
    );
    assert.equal(
      (await fetch(base + "/api/spaces/" + a, { method: "DELETE" })).status,
      404,
    );
  } finally {
    indexer.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
