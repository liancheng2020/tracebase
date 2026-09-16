import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
export async function openDatabase(path?: string) {
  const db = new PGlite({ dataDir: path, extensions: { vector } });
  await db.exec(`CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE IF NOT EXISTS spaces (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS documents (id uuid PRIMARY KEY, space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      title text NOT NULL, status text NOT NULL DEFAULT 'pending', revision int NOT NULL DEFAULT 1, active_revision int,
      error text, mode text, updated_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_warning text;
    CREATE TABLE IF NOT EXISTS revisions (document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      revision int NOT NULL, filename text NOT NULL, body bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(document_id, revision));
    CREATE TABLE IF NOT EXISTS chunks (id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      revision int NOT NULL, position int NOT NULL, heading text NOT NULL, page int, content text NOT NULL, tokens text[] NOT NULL, embedding vector, model text);
    CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id, revision);
    CREATE INDEX IF NOT EXISTS chunks_tokens ON chunks USING gin(tokens);
    CREATE TABLE IF NOT EXISTS answers (id uuid PRIMARY KEY, space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      question text NOT NULL, payload jsonb NOT NULL, feedback text, feedback_note text, created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE answers ALTER COLUMN space_id DROP NOT NULL;
  `);
  return db;
}
export type Database = Awaited<ReturnType<typeof openDatabase>>;
