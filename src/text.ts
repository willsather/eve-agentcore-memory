import type { MemoryTurnCompletedContext } from "eve/memory";

type Message = MemoryTurnCompletedContext["messages"][number];

export function textContent(message: Message): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let result = "";
  for (const point of text) {
    bytes += Buffer.byteLength(point);
    if (bytes > maxBytes) break;
    result += point;
  }
  return result;
}

export function splitUtf8(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (bytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += point;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
