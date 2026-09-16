import { load } from "cheerio";

export const DYNAMIC_HTML_WARNING =
  "静态提取可能不完整：检测到动态模板或脚本，已过滤未解析表达式；请结合渲染后的页面或导出的 PDF 核实。";

// Strip interpolation without evaluating expressions; respect nested objects and strings.
export function stripTemplates(text: string): string {
  let output = "",
    offset = 0;
  while (offset < text.length) {
    const start = text.indexOf("{{", offset);
    if (start < 0) return output + text.slice(offset);
    output += text.slice(offset, start);
    let depth = 0,
      quote = "",
      end = start + 2;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) {
        if (char === "\\") end++;
        else if (char === quote) quote = "";
      } else if (char === '"' || char === "'" || char === "\x60") quote = char;
      else if (char === "{") depth++;
      else if (char === "}" && depth) depth--;
      else if (char === "}" && text[end + 1] === "}") break;
    }
    // Malformed trailing expression is not useful evidence either.
    offset = Math.min(end + 2, text.length);
  }
  return output;
}

// Parse as data only: no browser, JavaScript, CSS execution, or network requests.
export function extractHtml(source: string): {
  text: string;
  warning: string | null;
} {
  const $ = load(source);
  const title = stripTemplates($("title").first().text()).trim();
  const dynamic =
    /\{\{/.test($.root().text()) ||
    $("*")
      .toArray()
      .some((node) =>
        Object.keys("attribs" in node ? node.attribs : {}).some((name) =>
          /^(v-|:|@|ng-|x-)/.test(name),
        ),
      ) ||
    $("script")
      .toArray()
      .some(
        (node) =>
          /^(?:module|(?:application|text)\/(?:java|ecma)script)?$/i.test(
            $(node).attr("type") || "",
          ) && Boolean($(node).attr("src") || $(node).text().trim()),
      );
  $(
    "script, style, head, template, noscript, iframe, object, embed, svg, canvas, [hidden], [aria-hidden='true'], input[type='hidden'], input[type='password']",
  ).remove();
  $("[style]").each((_, node) => {
    if (
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(
        $(node).attr("style") || "",
      )
    )
      $(node).remove();
  });
  // Prefer explicit navigation semantics; never delete generic headers/asides or menu-like words.
  $(
    "nav,[role='navigation'],[aria-label='breadcrumb'],[aria-label='breadcrumbs'],[aria-label='面包屑']",
  ).remove();
  const main = $("main,[role='main']");
  if (
    main.length &&
    main.toArray().some((node) => stripTemplates($(node).text()).trim())
  ) {
    $(
      ".sidebar,.side-nav,.sidenav,.breadcrumb,.breadcrumbs,[role='banner'],[role='contentinfo']",
    ).each((_, node) => {
      if (
        !$(node).is("main,[role='main']") &&
        !$(node).find("main,[role='main']").length &&
        !$(node).closest("main,[role='main']").length
      )
        $(node).remove();
    });
  }
  const textNode = (text: string) => $("<span>").text(text);
  $("input").each((_, node) => {
    const input = $(node),
      type = (input.attr("type") || "text").toLowerCase();
    const hint = input.attr("placeholder") || input.attr("aria-label") || "";
    const value = ["checkbox", "radio", "file"].includes(type)
      ? ""
      : input.attr("value") || "";
    input.replaceWith(textNode([hint, value].filter(Boolean).join("：")));
  });
  $("img").each((_, node) => {
    $(node).replaceWith(textNode($(node).attr("alt") || ""));
  });
  $("h1,h2,h3,h4,h5,h6").each((_, node) => {
    const heading = $(node).text().replace(/\s+/g, " ").trim();
    $(node).replaceWith(
      textNode(
        "\n\n" + "#".repeat(Number(node.tagName[1])) + " " + heading + "\n",
      ),
    );
  });
  $("br,hr").replaceWith(() => textNode("\n"));
  $("td,th").append(textNode(" | "));
  $(
    "p,div,section,article,header,footer,nav,main,aside,form,fieldset,label,legend,ul,ol,li,tr,table,button,select,textarea,details,summary,pre,blockquote,dl,dt,dd",
  ).each((_, node) => {
    $(node).prepend(textNode("\n")).append(textNode("\n"));
  });
  const body = stripTemplates($("body").text())
    .split("\n")
    .map((line) => line.replace(/[\t \u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (!body.trim())
    throw Error(
      "HTML 没有可索引的静态正文；脚本生成的原型请先导出静态 HTML、PDF 或需求说明",
    );
  return {
    warning: dynamic ? DYNAMIC_HTML_WARNING : null,
    text:
      (title
        ? "# " +
          title.replace(/\s+/g, " ") +
          "\n页面标题：" +
          title.replace(/\s+/g, " ") +
          "\n"
        : "") + body,
  };
}
