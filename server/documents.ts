import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { htmlText } from "./html.ts";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const fontDirectory =
  join(
    dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
    "standard_fonts",
  ).replaceAll("\\", "/") + "/";
export interface Part {
  heading: string;
  page: number | null;
  content: string;
}
export function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]+/g) || [];
  return [
    ...new Set(
      words.flatMap((word) =>
        /^[\u3400-\u9fff]+$/.test(word)
          ? word.length < 2
            ? [word]
            : Array.from({ length: word.length - 1 }, (_, i) =>
                word.slice(i, i + 2),
              )
          : [word],
      ),
    ),
  ];
}
export function splitText(text: string, page: number | null = null): Part[] {
  const parts: Part[] = [];
  let heading = page ? "第 " + page + " 页" : "正文";
  let body = "";
  const flush = () => {
    const value = body.trim();
    for (let i = 0; i < value.length; i += 700) {
      const content = value.slice(i, i + 850).trim();
      if (content) parts.push({ heading, page, content });
      if (i + 850 >= value.length) break;
    }
    body = "";
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.match(/^#{1,6}\s+(.+)/);
    if (match) {
      flush();
      heading = match[1].slice(0, 160);
    } else body += line + "\n";
  }
  flush();
  return parts;
}
export async function parseDocument(
  filename: string,
  buffer: Uint8Array,
): Promise<Part[]> {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  let parts: Part[];
  if (extension === "pdf") {
    if (Buffer.from(buffer.subarray(0, 5)).toString() !== "%PDF-")
      throw Error("不是有效的 PDF 文件");
    const task = getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      standardFontDataUrl: fontDirectory,
    });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 100) throw Error("PDF 最多支持 100 页");
      parts = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const text = (await page.getTextContent()).items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join("");
        parts.push(...splitText(text, i));
        if (parts.length > 300) throw Error("文档内容过多，请拆分后导入");
        page.cleanup();
      }
    } finally {
      await task.destroy();
    }
  } else if (["md", "txt", "html", "htm"].includes(extension || "")) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw Error("请将文本保存为 UTF-8 编码");
    }
    if (text.includes("\0")) throw Error("文件不是可读文本");
    if (extension === "html" || extension === "htm") text = htmlText(text);
    if (text.length > 150000) throw Error("文本最多支持 15 万字符");
    parts = splitText(text);
  } else throw Error("仅支持 Markdown、TXT、HTML 和文字型 PDF");
  if (!parts.length || parts.every((p) => p.content.trim().length < 2))
    throw Error("没有可索引的文本；扫描 PDF 请先 OCR");
  if (parts.length > 300) throw Error("切片超过 300 个，请拆分文档");
  return parts;
}
