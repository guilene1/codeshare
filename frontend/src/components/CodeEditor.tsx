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
monaco.editor.defineTheme("devshare-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6D7D91" },
    { token: "keyword", foreground: "B79CFF" },
    { token: "string", foreground: "A3D5AC" },
    { token: "number", foreground: "F2BC79" },
  ],
  colors: {
    "editor.background": "#11151D",
    "editor.foreground": "#D6DFEB",
    "editorLineNumber.foreground": "#4F5D72",
    "editorLineNumber.activeForeground": "#B5C0D2",
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
  ],
  colors: {
    "editor.background": "#FFFFFF",
    "editor.foreground": "#263349",
    "editor.lineHighlightBackground": "#F5F7FB",
    "editorLineNumber.foreground": "#A1AABB",
  },
});

export function colorizeCode(content: string, language: string, dark: boolean) {
  monaco.editor.setTheme(dark ? "devshare-dark" : "devshare-light");
  return monaco.editor.colorize(content, language, { tabSize: 2 });
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
}: {
  file: FileDoc;
  provider: WebsocketProvider;
  settings: Settings;
  dark: boolean;
  onPosition: (line: number, col: number) => void;
  onEditor: (editor: monaco.editor.IStandaloneCodeEditor | null) => void;
  readOnly: boolean;
  onCreateBlock?: (content: string, language: string) => void;
}) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null),
    bindingRef = useRef<MonacoBinding | null>(null),
    undoRef = useRef<Y.UndoManager | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const createBlockRef = useRef(onCreateBlock);
  createBlockRef.current = onCreateBlock;
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
    cleanup.current = () => {
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
        lineNumbers: settings.lineNumbers ? "on" : "off",
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
        contextmenu: true,
      }}
    />
  );
}
