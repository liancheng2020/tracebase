<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import type { Space, Document, Evidence, Answer } from "../shared/types";
import { api } from "./api";
import Documents from "./components/Documents.vue";
import Chat from "./components/Chat.vue";
import EvidencePanel from "./components/EvidencePanel.vue";
const spaces = ref<Space[]>([]),
  space = ref(""),
  documents = ref<Document[]>([]),
  feedback = ref<Answer[]>([]),
  tab = ref("library"),
  source = ref<Evidence | null>(null),
  error = ref(""),
  newName = ref(""),
  creating = ref(false),
  createBusy = ref(false);
const config = ref({
  chat: false,
  embedding: false,
  storage: "PGlite + pgvector",
});
const activeSpace = computed(() =>
  spaces.value.find((s) => s.id === space.value),
);
const issues = computed(() =>
  documents.value.filter((d) => d.status === "failed" || d.error),
);
const pending = computed(
  () =>
    documents.value.filter(
      (d) => d.status === "pending" || d.status === "indexing",
    ).length,
);
const titles: Record<string, string> = {
  library: "知识空间",
  chat: "问答工作台",
  health: "知识健康",
};
let timer: ReturnType<typeof setInterval> | undefined,
  loading = false;
async function refresh() {
  if (loading) return;
  loading = true;
  const requested = space.value;
  try {
    spaces.value = await api<Space[]>("/spaces");
    if (!space.value && spaces.value[0]) space.value = spaces.value[0].id;
    if (requested) {
      const [docs, answers] = await Promise.all([
        api<Document[]>("/spaces/" + requested + "/documents"),
        api<Answer[]>("/spaces/" + requested + "/answers"),
      ]);
      if (requested === space.value) {
        documents.value = docs;
        feedback.value = answers;
      }
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading = false;
  }
}
watch(space, () => {
  source.value = null;
  documents.value = [];
  feedback.value = [];
  void refresh();
});
onMounted(async () => {
  try {
    config.value = await api("/config");
    await refresh();
    await refresh();
    timer = setInterval(() => {
      if (pending.value && !document.hidden) void refresh();
    }, 2500);
  } catch (e) {
    error.value = (e as Error).message;
  }
});
onBeforeUnmount(() => clearInterval(timer));
function updateFeedback(answer: Answer) {
  const saved = feedback.value.find((item) => item.id === answer.id);
  if (saved) {
    saved.feedback = answer.feedback;
    saved.feedback_note = answer.feedback_note;
  } else {
    feedback.value = [answer, ...feedback.value].slice(0, 30);
  }
}
async function create() {
  if (createBusy.value || !newName.value.trim()) return;
  createBusy.value = true;
  try {
    const result = await api<Space>("/spaces", {
      method: "POST",
      body: JSON.stringify({ name: newName.value }),
    });
    space.value = result.id;
    newName.value = "";
    creating.value = false;
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    createBusy.value = false;
  }
}
</script>
<template>
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="/" aria-label="TraceBase 首页"
        ><img src="/logo.svg" alt="" />TraceBase</a
      >
      <p class="nav-label">工作区</p>
      <nav>
        <button
          v-for="(label, key) in titles"
          :key="key"
          :class="{ active: tab === key }"
          @click="
            tab = String(key);
            source = null;
          "
        >
          <span>{{ key === "library" ? "▤" : key === "chat" ? "◈" : "◷" }}</span
          >{{ label
          }}<i v-if="key === 'health' && issues.length">{{ issues.length }}</i>
        </button>
      </nav>
      <div class="space-heading">
        <p class="nav-label">我的知识空间</p>
        <button aria-label="新建知识空间" @click="creating = true">＋</button>
      </div>
      <button
        v-for="s in spaces"
        :key="s.id"
        :class="['space-link', { selected: s.id === space }]"
        @click="
          space = s.id;
          source = null;
        "
      >
        <span class="space-dot"></span>{{ s.name
        }}<small>{{ s.documents }}</small>
      </button>
      <p v-if="!spaces.length" class="sidebar-muted">
        还没有空间，创建你的第一份项目记忆。
      </p>
      <div class="sidebar-bottom">
        <span class="local-dot"></span>本机存储 · 不自动上传
        <p>相关文本仅在调用配置的模型时发送。</p>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <span
          >{{ titles[tab] }} <b>/</b>
          {{ activeSpace?.name || "开始使用" }}</span
        ><span class="environment"
          >{{ config.chat ? "DeepSeek 已配置" : "原文摘录模式" }} ·
          {{ config.embedding ? "混合检索已配置" : "关键词检索" }}</span
        >
      </header>
      <main>
        <div v-if="error" role="alert" class="notice error">
          {{ error }}
          <button class="text-button" @click="error = ''">关闭</button>
        </div>
        <section v-if="!space" class="welcome card">
          <p class="eyebrow">LESS SEARCHING. MORE KNOWING.</p>
          <h1>让项目经验，<br /><em>有据可循。</em></h1>
          <p>
            文档、设计决策、排障经验，放进同一个知识空间。<br />提问时看见答案，也看见它的来处。
          </p>
          <button class="primary" @click="creating = true">
            创建第一个知识空间 ↗
          </button>
          <div class="welcome-features">
            <span>01 文档可管理</span><span>02 答案有出处</span
            ><span>03 更新可追踪</span>
          </div>
        </section>
        <template v-else
          ><div class="metrics">
            <div>
              <span>已收录文档</span
              ><strong>{{ documents.length }}<small>份</small></strong>
            </div>
            <div>
              <span>有效证据片段</span
              ><strong
                >{{ documents.reduce((sum, d) => sum + d.chunk_count, 0)
                }}<small>段</small></strong
              >
            </div>
            <div>
              <span>正在处理</span
              ><strong>{{ pending }}<small>项</small></strong>
            </div>
            <div>
              <span>需要关注</span
              ><strong>{{ issues.length }}<small>项</small></strong>
            </div>
          </div>
          <Documents
            v-if="tab === 'library'"
            :key="space"
            :space="space"
            :documents="documents"
            @changed="refresh"
            @preview="source = $event"
          />
          <Chat
            v-else-if="tab === 'chat'"
            :key="space"
            :space="space"
            @preview="source = $event"
            @changed="refresh"
            @feedback-saved="updateFeedback"
          />
          <template v-else
            ><div class="section-heading">
              <div>
                <p class="eyebrow">KNOWLEDGE HEALTH</p>
                <h2>知识，也需要日常维护。</h2>
                <p class="muted">
                  关注索引失败和用户反馈。更新时间较旧，不代表内容已经过期。
                </p>
              </div>
            </div>
            <div class="health-grid">
              <section class="card">
                <h3>
                  索引关注项 <span class="count">{{ issues.length }}</span>
                </h3>
                <p v-if="!issues.length" class="healthy">✓ 当前没有索引故障</p>
                <div v-for="d in issues" :key="d.id" class="health-item">
                  <strong>{{ d.title }}</strong>
                  <p>{{ d.error }}</p>
                  <small>{{
                    d.active_revision
                      ? "仍可检索旧版 v" + d.active_revision
                      : "尚未进入检索"
                  }}</small>
                </div>
                <button class="text-button" @click="tab = 'library'">
                  前往资料管理 →
                </button>
              </section>
              <section class="card">
                <h3>不准确反馈</h3>
                <p class="muted">
                  最近 30 条问答中的人工反馈，需要你结合原文核实。
                </p>
                <p
                  v-if="!feedback.some((a) => a.feedback === 'incorrect')"
                  class="healthy"
                >
                  ✓ 暂无待核实反馈
                </p>
                <div
                  v-for="a in feedback.filter(
                    (a) => a.feedback === 'incorrect',
                  )"
                  :key="a.id"
                  class="health-item"
                >
                  <strong>{{ a.question }}</strong>
                  <p v-if="a.feedback_note">反馈：{{ a.feedback_note }}</p>
                  <p>
                    {{ a.mode === "extractive" ? "原文摘录" : "生成回答" }} ·
                    {{ a.evidence.length }} 段证据
                  </p>
                </div>
                <button class="text-button" @click="tab = 'chat'">
                  前往问答核对 →
                </button>
              </section>
            </div>
            <div class="notice">
              第一版不自动判断文档矛盾或过期，不会擅自修改你的知识。当前存储：{{
                config.storage
              }}。
            </div></template
          >
        </template>
        <footer>
          TraceBase <span>项目知识，有迹可循。</span
          ><small>单机版 · v0.1.0</small>
        </footer>
      </main>
    </div>
    <EvidencePanel
      v-if="source"
      :space="space"
      :source="source"
      @close="source = null"
    />
    <div v-if="creating" class="modal-backdrop">
      <form
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="space-title"
        @submit.prevent="create"
      >
        <p class="eyebrow">NEW KNOWLEDGE SPACE</p>
        <h3 id="space-title">创建知识空间</h3>
        <p class="muted">建议按项目划分。每次问答只检索所选空间。</p>
        <label for="space-name">空间名称</label
        ><input
          id="space-name"
          v-model="newName"
          maxlength="60"
          required
          autofocus
          placeholder="例如：产品需求知识库"
        />
        <div class="actions">
          <button type="button" @click="creating = false">取消</button
          ><button class="primary" :disabled="createBusy || !newName.trim()">
            创建空间
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
