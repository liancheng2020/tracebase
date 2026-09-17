<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import type { Answer, Evidence, Section, Space } from "../../shared/types";
import { api, streamAnswer, date } from "../api";
const props = defineProps<{ spaces: Space[] }>();
const selectedSpace = ref("");
const scopeName = (id?: string | null) =>
  id ? props.spaces.find((s) => s.id === id)?.name || "原知识库" : "全部知识库";
watch(
  () => props.spaces,
  (spaces) => {
    if (
      selectedSpace.value &&
      !spaces.some((s) => s.id === selectedSpace.value)
    )
      selectedSpace.value = "";
  },
);
const emit = defineEmits<{
  preview: [evidence: Evidence];
  changed: [];
  feedbackSaved: [answer: Answer];
}>();
const question = ref(""),
  answers = ref<Answer[]>([]),
  active = ref<Answer | null>(null),
  busy = ref(false),
  error = ref(""),
  progress = ref(""),
  partial = ref<Section[]>([]),
  feedbackNote = ref("");
const feedbackKind = ref<"helpful" | "incorrect" | null>(null);
const feedbackSaving = ref(false);
const feedbackError = ref("");
const deletingId = ref("");
const deleteError = ref("");
const pendingDelete = ref<Answer | null>(null);
async function deleteAnswer(answer: Answer) {
  if (busy.value || feedbackSaving.value || deletingId.value) return;
  deletingId.value = answer.id;
  deleteError.value = "";
  try {
    await api("/answers/" + answer.id, {
      method: "DELETE",
      signal: AbortSignal.timeout(10000),
    });
    answers.value = answers.value.filter((item) => item.id !== answer.id);
    if (active.value?.id === answer.id) active.value = null;
    pendingDelete.value = null;
    emit("changed");
  } catch (e) {
    deleteError.value =
      (e as Error).name === "TimeoutError"
        ? "删除请求超时，暂未确认结果，请刷新历史记录核对。"
        : "删除失败：" + (e as Error).message;
  } finally {
    deletingId.value = "";
  }
}
const feedbackDirty = computed(
  () =>
    !!feedbackKind.value &&
    (feedbackKind.value !== active.value?.feedback ||
      feedbackNote.value !== (active.value?.feedback_note ?? "")),
);
watch(
  () => active.value?.id,
  () => {
    const saved = active.value?.feedback;
    feedbackKind.value =
      saved === "helpful" || saved === "incorrect" ? saved : null;
    feedbackNote.value = active.value?.feedback_note ?? "";
    feedbackError.value = "";
  },
);
watch([feedbackKind, feedbackNote], () => {
  feedbackError.value = "";
});
let controller: AbortController | undefined;
const modeNames = {
  deepseek: "DeepSeek · 有据回答",
  extractive: "原文摘录 · 非生成回答",
  abstain: "资料不足",
};
onMounted(async () => {
  try {
    answers.value = await api<Answer[]>("/answers");
  } catch (e) {
    error.value = (e as Error).message;
  }
});
onBeforeUnmount(() => controller?.abort());
async function ask() {
  if (busy.value || deletingId.value || question.value.trim().length < 2)
    return;
  busy.value = true;
  error.value = "";
  active.value = null;
  partial.value = [];
  controller = new AbortController();
  try {
    await streamAnswer(
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
      selectedSpace.value || undefined,
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
async function submitFeedback() {
  const target = active.value;
  const kind = feedbackKind.value;
  const note = feedbackNote.value;
  if (
    !target ||
    !kind ||
    deletingId.value ||
    feedbackSaving.value ||
    !feedbackDirty.value
  )
    return;
  feedbackSaving.value = true;
  feedbackError.value = "";
  try {
    await api("/answers/" + target.id + "/feedback", {
      method: "POST",
      body: JSON.stringify({ kind, note }),
      signal: AbortSignal.timeout(10000),
    });
    target.feedback = kind;
    target.feedback_note = note;
    emit("feedbackSaved", target);
  } catch (e) {
    if (active.value?.id === target.id)
      feedbackError.value =
        (e as Error).name === "TimeoutError"
          ? "请求超时，暂未确认保存结果，可重试或重新打开历史回答核对"
          : (e as Error).message;
  } finally {
    feedbackSaving.value = false;
  }
}
</script>
<template>
  <div class="section-heading">
    <div>
      <p class="eyebrow">ASK WITH EVIDENCE</p>
      <h2>每个答案，都有来处。</h2>
      <p class="muted">
        默认检索全部知识库，也可选择单个知识库缩小范围。资料不足时，明确说不知道。
      </p>
    </div>
  </div>
  <form class="question-box" @submit.prevent="ask">
    <div class="question-scope">
      <label for="question-space">知识库（可选）</label>
      <select id="question-space" v-model="selectedSpace" :disabled="busy">
        <option value="">全部知识库</option>
        <option v-for="item in spaces" :key="item.id" :value="item.id">
          {{ item.name }}
        </option>
      </select>
      <span class="muted">仅影响下一次提问，不筛选历史记录</span>
    </div>
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
      ><button
        class="primary"
        :disabled="busy || !!deletingId || question.trim().length < 2"
      >
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
    <div class="answer-column">
      <article v-if="active && !busy" class="card answer-card">
        <div class="card-heading">
          <span class="badge ready">{{ modeNames[active.mode] }}</span
          ><small>{{ (active.elapsedMs / 1000).toFixed(1) }}s</small>
        </div>
        <h3>{{ active.question }}</h3>
        <p class="muted answer-scope">
          本次检索范围：{{ scopeName(active.space_id) }}
        </p>
        <p class="notice">{{ active.notice }}</p>
        <component
          :is="active.mode === 'extractive' ? 'details' : 'div'"
          :key="active.id"
          class="answer-content"
        >
          <summary v-if="active.mode === 'extractive'">
            查看检索原文（仅供参考，非总结答案）
          </summary>
          <section
            v-for="(section, index) in active.sections"
            :key="index"
            class="answer-section"
          >
            <h4 v-if="section.title">{{ section.title }}</h4>
            <p>{{ section.text }}</p>
            <button
              v-for="citation in section.citations"
              :key="citation.chunkId + citation.quote"
              class="citation"
              :title="citation.quote"
              @click="cite(citation.chunkId)"
            >
              ↗
              {{
                active.evidence.find((e) => e.id === citation.chunkId)?.title
              }}
              <template
                v-if="
                  active.evidence.find((e) => e.id === citation.chunkId)
                    ?.space_name
                "
              >
                ·
                {{
                  active.evidence.find((e) => e.id === citation.chunkId)
                    ?.space_name
                }}</template
              >
              · 查看依据
            </button>
          </section>
        </component>
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
        <form
          class="feedback"
          @submit.prevent="submitFeedback"
          :aria-busy="feedbackSaving"
        >
          <span>这次回答有帮助吗？</span>
          <button
            type="button"
            :class="{ chosen: feedbackKind === 'helpful' }"
            :aria-pressed="feedbackKind === 'helpful'"
            :disabled="feedbackSaving"
            @click="feedbackKind = 'helpful'"
          >
            有帮助
          </button>
          <button
            type="button"
            :class="{ chosen: feedbackKind === 'incorrect' }"
            :aria-pressed="feedbackKind === 'incorrect'"
            :disabled="feedbackSaving"
            @click="feedbackKind = 'incorrect'"
          >
            不准确
          </button>
          <input
            v-model="feedbackNote"
            maxlength="500"
            :disabled="feedbackSaving"
            placeholder="可选：说明有帮助的地方或需要改进的问题"
            aria-label="反馈说明"
          />
          <div class="feedback-footer">
            <span role="status" class="muted">{{
              feedbackSaving
                ? "正在保存…"
                : feedbackDirty
                  ? "修改尚未提交"
                  : active.feedback
                    ? "反馈已保存"
                    : "选择类型后提交反馈"
            }}</span>
            <button
              type="submit"
              class="primary"
              :disabled="feedbackSaving || !feedbackDirty"
              :aria-busy="feedbackSaving"
            >
              {{
                feedbackSaving
                  ? "提交中…"
                  : active.feedback && !feedbackDirty
                    ? "已保存"
                    : "提交反馈"
              }}
            </button>
          </div>
          <p v-if="feedbackError" role="alert" class="notice error">
            反馈保存失败：{{ feedbackError }}，请重试。
          </p>
        </form>
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
      <div
        v-for="answer in answers"
        :key="answer.id"
        class="history-item"
        :class="{ current: active?.id === answer.id }"
      >
        <button
          class="history-select"
          :disabled="busy || !!deletingId"
          @click="active = answer"
        >
          {{ answer.question
          }}<small
            >{{ answer.created_at ? date(answer.created_at) : "刚刚" }} ·
            {{ modeNames[answer.mode] }}</small
          >
        </button>
        <button
          class="history-delete"
          :class="{ deleting: deletingId === answer.id }"
          :aria-label="'删除提问：' + answer.question"
          :title="deletingId === answer.id ? '正在删除…' : '删除提问'"
          :aria-busy="deletingId === answer.id"
          :disabled="busy || feedbackSaving || !!deletingId"
          @click.stop="
            pendingDelete = answer;
            deleteError = '';
          "
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
          </svg>
        </button>
      </div>
      <p class="muted history-note">
        显示最近 30 条。历史引用是回答时快照，点击可核对当前版本。
      </p>
    </aside>
  </div>
  <div v-if="pendingDelete" class="modal-backdrop">
    <form
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-answer-title"
      aria-describedby="delete-answer-description"
      @submit.prevent="deleteAnswer(pendingDelete)"
      @keydown.esc.stop.prevent="!deletingId && (pendingDelete = null)"
    >
      <h3 id="delete-answer-title">删除提问</h3>
      <p class="delete-question">确定删除“{{ pendingDelete.question }}”吗？</p>
      <p id="delete-answer-description" class="muted">
        将永久删除该次提问、回答及相关反馈，无法撤销。知识库资料和其他提问不受影响。
      </p>
      <p v-if="deleteError" role="alert" class="notice error">
        {{ deleteError }}
      </p>
      <div class="actions">
        <button
          type="button"
          :disabled="!!deletingId"
          @click="pendingDelete = null"
        >
          取消
        </button>
        <button
          class="danger-fill"
          :disabled="!!deletingId"
          :aria-busy="!!deletingId"
        >
          {{ deletingId ? "删除中…" : "确认删除" }}
        </button>
      </div>
    </form>
  </div>
</template>
