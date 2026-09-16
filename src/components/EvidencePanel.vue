<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import type { Evidence } from "../../shared/types";
import { api } from "../api";
const props = defineProps<{ space: string; source: Evidence }>();
defineEmits<{ close: [] }>();
const chunks = ref<Evidence[]>([]),
  notice = ref(""),
  revisions = ref<{ revision: number; filename: string }[]>([]);
let sequence = 0;
watch(
  () => [props.space, props.source.id],
  async () => {
    const current = ++sequence;
    chunks.value = [props.source];
    notice.value = "读取原文…";
    revisions.value = [];
    try {
      const data = await api<{
        chunks: Evidence[];
        document: { active_revision: number };
        revisions: typeof revisions.value;
      }>("/spaces/" + props.space + "/documents/" + props.source.document_id);
      if (current !== sequence) return;
      revisions.value = data.revisions;
      if (!data.chunks.some((c) => c.id === props.source.id)) {
        notice.value =
          "这是一份历史引用快照，源文档已更新。请重新提问获取当前版本。";
        return;
      }
      chunks.value = data.chunks;
      notice.value = "当前有效版本 · v" + data.document.active_revision;
      await nextTick();
      document
        .getElementById("source-" + props.source.id)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch {
      if (current === sequence)
        notice.value = "源文档不可用。下方仅为该回答保存的历史引用快照。";
    }
  },
  { immediate: true },
);
</script>
<template>
  <aside class="evidence-panel" aria-label="引用原文">
    <div class="evidence-header">
      <div>
        <p class="eyebrow">SOURCE OF TRUTH</p>
        <h3>{{ source.title }}</h3>
        <p v-if="source.space_name" class="muted">知识库：{{ source.space_name }}</p>
      </div>
      <button aria-label="关闭原文" @click="$emit('close')">×</button>
    </div>
    <p class="notice">{{ notice }}</p>
    <p v-if="source.extraction_warning" class="notice">
      {{ source.extraction_warning }}
    </p>
    <details v-if="revisions.length" class="revision-list">
      <summary>版本记录（{{ revisions.length }}）</summary>
      <p v-for="r in revisions" :key="r.revision">
        v{{ r.revision }} · {{ r.filename }}
      </p>
    </details>
    <div class="source-scroll">
      <article
        v-for="chunk in chunks"
        :id="'source-' + chunk.id"
        :key="chunk.id"
        :class="['source-chunk', { selected: chunk.id === source.id }]"
      >
        <small
          >v{{ chunk.revision }} ·
          {{ chunk.page ? "第 " + chunk.page + " 页" : chunk.heading }}</small
        >
        <h4>{{ chunk.heading }}</h4>
        <p>{{ chunk.content }}</p>
      </article>
    </div>
  </aside>
</template>
