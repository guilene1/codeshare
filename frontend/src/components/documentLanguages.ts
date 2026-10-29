import * as monaco from "monaco-editor";

// Colourful typing for documents in the editor: headings, links, numbers, symbols and a
// few callout words get gentle colours while the text itself is never changed. These ids
// are used only for the editor model of Markdown and Plain Text files; previews and code
// blocks keep tokenizing with the standard "markdown" and "plaintext" languages.
export const MARKDOWN_EDITOR = "kodelumi-markdown";
export const NOTES_EDITOR = "kodelumi-notes";
export const editorLanguage = (language: string) =>
  language === "markdown" ? MARKDOWN_EDITOR : language === "plaintext" ? NOTES_EDITOR : language;

type Rules = monaco.languages.IMonarchLanguageRule[];
// Shared by both: ordinary prose. Words are consumed whole, so a number or symbol inside
// a word (module_01, v1.2, my-file) stays plain.
const prose: Rules = [
  [/\bhttps?:\/\/[^\s<>()[\]"'`]*[^\s<>()[\]"'`.,;:!?]/, "string.link"],
  [/\bwww\.[^\s<>()[\]"'`]*[^\s<>()[\]"'`.,;:!?]/, "string.link"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/, "string.link"],
  [/\b(?:NOTE|TIP|TODO|IMPORTANT|WARNING|CAUTION|FIXME)\b/, "keyword.callout"],
  [/\b(?:Note|Tip|Important|Warning|Caution|Example|Exercise|Step)(?=\s*\d*\s*:)/, "keyword.callout"],
  [/`[^`\n]+`/, "variable"],
  [/"[^"\n]{1,200}"/, "string"],
  [/\b\d+(?:[.,:]\d+)*%?(?!\w)/, "number"],
  [/->|=>|<-|<=|>=|!=|==|[=+*%<>|&~^$]/, "operator"],
  [/[\w'’]+/, ""],
  [/./, ""],
];
// Fenced code: highlighted in its own language (```bash, ```yaml, …), as before.
const fence = (marker: string): Rules => [
  [new RegExp(`^\\s*${marker}+\\s*$`), { token: "comment", next: "@pop", nextEmbedded: "@pop" }],
];
const openFence: Rules = [
  [/^\s*```\s*([\w+#.-]+).*$/, { token: "comment", next: "@backticks", nextEmbedded: "$1" }],
  [/^\s*~~~\s*([\w+#.-]+).*$/, { token: "comment", next: "@tildes", nextEmbedded: "$1" }],
  [/^\s*```\s*$/, { token: "comment", next: "@plainBackticks" }],
  [/^\s*~~~\s*$/, { token: "comment", next: "@plainTildes" }],
];
const plainFence = (marker: string): Rules => [
  [new RegExp(`^\\s*${marker}+\\s*$`), { token: "comment", next: "@pop" }],
  [/.*$/, "variable.source"],
];
const listMarker: Rules = [[/^\s*(?:[*+-]|\d+[.)])(?=\s)/, "keyword"]];

monaco.languages.register({ id: MARKDOWN_EDITOR });
monaco.languages.setMonarchTokensProvider(MARKDOWN_EDITOR, {
  tokenPostfix: ".md",
  tokenizer: {
    root: [
      ...openFence,
      [/^\s{0,3}#{1,6}(?=\s|$).*$/, "keyword.heading"],
      [/^\s*(?:=+|-{2,})\s*$/, "keyword.heading"],
      [/^\s*(?:[*_-]\s*){3,}$/, "comment"],
      [/^\s*>+/, "comment"],
      ...listMarker,
      [/<!--/, "comment", "@htmlComment"],
      [/<\/?[a-zA-Z][\w-]*(?:\s[^<>\n]*)?\/?>/, "tag"],
      [/\*\*[^*\n]+\*\*|__[^_\n]+__/, "strong"],
      [/\*[^*\s][^*\n]*\*|\b_[^_\n]+_\b/, "emphasis"],
      [/!?\[[^\]\n]*\]\([^)\n]*\)|!?\[[^\]\n]*\]/, "string.link"],
      ...prose,
    ],
    htmlComment: [
      [/-->/, "comment", "@pop"],
      [/[^-]+|-/, "comment"],
    ],
    backticks: fence("```"),
    tildes: fence("~~~"),
    plainBackticks: plainFence("```"),
    plainTildes: plainFence("~~~"),
  },
});
// Same editing behaviour as Monaco's built-in Markdown (brackets, auto-closing, folding).
monaco.languages.setLanguageConfiguration(MARKDOWN_EDITOR, {
  comments: { blockComment: ["<!--", "-->"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "<", close: ">", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: "`", close: "`" },
  ],
  folding: {
    markers: {
      start: /^\s*<!--\s*#?region\b.*-->/,
      end: /^\s*<!--\s*#?endregion\b.*-->/,
    },
  },
});

monaco.languages.register({ id: NOTES_EDITOR });
monaco.languages.setMonarchTokensProvider(NOTES_EDITOR, {
  tokenPostfix: ".notes",
  tokenizer: {
    root: [
      ...openFence,
      // Headings in plain notes: "# Title", a short "Title:" line, or a short ALL-CAPS line.
      [/^\s*#{1,6}\s.*$/, "keyword.heading"],
      [/^\s*[A-Z][^.!?:\n]{0,60}:\s*$/, "keyword.heading"],
      [/^\s*[A-Z][A-Z0-9 &/-]{2,60}\s*$/, "keyword.heading"],
      ...listMarker,
      ...prose,
    ],
    backticks: fence("```"),
    tildes: fence("~~~"),
    plainBackticks: plainFence("```"),
    plainTildes: plainFence("~~~"),
  },
});

// Theme colours for these tokens, added to the editor themes in CodeEditor.
export const documentTokenRules = {
  dark: [
    { token: "keyword.heading", foreground: "B79CFF", fontStyle: "bold" },
    { token: "keyword.callout", foreground: "F5A97F", fontStyle: "bold" },
    { token: "string.link", foreground: "7CC4FA", fontStyle: "underline" },
    { token: "operator.md", foreground: "89DDFF" },
    { token: "operator.notes", foreground: "89DDFF" },
    { token: "variable.md", foreground: "9CDCFE" },
    { token: "variable.notes", foreground: "9CDCFE" },
    { token: "tag.md", foreground: "7AA2F7" },
    { token: "strong.md", fontStyle: "bold" },
    { token: "emphasis.md", fontStyle: "italic" },
  ],
  light: [
    { token: "keyword.heading", foreground: "7952B3", fontStyle: "bold" },
    { token: "keyword.callout", foreground: "C2410C", fontStyle: "bold" },
    { token: "string.link", foreground: "0369A1", fontStyle: "underline" },
    { token: "operator.md", foreground: "0E7490" },
    { token: "operator.notes", foreground: "0E7490" },
    { token: "variable.md", foreground: "0451A5" },
    { token: "variable.notes", foreground: "0451A5" },
    { token: "tag.md", foreground: "1D4ED8" },
    { token: "strong.md", fontStyle: "bold" },
    { token: "emphasis.md", fontStyle: "italic" },
  ],
};
