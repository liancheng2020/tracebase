<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import type { Answer, Evidence, Section } from "../../shared/types";
import { api, streamAnswer, date } from "../api";
const props = defineProps<{ space: string }>();
const emit = defineEmits<{ preview: [evidence: Evidence]; changed: [] }>();
const question = ref(""),
  answers = ref<Answer[]>([]),
  active = ref<Answer | null>(null),
  busy = ref(false),
  error = ref(""),
  progress = ref(""),
  partial = ref<Section[]>([]),
  feedbackNote = ref("");
let controller: AbortController | undefined;
const modeNames = {
  deepseek: "DeepSeek · 有据回答",
  extractive: "原文摘录 · 非生成回答",
  abstain: "资料不足",
};
onMounted(async () => {
  try {
    answers.value = await api<Answer[]>("/spaces/" + props.space + "/answers");
    active.value = answers.value[0] || null;
  } catch (e) {
    error.value = (e as Error).message;
  }
});
onBeforeUnmount(() => controller?.abort());
async function ask() {
  if (busy.value || question.value.trim().length < 2) return;
  busy.value = true;
  error.value = "";
  active.value = null;
  partial.value = [];
  controller = new AbortController();
  try {
    await streamAnswer(
      props.space,
      question.value,
      controller.signal,
      (event, data) => {
        if (event === "progress") progress.value = data;
        if (event === "section") partial.value.push(data);
        if (event === "error") throw Error(data);
        if (event === "answer") {
          active.value = data;
          answers.value = [data, ...answers.value].slice(0, 30);
          emit("changed");
        }
      },
    );
    if (!active.value) throw Error("连接中断，没有收到完整回答");
  } catch (e) {
    if ((e as Error).name !== "AbortError") error.value = (e as Error).message;
  } finally {
    busy.value = false;
    partial.value = [];
  }
}
function cite(id: string) {
  const source = active.value?.evidence.find((e) => e.id === id);
  if (source) emit("preview", source);
}
async function feedback(kind: "helpful" | "incorrect") {
  if (!active.value) return;
  try {
    await api(
      "/spaces/" + props.space + "/answers/" + active.value.id + "/feedback",
      {
        method: "POST",
        body: JSON.stringify({ kind, note: feedbackNote.value }),
      },
    );
    active.value.feedback = kind;
    emit("changed");
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>
<template>
  <div class="section-heading">
    <div>
      <p class="eyebrow">ASK WITH EVIDENCE</p>
      <h2>每个答案，都有来处。</h2>
      <p class="muted">只查询当前空间。资料不足时，明确说不知道。</p>
    </div>
  </div>
  <form class="question-box" @submit.prevent="ask">
    <label class="visually-hidden" for="question">你的问题</label
    ><textarea
      id="question"
      v-model="question"
      maxlength="1500"
      rows="3"
      placeholder="例如：这个项目部署时需要配置哪些变量？"
    ></textarea>
    <div class="question-footer">
      <span
        >文档内的指令不会作为系统指令执行 · {{ question.length }} / 1500</span
      ><button class="primary" :disabled="busy || question.trim().length < 2">
        {{ busy ? "正在寻找依据…" : "提问 ↗" }}
      </button>
    </div>
  </form>
  <div v-if="error" role="alert" class="notice error">{{ error }}</div>
  <div v-if="busy" role="status" class="card progress">
    <span class="pulse"></span>{{ progress || "准备检索…" }}
    <p v-for="(s, i) in partial" :key="i">{{ s.text }}</p>
  </div>
  <div class="chat-columns">
    <div>
      <article v-if="active && !busy" class="card answer-card">
        <div class="card-heading">
          <span class="badge ready">{{ modeNames[active.mode] }}</span
          ><small>{{ (active.elapsedMs / 1000).toFixed(1) }}s</small>
        </div>
        <h3>{{ active.question }}</h3>
        <p class="notice">{{ active.notice }}</p>
        <section
          v-for="(section, index) in active.sections"
          :key="index"
          class="answer-section"
        >
          <p>{{ section.text }}</p>
          <button
            v-for="citation in section.citations"
            :key="citation.chunkId"
            class="citation"
            :title="citation.quote"
            @click="cite(citation.chunkId)"
          >
            ↗
            {{ active.evidence.find((e) => e.id === citation.chunkId)?.title }}
            · 查看依据
          </button>
        </section>
        <details class="trace">
          <summary>
            检索记录 · {{ active.retrieval }} ·
            {{ active.evidence.length }} 段候选
          </summary>
          <p class="muted">
            排序分不是置信度；相似度阈值仍需针对真实资料评估。
          </p>
          <button
            v-for="e in active.evidence"
            :key="e.id"
            class="trace-row"
            @click="emit('preview', e)"
          >
            {{ e.title }} / {{ e.heading }} · v{{ e.revision }} · RRF
            {{ e.score.toFixed(4) }}
          </button>
        </details>
        <div class="feedback">
          <span>这次回答有帮助吗？</span
          ><button
            :class="{ chosen: active.feedback === 'helpful' }"
            @click="feedback('helpful')"
          >
            有帮助</button
          ><button
            :class="{ chosen: active.feedback === 'incorrect' }"
            @click="feedback('incorrect')"
          >
            不准确</button
          ><input
            v-model="feedbackNote"
            maxlength="500"
            placeholder="可选：先填写原因，再提交反馈"
            aria-label="反馈说明"
          />
        </div>
      </article>
      <div v-else-if="!busy" class="card empty">
        <div class="empty-mark">⌘</div>
        <h3>从一个具体问题开始</h3>
        <p>先导入项目资料，再询问配置、设计约定或故障排查步骤。</p>
        <button
          class="secondary"
          @click="question = '这个项目部署时需要配置哪些变量？'"
        >
          试试：部署需要哪些配置？
        </button>
      </div>
    </div>
    <aside class="card history">
      <h3>最近提问</h3>
      <p v-if="!answers.length" class="muted">还没有历史记录</p>
      <button
        v-for="answer in answers"
        :key="answer.id"
        :class="{ current: active?.id === answer.id }"
        :disabled="busy"
        @click="
          active = answer;
          feedbackNote = '';
        "
      >
        {{ answer.question
        }}<small
          >{{ answer.created_at ? date(answer.created_at) : "刚刚" }} ·
          {{ modeNames[answer.mode] }}</small
        >
      </button>
      <p class="muted">
        显示最近 30 条。历史引用是回答时快照，点击可核对当前版本。
      </p>
    </aside>
  </div>
</template>
