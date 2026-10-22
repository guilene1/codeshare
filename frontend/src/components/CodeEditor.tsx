import { useEffect, useRef } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { MonacoBinding } from "y-monaco";
import * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";
import type { FileDoc, Settings } from "../lib";
import { aliases, isDocumentLanguage } from "../markdown";
import { attachDocumentBlocks } from "./editorBlocks";
import { imagesIn, type FoundImages } from "../documentImages";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less")
      return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor")
      return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
monaco.languages.register({
  id: "hcl",
  extensions: [".tf", ".hcl", ".tfvars"],
});
monaco.languages.setMonarchTokensProvider("hcl", {
  keywords: [
    "resource",
    "data",
    "variable",
    "output",
    "provider",
    "terraform",
    "module",
    "locals",
    "true",
    "false",
    "null",
    "for",
    "in",
    "if",
    "dynamic",
  ],
  tokenizer: {
    root: [
      [/#.*/, "comment"],
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/\b\d+(\.\d+)?\b/, "number"],
      // Attribute names (`region = …`) read like keys, as in VS Code.
      [/([a-zA-Z_][\w-]*)(\s*)(=)(?!=)/, ["variable", "white", "operator"]],
      [
        /[a-zA-Z_][\w-]*/,
        { cases: { "@keywords": "keyword", "@default": "identifier" } },
      ],
      [/[{}[\]()]/, "@brackets"],
      [/[=?:+*/<>!-]/, "operator"],
    ],
    comment: [
      [/[^/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[/*]/, "comment"],
    ],
  },
});
monaco.languages.setLanguageConfiguration("hcl", {
  comments: { lineComment: "#", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
});
// Fence names authors type (```bash, ```yml, ```terraform, ```k8s) resolve to Monaco
// languages, so Markdown code fences are highlighted while editing.
for (const [alias, id] of Object.entries(aliases))
  if (id !== "plaintext" && id !== "markdown")
    monaco.languages.register({ id, aliases: [alias] });
// Plain Text documents: prose stays uncoloured; fenced blocks get their language's colours.
monaco.languages.setMonarchTokensProvider("plaintext", {
  tokenizer: {
    root: [
      [/^\s*```\s*([\w+#.-]+)\s*$/, { token: "comment", next: "@backticks", nextEmbedded: "$1" }],
      [/^\s*~~~\s*([\w+#.-]+)\s*$/, { token: "comment", next: "@tildes", nextEmbedded: "$1" }],
      [/.+/, ""],
    ],
    backticks: [[/^\s*```+\s*$/, { token: "comment", next: "@pop", nextEmbedded: "@pop" }]],
    tildes: [[/^\s*~~~+\s*$/, { token: "comment", next: "@pop", nextEmbedded: "@pop" }]],
  },
});
monaco.editor.defineTheme("devshare-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6D7D91" },
    { token: "keyword", foreground: "B79CFF" },
    { token: "string", foreground: "A3D5AC" },
    { token: "number", foreground: "F2BC79" },
    { token: "type.yaml", foreground: "9CDCFE" },
    { token: "string.key.json", foreground: "9CDCFE" },
    { token: "variable.hcl", foreground: "9CDCFE" },
  ],
  colors: {
    "editor.background": "#11151D",
    "editor.foreground": "#D6DFEB",
    "editorLineNumber.foreground": "#6E7C92",
    "editorLineNumber.activeForeground": "#D6DFEB",
    "editor.lineHighlightBackground": "#181E29",
    "editor.selectionBackground": "#6366F145",
    "editorCursor.foreground": "#A5A8FF",
    "editorIndentGuide.background1": "#242D3D",
    "editorWidget.background": "#1A2130",
  },
});
monaco.editor.defineTheme("devshare-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "7A8699" },
    { token: "keyword", foreground: "7952B3" },
    { token: "string", foreground: "397F5A" },
    { token: "number", foreground: "A76A30" },
    { token: "type.yaml", foreground: "0451A5" },
    { token: "string.key.json", foreground: "0451A5" },
    { token: "variable.hcl", foreground: "0451A5" },
  ],
  colors: {
    "editor.background": "#FFFFFF",
    "editor.foreground": "#263349",
    "editor.lineHighlightBackground": "#F5F7FB",
    "editorLineNumber.foreground": "#7D889C",
    "editorLineNumber.activeForeground": "#263349",
  },
});

// Token boundaries and types per line, for rendering read-only code as plain text nodes.
export async function tokenizeCode(content: string, language: string) {
  for (let attempt = 0; ; attempt++) {
    // colorize waits for a lazily registered tokenizer to load; tokenize does not.
    await monaco.editor.colorize("", language, {});
    const lines = monaco.editor.tokenize(content, language);
    // JSON installs its tokenizer only when a model of that language first exists and
    // its language chunk has loaded, so an all-untyped result for a real language
    // creates a throwaway model once and is retried briefly before giving up.
    const untyped = lines.every((line) => line.every((token) => !token.type));
    if (!untyped || language === "plaintext" || !content.trim() || attempt >= 20)
      return lines.map((line) => line.map(({ offset, type }) => ({ offset, type })));
    if (!attempt) monaco.editor.createModel("", language).dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export default function CodeEditor({
  file,
  provider,
  settings,
  dark,
  onPosition,
  onEditor,
  readOnly,
  onCreateBlock,
  onImages,
}: {
  file: FileDoc;
  provider: WebsocketProvider;
  settings: Settings;
  dark: boolean;
  onPosition: (line: number, col: number) => void;
  onEditor: (editor: monaco.editor.IStandaloneCodeEditor | null) => void;
  readOnly: boolean;
  onCreateBlock?: (content: string, language: string) => void;
  onImages?: (found: FoundImages) => void;
}) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null),
    bindingRef = useRef<MonacoBinding | null>(null),
    undoRef = useRef<Y.UndoManager | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const createBlockRef = useRef(onCreateBlock);
  createBlockRef.current = onCreateBlock;
  const imagesRef = useRef(onImages);
  imagesRef.current = onImages;
  const languageRef = useRef(file.language);
  languageRef.current = file.language;
  const mount: OnMount = (editor) => {
    editorRef.current = editor;
    onEditor(editor);
    const model = editor.getModel()!;
    const binding = new MonacoBinding(
      file.content,
      model,
      new Set([editor]),
      provider.awareness,
    );
    bindingRef.current = binding;
    // Monaco gives text without line breaks the OS line ending (CRLF on Windows), which would
    // store CRLF typing and pastes in shared text that LF editors read differently. Text with
    // no "\r" is switched to LF. Inside the binding's mutex, so y-monaco does not replay the
    // (character-identical) text into the shared document: nothing is sent, viewers included.
    if (!file.content.toString().includes("\r"))
      binding.mux(() => model.setEOL(monaco.editor.EndOfLineSequence.LF));
    const undo = new Y.UndoManager(file.content, {
      trackedOrigins: new Set([binding]),
    });
    undoRef.current = undo;
    if (!readOnly) {
      if (onCreateBlock)
        editor.addAction({
          id: "devshare.createCodeBlock",
          label: "Create Code Block from Selection",
          precondition: "editorHasSelection",
          contextMenuGroupId: "9_cutcopypaste",
          contextMenuOrder: 3,
          run: (instance) => {
            const selection = instance.getSelection(),
              currentModel = instance.getModel();
            if (selection && !selection.isEmpty() && currentModel)
              createBlockRef.current?.(
                currentModel.getValueInRange(selection),
                currentModel.getLanguageId(),
              );
          },
        });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () =>
        undo.undo(),
      );
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
        () => undo.redo(),
      );
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () =>
        undo.redo(),
      );
    }
    const cursor = editor.onDidChangeCursorPosition((e) =>
      onPosition(e.position.lineNumber, e.position.column),
    );
    // Documents (Markdown and Plain Text) get interactive code blocks; source files don't.
    const blocks = attachDocumentBlocks(editor, {
      isDocument: () => isDocumentLanguage(languageRef.current),
      readOnly,
    });
    // Images pasted or dropped into a document upload and insert at the cursor, only when
    // the clipboard really holds images. Monaco's own "paste as" handler captures file
    // pastes on its container and stops them there, so listen one level higher.
    const container = editor.getContainerDomNode().parentElement ?? editor.getContainerDomNode();
    const takeImages = (event: ClipboardEvent | DragEvent, found: FoundImages) => {
      if (
        readOnly ||
        !imagesRef.current ||
        !isDocumentLanguage(languageRef.current) ||
        (!found.files.length && !found.urls.length && !found.unsupported)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      imagesRef.current(found);
    };
    const paste = (event: ClipboardEvent) => takeImages(event, imagesIn(event.clipboardData));
    const drop = (event: DragEvent) => {
      const found = imagesIn(event.dataTransfer, false);
      if (!found.files.length && !found.unsupported) return;
      // Insert where the files were dropped.
      const target = editor.getTargetAtClientPoint(event.clientX, event.clientY);
      if (target?.position) editor.setPosition(target.position);
      takeImages(event, found);
    };
    const dragOver = (event: DragEvent) => {
      if (!readOnly && event.dataTransfer?.types.includes("Files") && isDocumentLanguage(languageRef.current))
        event.preventDefault();
    };
    container.addEventListener("paste", paste, true);
    container.addEventListener("drop", drop, true);
    container.addEventListener("dragover", dragOver, true);
    cleanup.current = () => {
      container.removeEventListener("paste", paste, true);
      container.removeEventListener("drop", drop, true);
      container.removeEventListener("dragover", dragOver, true);
      blocks();
      cursor.dispose();
      binding.destroy();
      undo.destroy();
    };
    editor.focus();
  };
  useEffect(
    () => () => {
      cleanup.current();
      onEditor(null);
    },
    [],
  );
  useEffect(() => {
    if (editorRef.current?.getModel())
      monaco.editor.setModelLanguage(
        editorRef.current.getModel()!,
        file.language,
      );
  }, [file.language]);
  const theme =
    settings.editorTheme === "auto"
      ? dark
        ? "devshare-dark"
        : "devshare-light"
      : settings.editorTheme === "dark"
        ? "devshare-dark"
        : "devshare-light";
  return (
    <Editor
      height="100%"
      language={file.language}
      theme={theme}
      onMount={mount}
      loading={<div className="editor-loading">Preparing your workspace…</div>}
      options={{
        readOnly,
        fontSize: settings.fontSize,
        fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
        lineHeight: Math.round(settings.fontSize * 1.75),
        tabSize: settings.tabSize,
        insertSpaces: true,
        wordWrap: settings.wordWrap ? "on" : "off",
        minimap: { enabled: settings.minimap },
        // Line numbers are always shown (every language, editors and students alike),
        // so a stale per-browser preference can never hide the gutter.
        lineNumbers: "on",
        lineNumbersMinChars: 3,
        cursorStyle: settings.cursorStyle,
        padding: { top: 22, bottom: 20 },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        smoothScrolling: true,
        bracketPairColorization: { enabled: true },
        // Avoid semantic occurrence requests being canceled during rapid lesson/model disposal.
        // Syntax, bracket matching and manual selection highlighting remain available.
        occurrencesHighlight: "off",
        renderLineHighlight: "all",
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        // Monaco's own menu offers Copy; view-only readers get the plain browser menu.
        contextmenu: !readOnly,
        // Prose documents: word suggestions would capture Enter mid-sentence.
        ...(isDocumentLanguage(file.language)
          ? {
              quickSuggestions: false,
              suggestOnTriggerCharacters: false,
              wordBasedSuggestions: "off" as const,
              acceptSuggestionOnEnter: "off" as const,
            }
          : {}),
      }}
    />
  );
}
