export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "请求失败");
  return data;
}
export async function streamAnswer(
  question: string,
  signal: AbortSignal,
  onEvent: (event: string, data: any) => void,
) {
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!response.ok) throw Error((await response.json()).error || "问答失败");
  if (!response.body) throw Error("浏览器不支持响应流");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const packet = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = packet.match(/^event: (.+)$/m)?.[1],
          data = packet.match(/^data: (.+)$/m)?.[1];
        if (event && data) onEvent(event, JSON.parse(data));
      }
    }
  } finally {
    reader.releaseLock();
  }
}
export const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
