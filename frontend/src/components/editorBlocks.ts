// Interactive code blocks inside Monaco for documents (Markdown and Plain Text).
// Blocks are stored as ordinary fenced text, so they collaborate through Yjs and
// survive download; this module only adds typing shortcuts and in-editor rendering.
import * as monaco from "monaco-editor";
import { languages } from "../lib";
import {
  fenceBlocks,
  isLanguageName,
  languageId,
  languageLabel,
  type FenceBlock,
} from "../markdown";

type Options = {
  isDocument: () => boolean;
  readOnly: boolean;
};

export function attachDocumentBlocks(
  editor: monaco.editor.IStandaloneCodeEditor,
  { isDocument, readOnly }: Options,
) {
  const disposables: monaco.IDisposable[] = [];
  const decorations = editor.createDecorationsCollection();
  const widgets: BlockWidget[] = [];
  const model = () => editor.getModel();
  const lines = () => model()?.getLinesContent() ?? [];
  const insertAt = (lineNumber: number, column: number, text: string) =>
    editor.executeEdits("devshare-block", [
      {
        range: new monaco.Range(lineNumber, column, lineNumber, column),
        text,
      },
    ]);

  if (!readOnly) {
    // 1. Typing the third backtick at the start of a line creates a block and puts
    //    the cursor inside it, ready to type or paste code.
    disposables.push(
      editor.onDidChangeModelContent((event) => {
        if (
          !isDocument() ||
          event.isUndoing ||
          event.isRedoing ||
          event.changes.length !== 1 ||
          event.changes[0].text !== "`" ||
          // Remote collaborator edits arrive as model edits too; only react to our own typing.
          !editor.hasTextFocus()
        )
          return;
        const lineNumber = event.changes[0].range.startLineNumber;
        setTimeout(() => {
          const current = model(),
            position = editor.getPosition();
          if (!current || !position || position.lineNumber !== lineNumber) return;
          const line = current.getLineContent(lineNumber);
          const open = /^(\s*)```$/.exec(line);
          if (!open || position.column !== line.length + 1) return;
          const block = fenceBlocks(lines()).find((b) => b.open === lineNumber - 1);
          if (!block || block.close !== -1) return;
          insertAt(lineNumber, line.length + 1, `\n${open[1]}\n${open[1]}\`\`\``);
          editor.setPosition({ lineNumber: lineNumber + 1, column: open[1].length + 1 });
        });
      }),
    );
    disposables.push(
      editor.onKeyDown((event) => {
        if (
          !isDocument() ||
          event.keyCode !== monaco.KeyCode.Enter ||
          event.shiftKey ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        const current = model(),
          position = editor.getPosition();
        if (!current || !position || !editor.getSelection()?.isEmpty()) return;
        const line = current.getLineContent(position.lineNumber);
        if (position.column !== line.length + 1) return;
        const index = position.lineNumber - 1;
        const blocks = fenceBlocks(lines());
        // 2. Enter after an unclosed opening fence (e.g. typed or pasted ```bash)
        //    adds the closing fence.
        const unclosed = blocks.find((b) => b.open === index && b.close === -1);
        if (unclosed) {
          event.preventDefault();
          event.stopPropagation();
          const indent = /^\s*/.exec(line)![0];
          insertAt(position.lineNumber, position.column, `\n${indent}\n${indent}${unclosed.marks}`);
          editor.setPosition({ lineNumber: position.lineNumber + 1, column: indent.length + 1 });
          return;
        }
        // 3. Typing a language name ("bash", "python"…) as the first line of a new
        //    block and pressing Enter sets the block's language instead.
        const block = blocks.find((b) => b.open === index - 1 && b.close > index);
        if (block && !block.info && isLanguageName(line)) {
          event.preventDefault();
          event.stopPropagation();
          const opening = current.getLineContent(position.lineNumber - 1);
          editor.executeEdits("devshare-block", [
            {
              range: new monaco.Range(
                position.lineNumber - 1,
                1,
                position.lineNumber - 1,
                opening.length + 1,
              ),
              text: opening.replace(/\s*$/, "") + line.trim().toLowerCase(),
            },
            {
              range: new monaco.Range(position.lineNumber, 1, position.lineNumber, line.length + 1),
              text: /^\s*/.exec(line)![0],
            },
          ]);
          editor.setPosition({
            lineNumber: position.lineNumber,
            column: /^\s*/.exec(line)![0].length + 1,
          });
        }
      }),
    );
  }

  // 4. Render each closed block as a container with a header: language + Copy code.
  let scheduled = 0;
  const render = () => {
    scheduled = 0;
    const blocks = isDocument() ? fenceBlocks(lines()).filter((b) => b.close > b.open) : [];
    decorations.set(
      blocks.flatMap((block) => {
        const items: monaco.editor.IModelDeltaDecoration[] = [];
        for (let line = block.open; line <= block.close; line++)
          items.push({
            range: new monaco.Range(line + 1, 1, line + 1, 1),
            options: {
              isWholeLine: true,
              className:
                line === block.open
                  ? "doc-block-line doc-block-open"
                  : line === block.close
                    ? "doc-block-line doc-block-close"
                    : "doc-block-line",
            },
          });
        for (const line of [block.open, block.close])
          items.push({
            range: new monaco.Range(line + 1, 1, line + 1, lines()[line].length + 1),
            options: { inlineClassName: "doc-fence-marks" },
          });
        return items;
      }),
    );
    while (widgets.length > blocks.length) {
      const widget = widgets.pop()!;
      editor.removeContentWidget(widget);
    }
    blocks.forEach((block, index) => {
      if (!widgets[index]) {
        // Monaco reads the position while adding, so the block must be set first.
        widgets[index] = new BlockWidget(editor, index, readOnly);
        widgets[index].update(block);
        editor.addContentWidget(widgets[index]);
      } else {
        widgets[index].update(block);
        editor.layoutContentWidget(widgets[index]);
      }
    });
  };
  const schedule = () => {
    if (!scheduled) scheduled = requestAnimationFrame(render);
  };
  disposables.push(editor.onDidChangeModelContent(schedule));
  disposables.push(editor.onDidChangeModelLanguage(schedule));
  schedule();
  return () => {
    cancelAnimationFrame(scheduled);
    disposables.forEach((d) => d.dispose());
    decorations.clear();
    widgets.forEach((widget) => editor.removeContentWidget(widget));
  };
}

