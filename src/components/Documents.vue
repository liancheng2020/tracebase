<script setup lang="ts">
import { ref } from "vue";
import type { Document, Evidence } from "../../shared/types";
import { api, date } from "../api";
const props = defineProps<{ space: string; documents: Document[] }>();
const emit = defineEmits<{ changed: []; preview: [evidence: Evidence] }>();
const input = ref<HTMLInputElement>(),
  busy = ref(false),
  error = ref(""),
  replacement = ref<Document | null>(null),
  deleting = ref<Document | null>(null);
const states = {
  pending: "等待索引",
  indexing: "正在处理",
  ready: "已就绪",
  failed: "处理失败",
};
function choose(doc?: Document) {
  replacement.value = doc || null;
  input.value?.click();
}
async function upload(file: File) {
  busy.value = true;
  error.value = "";
  try {
    const form = new FormData();
    form.append("file", file);
    await api(
      "/spaces/" +
        props.space +
        "/documents" +
        (replacement.value ? "/" + replacement.value.id : ""),
      { method: replacement.value ? "PUT" : "POST", body: form },
    );
    emit("changed");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
    replacement.value = null;
    if (input.value) input.value.value = "";
  }
}
async function picked(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) await upload(file);
}
async function sample() {
  replacement.value = null;
  await upload(
    new File([await (await fetch("/example.md")).text()], "示例项目手册.md", {
      type: "text/markdown",
    }),
  );
}
async function reindex(doc: Document) {
  try {
    await api("/spaces/" + props.space + "/documents/" + doc.id + "/reindex", {
      method: "POST",
    });
    emit("changed");
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function remove() {
  if (!deleting.value) return;
  busy.value = true;
  try {
    await api("/spaces/" + props.space + "/documents/" + deleting.value.id, {
      method: "DELETE",
    });
    deleting.value = null;
    emit("changed");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function preview(doc: Document) {
  try {
    const result = await api<{ chunks: Evidence[] }>(
      "/spaces/" + props.space + "/documents/" + doc.id,
    );
    if (result.chunks[0]) emit("preview", result.chunks[0]);
    else error.value = "文档尚未完成索引，暂时没有可预览的原文。";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>
<template>
  <div class="section-heading">
    <div>
      <p class="eyebrow">YOUR PROJECT MEMORY</p>
      <h2>资料，是答案的起点。</h2>
      <p class="muted">导入项目文档，把散落的经验变成可追溯的知识。</p>
    </div>
    <button class="primary" :disabled="busy" @click="choose()">
      ＋ 导入文档
    </button>
  </div>
  <input
    ref="input"
    class="visually-hidden"
    type="file"
    accept=".md,.txt,.pdf,.html,.htm"
    aria-label="选择知识文档"
    @change="picked"
  />
  <div v-if="error" role="alert" class="notice error">{{ error }}</div>
  <div class="import-banner">
    <span class="file-symbol">↥</span>
    <div>
      <strong>Markdown / TXT / HTML / 文字型 PDF</strong>
      <p>单文件 8MB · 最多 100 页 PDF / 15 万文本字符 · 每空间 100 份文档</p>
      <small
        >扫描 PDF 暂不支持
        OCR。文件仅保存在本机；配置模型后，相关文本会发送至所配置服务。</small
      >
    </div>
  </div>
  <div class="card document-card">
    <div class="card-heading">
      <h3>
        全部资料 <span class="count">{{ documents.length }}</span>
      </h3>
      <button class="text-button" :disabled="busy" @click="sample">
        导入示例手册 ↗
      </button>
    </div>
    <div v-if="!documents.length" class="empty">
      <div class="empty-mark">▤</div>
      <h3>给你的项目留下一份记忆</h3>
      <p>上传 README、设计说明或故障记录。也可以导入示例，体验一次完整问答。</p>
      <button class="secondary" :disabled="busy" @click="sample">
        从示例开始
      </button>
    </div>
    <div v-for="doc in documents" :key="doc.id" class="document-row">
      <span class="doc-icon">{{
        doc.title.split(".").at(-1)?.toUpperCase()
      }}</span>
      <div class="document-info">
        <button class="doc-title" @click="preview(doc)">{{ doc.title }}</button>
        <p>
          v{{ doc.revision }} · {{ doc.chunk_count }} 段证据 ·
          {{ date(doc.updated_at) }} 更新
        </p>
        <small
          v-if="doc.active_revision && doc.active_revision !== doc.revision"
          class="warning"
          >新版尚未生效，检索仍使用 v{{ doc.active_revision }}</small
        ><small v-if="doc.error" class="warning">{{ doc.error }}</small>
      </div>
      <div class="document-status">
        <span :class="['badge', doc.status]">{{ states[doc.status] }}</span
        ><small v-if="doc.mode">{{
          doc.mode === "hybrid" ? "混合索引" : "关键词索引"
        }}</small>
      </div>
      <div class="row-actions">
        <button class="text-button" :disabled="busy" @click="choose(doc)">
          更新</button
        ><button
          class="text-button"
          :disabled="doc.status === 'indexing' || doc.status === 'pending'"
          @click="reindex(doc)"
        >
          重试索引</button
        ><button class="text-button danger" @click="deleting = doc">
          删除
        </button>
      </div>
    </div>
  </div>
  <div class="footnote">
    ↳
    文档更新成功后原子切换索引；失败保留旧版。删除会一并移除原文件、索引和引用它的历史回答。
  </div>
  <div v-if="deleting" class="modal-backdrop">
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-title"
      class="modal"
    >
      <h3 id="delete-title">删除「{{ deleting.title }}」？</h3>
      <p>原文件、全部版本、检索索引及引用它的历史回答将永久删除，无法撤销。</p>
      <div class="actions">
        <button @click="deleting = null">取消</button
        ><button class="primary danger-fill" :disabled="busy" @click="remove">
          确认删除
        </button>
      </div>
    </section>
  </div>
</template>
