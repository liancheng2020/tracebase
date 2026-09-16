# 演示录制

使用真实本地 API、内存 PGlite 数据库和全新 Edge 会话。仅导入仓库公开示例及脚本生成的虚构 HTML 原型，不读取 .env、个人资料或已有 .data，不调用付费模型，不替换接口结果。

演示为关键词检索与原文摘录模式；不演示 DeepSeek 生成或向量检索。中文步骤字幕由录制脚本叠加，不是产品功能；反馈内容仅用于展示操作流程。

## 重新录制

先安装依赖、本机 Edge，以及带 libx264 的 FFmpeg。将 FFmpeg 加入 PATH，或设置 FFMPEG_PATH 为其可执行文件路径。

~~~sh
npm run build
npx tsx scripts/record-demo.ts
~~~

可通过 BROWSER_CHANNEL 指定已安装的 Chrome。视频编码为 H.264 / yuv420p / faststart，1440 × 1000，无音轨；原始 WebM 留在系统临时目录，转换成功后才替换正式 MP4。

## 输出

- [操作视频](media/tracebase-demo.mp4) · [引用核对封面](media/tracebase-demo-poster.png)
- [知识库概览](media/tracebase-libraries.png) · [资料管理](media/tracebase-documents.png)
- [问答结果](media/tracebase-answer.png) · [知识健康](media/tracebase-health.png)

GitHub 展示方式与 ReproLens、Sift 一致：封面链接到仓库内 MP4，并提供下载入口。不同客户端可能不支持内嵌播放。

## 本次验证

- 成片 33.76 秒，约 1.2 MB，H.264 / yuv420p，1440 × 1000；完整解码检查无错误。
- 真实索引、问答、引用定位和反馈保存成功，无页面脚本异常；已查看封面和分段抽帧。
- 示例资料与录制数据库均独立于个人数据，未修改业务代码。
