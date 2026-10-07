import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { FileDoc } from "../lib";

function inline(text: string): ReactNode[] {
  const parts = text.split(
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/g,
  );
  return parts.map((part, index) => {
    if (part.startsWith("`"))
      return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**"))
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      // Render source HTML as text and allow only safe web/mail/anchor links.
      if (/^(https?:\/\/|mailto:|#)/i.test(link[2]))
        return (
          <a
            key={index}
            href={link[2]}
            rel="noopener noreferrer"
            target={link[2].startsWith("#") ? undefined : "_blank"}
          >
            {link[1]}
          </a>
        );
      return <span key={index}>{link[1]}</span>;
    }
    return part;
  });
}
function FencedCode({
  content,
  language,
  dark,
}: {
  content: string;
  language: string;
  dark: boolean;
}) {
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let canceled = false;
    const aliases: Record<string, string> = {
      bash: "shell",
      sh: "shell",
      terraform: "hcl",
      tf: "hcl",
      js: "javascript",
      ts: "typescript",
      py: "python",
      yml: "yaml",
      text: "plaintext",
    };
    setHtml("");
    import("./CodeEditor")
      .then((module) =>
        module.colorizeCode(
          content,
          (aliases[language] ?? language) || "plaintext",
          dark,
        ),
      )
      .then((value) => {
        if (!canceled) setHtml(value);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [content, language, dark]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="markdown-code">
      <div>
        <span>{language || "Plain text"}</span>
        <button
          className="snippet-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(content);
              setCopied(true);
              setError("");
              clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 2000);
            } catch {
              setError("Select the code and press Ctrl / ⌘ C.");
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>
          {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : content}
        </code>
      </pre>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export default function MarkdownPreview({
  file,
  dark,
  fontSize,
}: {
  file: FileDoc;
  dark: boolean;
  fontSize: number;
}) {
  const [source, setSource] = useState(() => file.content.toString());
  useEffect(() => {
    const update = () => setSource(file.content.toString());
    update();
    file.content.observe(update);
    return () => file.content.unobserve(update);
  }, [file.content]);
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const output: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const start = index,
      line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})([\w-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index++;
      while (
        index < lines.length &&
        !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(
          lines[index],
        )
      )
        code.push(lines[index++]);
      if (index < lines.length) index++;
      output.push(
        <FencedCode
          key={start}
          content={code.join("\n")}
          language={fence[2]}
          dark={dark}
        />,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const text = inline(heading[2]);
      const level = heading[1].length;
      output.push(
        level === 1 ? (
          <h1 key={start}>{text}</h1>
        ) : level === 2 ? (
          <h2 key={start}>{text}</h2>
        ) : (
          <h3 key={start}>{text}</h3>
        ),
      );
      index++;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      output.push(<hr key={start} />);
      index++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]))
        quote.push(lines[index++].replace(/^\s*>\s?/, ""));
      output.push(
        <blockquote key={start}>{inline(quote.join(" "))}</blockquote>,
      );
      continue;
    }
    const list = /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line);
    if (list) {
      const ordered = /^\s*\d+\./.test(line),
        entries: ReactNode[] = [];
      while (
        index < lines.length &&
        (ordered
          ? /^\s*\d+\.\s+/.test(lines[index])
          : /^\s*[-*+]\s+/.test(lines[index]))
      ) {
        const entry = lines[index++].replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/, "");
        entries.push(<li key={index}>{inline(entry)}</li>);
      }
      output.push(
        ordered ? (
          <ol key={start}>{entries}</ol>
        ) : (
          <ul key={start}>{entries}</ul>
        ),
      );
      continue;
    }
    const paragraph: string[] = [line];
    index++;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(?:#{1,6}\s|`{3}|~{3}|>|[-*+]\s|\d+\.\s)/.test(lines[index])
    )
      paragraph.push(lines[index++]);
    output.push(<p key={start}>{inline(paragraph.join("\n"))}</p>);
  }
  return (
    <article
      className="markdown-preview"
      aria-label="Markdown preview"
      style={{ fontSize }}
    >
      {output.length ? (
        output
      ) : (
        <p className="muted">Notes for this lesson will appear here.</p>
      )}
    </article>
  );
}
