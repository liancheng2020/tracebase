import { load } from "cheerio";

// Parse as data only: no browser, JavaScript, CSS execution, or network requests.
export function htmlText(source: string): string {
  const $ = load(source);
  const title = $("title").first().text().trim();
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
  const body = $("body")
    .text()
    .split("\n")
    .map((line) => line.replace(/[\t \u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (!body.trim())
    throw Error(
      "HTML 没有可索引的静态正文；脚本生成的原型请先导出静态 HTML、PDF 或需求说明",
    );
  return (
    (title
      ? "# " +
        title.replace(/\s+/g, " ") +
        "\n页面标题：" +
        title.replace(/\s+/g, " ") +
        "\n"
      : "") + body
  );
}
