export interface Space {
  id: string;
  name: string;
  created_at: string;
  documents: number;
  ready: number;
}
export interface Document {
  extraction_warning?: string | null;
  id: string;
  space_id: string;
  title: string;
  status: "pending" | "indexing" | "ready" | "failed";
  revision: number;
  active_revision: number | null;
  error: string | null;
  updated_at: string;
  chunk_count: number;
  mode: string | null;
}
export interface Evidence {
  space_id?: string;
  space_name?: string;
  extraction_warning?: string | null;
  id: string;
  document_id: string;
  revision: number;
  title: string;
  heading: string;
  page: number | null;
  content: string;
  score: number;
}
export interface Section {
  title?: string;
  text: string;
  citations: { chunkId: string; quote: string }[];
}
export interface Answer {
  space_id?: string | null;
  errorCode?: string;
  id: string;
  question: string;
  sections: Section[];
  evidence: Evidence[];
  mode: "deepseek" | "extractive" | "abstain";
  notice: string;
  retrieval: string;
  elapsedMs: number;
  created_at?: string;
  feedback?: string | null;
  feedback_note?: string;
}
