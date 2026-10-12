import { Fragment, useEffect, useState, type ReactNode } from "react";

type Token = { offset: number; type: string };

// Monaco token types ("type.yaml", "string.key.json", "keyword.shell"…) mapped to a
// small VS Code-style palette shared by every language.
function tokenClass(type: string) {
  const t = type.toLowerCase();
  if (!t) return "";
  if (t.startsWith("comment")) return "tk-comment";
  if (
    t.includes(".key") ||
    t.startsWith("attribute.name") ||
    (t.startsWith("type") && t.endsWith(".yaml")) ||
    t.startsWith("variable.hcl")
  )
    return "tk-key";
  if (t.startsWith("string.escape")) return "tk-escape";
  if (t.startsWith("string") || t.startsWith("attribute.value")) return "tk-string";
  if (t.startsWith("number") || t.startsWith("constant")) return "tk-number";
  if (t.startsWith("keyword")) return "tk-keyword";
  if (t.startsWith("type")) return "tk-type";
  if (t.startsWith("tag") || t.startsWith("metatag")) return "tk-tag";
  if (t.startsWith("variable")) return "tk-variable";
  if (t.startsWith("predefined") || t.startsWith("annotation")) return "tk-function";
  if (t.startsWith("regexp")) return "tk-regexp";
  if (t.startsWith("delimiter") || t.startsWith("operator")) return "tk-punct";
  return "";
}

// Tokens load with Monaco on demand. Until then (or if it never loads) the code is
// shown uncoloured; while re-tokenizing after a live edit the previous colours stay.
function useTokens(content: string, language: string) {
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  useEffect(() => {
    let canceled = false;
    import("./CodeEditor")
      .then((module) => module.tokenizeCode(content, language))
      .then((lines) => {
        if (!canceled) setTokens(lines);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [content, language]);
  return tokens;
}

// Smallest indentation used in the block (2 for most YAML), for indentation guides.
function indentUnit(lines: string[]) {
  let unit = 0;
  for (const line of lines) {
    const spaces = /^ */.exec(line)![0].length;
    if (spaces && line.trim() && (!unit || spaces < unit)) unit = spaces;
  }
  return Math.min(Math.max(unit || 2, 2), 8);
}

function renderLine(line: string, tokens: Token[] | undefined, unit: number) {
  const parts: ReactNode[] = [];
  // Leading whitespace is kept character for character; each indentation level is
  // wrapped in a guide span, so copying a selection returns the original text.
  const indent = line.trim() ? /^[ \t]*/.exec(line)![0] : "";
  let spaces = "";
  for (const char of indent) {
    if (char === "\t") {
      if (spaces) parts.push(spaces);
      spaces = "";
      parts.push(<span key={"g" + parts.length} className="indent-guide">{"\t"}</span>);
    } else if ((spaces += " ").length === unit) {
      parts.push(<span key={"g" + parts.length} className="indent-guide">{spaces}</span>);
      spaces = "";
    }
  }
  if (spaces) parts.push(spaces);
  const list = tokens?.length ? tokens : [{ offset: 0, type: "" }];
  list.forEach((token, index) => {
    const start = Math.max(token.offset, indent.length),
      end = Math.min(list[index + 1]?.offset ?? line.length, line.length);
    if (end <= start) return;
    const text = line.slice(start, end),
      className = tokenClass(token.type);
    parts.push(className ? <span key={start} className={className}>{text}</span> : text);
  });
  return parts;
}

// The contents of a <pre><code>: one span per line, joined by real newlines.
export default function HighlightedLines({
  lines,
  language,
}: {
  lines: string[];
  language: string;
}) {
  const tokens = useTokens(lines.join("\n"), language);
  const unit = indentUnit(lines);
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={index}>
          <span className="code-line">{renderLine(line, tokens?.[index], unit)}</span>
          {/* A newline after every line: browsers drop only the final one, so a trailing
              empty line still takes its row and the gutter stays aligned. */}
          {"\n"}
        </Fragment>
      ))}
    </>
  );
}

// Accent colour for the language label of each block.
const accents: Record<string, string> = {
  yaml: "#f47c8a",
  json: "#e8c46b",
  shell: "#7ee08a",
  powershell: "#6aa6ff",
  python: "#6cb4f0",
  javascript: "#f0d65c",
  typescript: "#5fa8ff",
  hcl: "#b69cff",
  dockerfile: "#4cc3f5",
  go: "#4fd1e0",
  sql: "#f2a65a",
  java: "#e0a050",
  html: "#f2805c",
  css: "#c18cff",
  xml: "#f2a05c",
  ini: "#a8b4c6",
  ruby: "#f47174",
  markdown: "#d6dfeb",
};
export const languageAccent = (language: string) => accents[language] ?? "#94a3b8";