// The block header shown at the end of the opening fence line.
class BlockWidget implements monaco.editor.IContentWidget {
  allowEditorOverflow = false;
  suppressMouseDown = true;
  private node = document.createElement("div");
  private label: HTMLElement;
  private copyButton = document.createElement("button");
  private block!: FenceBlock;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private editor: monaco.editor.IStandaloneCodeEditor,
    private index: number,
    readOnly: boolean,
  ) {
    this.node.className = "doc-block-toolbar";
    if (readOnly) {
      this.label = document.createElement("span");
      this.label.className = "doc-block-language";
    } else {
      const select = document.createElement("select");
      select.className = "doc-block-language";
      select.setAttribute("aria-label", "Language of this code block");
      for (const [id, name] of languages) select.add(new Option(name, id));
      select.addEventListener("change", () => this.setLanguage(select.value));
      this.label = select;
    }
    this.copyButton.type = "button";
    this.copyButton.className = "doc-block-copy";
    this.copyButton.textContent = "Copy code";
    this.copyButton.addEventListener("click", () => void this.copy());
    this.node.append(this.label, this.copyButton);
  }
  getId() {
    return "devshare.codeBlock." + this.index;
  }
  getDomNode() {
    return this.node;
  }
  getPosition(): monaco.editor.IContentWidgetPosition {
    const line = this.block.open + 1;
    return {
      position: {
        lineNumber: line,
        column: this.editor.getModel()!.getLineMaxColumn(line),
      },
      preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
    };
  }
  update(block: FenceBlock) {
    this.block = block;
    const id = block.info ? languageId(block.info) : "plaintext";
    if (this.label instanceof HTMLSelectElement) this.label.value = id;
    else this.label.textContent = block.info ? languageLabel(block.info) : "Plain text";
  }
  private code() {
    return this.editor
      .getModel()!
      .getLinesContent()
      .slice(this.block.open + 1, this.block.close)
      .map((line) => line.replace(/\r$/, ""))
      .join("\n");
  }
  private async copy() {
    try {
      await navigator.clipboard.writeText(this.code());
      this.copyButton.textContent = "Copied!";
    } catch {
      this.copyButton.textContent = "Select and press Ctrl+C";
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => (this.copyButton.textContent = "Copy code"), 2000);
  }
  private setLanguage(id: string) {
    const model = this.editor.getModel()!,
      line = this.block.open + 1,
      text = model.getLineContent(line);
    const fence = /^(\s*)(`{3,}|~{3,})/.exec(text);
    if (!fence) return;
    this.editor.executeEdits("devshare-block", [
      {
        range: new monaco.Range(line, 1, line, text.length + 1),
        text: fence[1] + fence[2] + (id === "plaintext" ? "" : id),
      },
    ]);
    this.editor.focus();
  }
}
