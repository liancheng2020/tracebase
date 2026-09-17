import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/db.ts";
import { createApi } from "../server/app.ts";

test("删除单条问答及反馈，不影响其他记录与知识库；拒绝非法请求", async () => {
  const db = await openDatabase();
  const { app, indexer } = createApi(db);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  try {
    const space = randomUUID(),
      first = randomUUID(),
      second = randomUUID();
    await db.query("INSERT INTO spaces(id,name) VALUES($1,'测试库')", [space]);
    for (const id of [first, second])
      await db.query(
        "INSERT INTO answers(id,space_id,question,payload,feedback) VALUES($1,$2,'测试问题',$3,'helpful')",
        [
          id,
          space,
          JSON.stringify({
            id,
            question: "测试问题",
            evidence: [],
            sections: [],
            mode: "abstain",
            notice: "资料不足",
            retrieval: "关键词检索",
            elapsedMs: 0,
          }),
        ],
      );
    const remove = (id: string, headers = {}) =>
      fetch(base + "/api/answers/" + id, { method: "DELETE", headers });
    assert.equal(
      (await remove(first, { Origin: "https://untrusted.example" })).status,
      403,
    );
    assert.equal((await remove("invalid")).status, 400);
    assert.equal((await remove(first)).status, 200);
    assert.equal((await remove(first)).status, 404);
    const history = await (await fetch(base + "/api/answers")).json();
    assert.deepEqual(
      history.map((answer: { id: string }) => answer.id),
      [second],
    );
    assert.equal(
      (await db.query("SELECT id FROM spaces WHERE id=$1", [space])).rows
        .length,
      1,
    );
    assert.equal(
      (await db.query("SELECT id FROM answers WHERE id=$1", [first])).rows
        .length,
      0,
    );
  } finally {
    indexer.stop();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
  }
});
