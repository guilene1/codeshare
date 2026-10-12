// Finds bare web addresses in prose ("see https://github.com/x." -> link without the
// final period). Only http and https become links; everything stays plain text nodes.
const CANDIDATE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
export type TextPart = { text: string; href?: string };

export function findLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    let url = match[0];
    // Sentence punctuation and closing brackets that do not belong to the address.
    for (;;) {
      const end = url.at(-1)!;
      const opened = (url.match(/\(/g) ?? []).length,
        closed = (url.match(/\)/g) ?? []).length;
      if (/[.,;:!?'"*_]/.test(end) || (end === ")" && closed > opened) || end === "]") url = url.slice(0, -1);
      else break;
    }
    let href: string | undefined;
    try {
      const parsed = new URL(url);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname) href = parsed.href;
    } catch {
      /* Not a valid address: leave it as text. */
    }
    if (!href) continue;
    const start = match.index!;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, href });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
