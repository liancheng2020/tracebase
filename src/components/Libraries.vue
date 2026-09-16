<script setup lang="ts">
import { computed, ref } from "vue";
import type { Space, Document } from "../../shared/types";
import { api, date } from "../api";
const props = defineProps<{ spaces: Space[]; documents: Document[] }>();
const emit = defineEmits<{ open: [id: string]; create: []; changed: [] }>();
const deleting = ref<Space | null>(null),
  busy = ref(false),
  error = ref("");
async function remove() {
  if (!deleting.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api("/spaces/" + deleting.value.id, {
      method: "DELETE",
      signal: AbortSignal.timeout(10000),
    });
    deleting.value = null;
    emit("changed");
  } catch (e) {
    error.value =
      (e as Error).name === "TimeoutError"
        ? "请求超时，请刷新确认删除结果。"
        : (e as Error).message;
  } finally {
    busy.value = false;
  }
}
const query = ref("");
const libraries = computed(() =>
  props.spaces
    .filter((s) =>
      s.name
        .toLocaleLowerCase()
        .includes(query.value.trim().toLocaleLowerCase()),
    )
    .map((s) => {
      const docs = props.documents.filter((d) => d.space_id === s.id);
      return {
        ...s,
        count: docs.length,
        processing: docs.filter(
          (d) => d.status === "pending" || d.status === "indexing",
        ).length,
        failed: docs.filter((d) => d.status === "failed" || d.error).length,
        updated: docs.reduce(
          (latest, d) =>
            Date.parse(d.updated_at) > Date.parse(latest)
              ? d.updated_at
              : latest,
          s.created_at,
        ),
      };
    }),
);
</script>
<template>
  <div class="section-heading">
    <div>
      <p class="eyebrow">KNOWLEDGE LIBRARIES</p>
      <h2>所有知识库，一个入口。</h2>
      <p class="muted">按项目或主题管理资料，问答与知识健康统一汇总。</p>
    </div>
    <button class="primary" @click="$emit('create')">新建知识库</button>
  </div>
  <div class="library-search">
    <input
      v-model="query"
      aria-label="搜索知识库"
      placeholder="搜索知识库名称"
      maxlength="60"
    /><span class="muted"
      >{{ libraries.length }} / {{ spaces.length }} 个知识库</span
    >
  </div>
  <div v-if="libraries.length" class="library-grid">
    <article
      v-for="library in libraries"
      :key="library.id"
      class="card library-card"
      @click="$emit('open', library.id)"
      tabindex="0"
      @keydown.enter.self="$emit('open', library.id)"
    >
      <span class="eyebrow">KNOWLEDGE BASE</span>
      <h3>{{ library.name }}</h3>
      <p>
        {{ library.count }} 份资料 · {{ library.processing }} 份处理中 ·
        {{ library.failed }} 份需关注
      </p>
      <span class="muted"
        >{{ library.count ? "最近更新：" : "创建于："
        }}{{ date(library.updated) }}</span
      >
      <div class="library-card-actions">
        <button class="text-button" @click.stop="$emit('open', library.id)">
          {{ library.count ? "查看资料" : "添加第一份资料" }} →
        </button>
        <button
          class="library-delete danger"
          type="button"
          title="删除知识库"
          :aria-label="'删除知识库：' + library.name"
          @click.stop="
            deleting = library;
            error = '';
          "
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
          </svg>
        </button>
      </div>
    </article>
  </div>
  <div v-else class="card empty">
    <h3>没有匹配的知识库</h3>
    <p>换个关键词，或清空搜索查看全部知识库。</p>
    <button @click="query = ''">清空搜索</button>
  </div>
  <div v-if="deleting" class="modal-backdrop">
    <form
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-library-title"
      @submit.prevent="remove"
    >
      <h3 id="delete-library-title">删除知识库</h3>
      <p>确定删除“{{ deleting.name }}”吗？</p>
      <p class="muted">
        将永久删除库内全部资料、原始文件、版本和索引，以及该库的历史问答和引用这些资料的跨库问答记录及反馈。其他知识库的资料不受影响。此操作无法撤销。
      </p>
      <p v-if="error" role="alert" class="notice error">{{ error }}</p>
      <div class="actions">
        <button type="button" :disabled="busy" @click="deleting = null">
          取消</button
        ><button class="danger-fill" :disabled="busy" :aria-busy="busy">
          {{ busy ? "删除中…" : "确认删除" }}
        </button>
      </div>
    </form>
  </div>
</template>
