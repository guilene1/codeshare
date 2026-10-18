import { test, expect, type Page } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers";

// Regression guard: every reader (Owner, Editor, registered Viewer, anonymous student)
// keeps a Copy button on every code block, and copying is exact. Permission changes must
// never remove it; view-only readers still cannot change anything.
const FENCE = "```";
const TAB = "\t";
// One block per supported language (and common fence aliases), each with indentation,
// tabs, trailing spaces, blank lines and characters that are easy to mangle.
const BLOCKS: [string, string][] = [
  ["bash", 'export NAME="Kodelumi $USER"\nif [ -n "$NAME" ]; then\n  echo "${NAME}" | grep -E \'^K\' && ls ~/*.tf 2>&1 \\\n    | tee out.log   \nfi'],
  ["sh", "set -euo pipefail\nfor f in *.yaml; do\n" + TAB + 'kubectl apply -f "$f"\ndone'],
  ["shell", "$ kubectl get pods -n kube-system\n\n$ echo 'a\\tb' > /tmp/x && cat /tmp/x"],
  ["yaml", "apiVersion: v1\nkind: Pod\nmetadata:\n  name: web # comment\n  labels: { app: \"web\", tier: 'front' }\nspec:\n  containers:\n    - name: nginx\n      image: nginx:1.27\n      args: [\"--port\", \"8080\"]"],
  ["terraform", 'provider "aws" {\n  region = "us-east-1"\n}\n\nresource "aws_s3_bucket" "b" {\n  bucket = "${var.prefix}-logs"\n  tags   = { Name = "logs" }\n}'],
  ["hcl", 'variable "zones" {\n  type    = list(string)\n  default = ["a", "b"]\n}'],
  ["python", 'def greet(name: str) -> str:\n    """Say hi."""\n    if name:\n        return f"Hello, {name}!\\n"\n\n    return r"C:\\path\\to"\n\nprint(greet("Zoë 🚀"))'],
  ["json", '{\n  "name": "kodelumi",\n  "tags": ["a", "b"],\n  "nested": { "quote": "\\"x\\"", "path": "C:\\\\tmp" },\n  "n": 1.5e3\n}'],
  ["javascript", "const add = (a, b) => a + b;\nconsole.log(`sum: ${add(1, 2)}`); // <done> & ok"],
  ["typescript", "type User = { id: number; name?: string };\nexport function f<T extends User>(u: T): T {\n  return { ...u };\n}"],
  ["java", 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hi\\n");\n    }\n}'],
  ["go", 'package main\n\nimport "fmt"\n\nfunc main() {\n' + TAB + 'fmt.Printf("%d%%\\n", 42)\n}'],
  ["dockerfile", "FROM node:24-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci && \\\n    npm run build\nCMD [\"node\", \"index.js\"]"],
  ["sql", "SELECT u.id, COUNT(*) AS n\nFROM users u\nWHERE u.email LIKE '%@example.test'\nGROUP BY u.id;"],
  ["powershell", "$files = Get-ChildItem -Path C:\\Temp -Filter *.log\n$files | ForEach-Object { Write-Host \"$($_.Name)\" }"],
  ["xml", '<?xml version="1.0"?>\n<root attr="a &amp; b">\n  <item>1 &lt; 2</item>\n</root>'],
  ["toml", '[server]\nhost = "0.0.0.0"\nport = 8080\n\n[db]\nurl = "postgres://u:p@h/db"'],
  ["ruby", 'def hi(name)\n  puts "Hi #{name}"\nend'],
  ["html", '<button class="x" onclick="go()">Go &rarr;</button>\n<p>Tom &amp; Jerry</p>'],
  ["css", ".card > .title::after {\n  content: \"\\2192\";\n  color: #38bdf8 !important;\n}"],
  ["markdown", "# Title\n\n- item *one*\n- item `two`"],
  ["plaintext", "Plain text   with    spaces\n" + TAB + "and a tab\n\n\nand blank lines"],
  ["", "#!/bin/bash\necho no language set"],
];
const LESSON = BLOCKS.map(([lang, code]) => `## ${lang || "none"}\n\n${FENCE}${lang}\n${code}\n${FENCE}`).join("\n\n");
const NOTES_BLOCKS = ["git clone https://github.com/example/repo.git\ncd repo", "  indented first line\n" + TAB + "tabbed second line  "];
const NOTES = `Plain text notes\n\n${FENCE}bash\n${NOTES_BLOCKS[0]}\n${FENCE}\n\nMore text\n\n${FENCE}\n${NOTES_BLOCKS[1]}\n${FENCE}`;
const SNIPPETS = [
  { title: "Terraform Provider", language: "hcl", content: 'provider "aws" {\n  region = "us-east-1"\n}\n' },
  { title: "", language: "shell", content: "terraform init -upgrade && terraform plan -out=tf.plan" },
  { title: "Config", language: "yaml", content: "a:\n  b: [1, 2]\n" + TAB + "# tab" },
];

// Owner API setup through the page (same as the UI calls), returning the workspace id.
async function setUp(page: Page, viewerEmail: string, editorEmail: string) {
  return page.evaluate(
    async ({ lesson, notes, snippets, viewerEmail, editorEmail }) => {
      const id = location.pathname.split("/")[2];
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const call = async (path: string, body: unknown) =>
        (
          await fetch(`/api/rooms/${id}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
            body: JSON.stringify(body),
          })
        ).status;
      const statuses = [
        await call("/documents", { filename: "lesson.md", language: "markdown", content: lesson }),
        await call("/documents", { filename: "notes.txt", language: "plaintext", content: notes }),
        ...(await Promise.all(snippets.map((s) => call("/blocks", s)))),
        await call("/shares", { email: viewerEmail, role: "viewer" }),
        await call("/shares", { email: editorEmail, role: "editor" }),
      ];
      return { id, statuses };
    },
    { lesson: LESSON, notes: NOTES, snippets: SNIPPETS, viewerEmail, editorEmail },
  );
}

// Records the exact string handed to the clipboard (compared byte for byte), since the OS
// clipboard may turn \n into \r\n on read (Windows).
const RECORD_COPIES = () => {
  const write = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = (text: string) => {
    (window as unknown as { lastCopy: string }).lastCopy = text;
    return write(text);
  };
};
async function clipboard(page: Page) {
  const { exact, system } = await page.evaluate(async () => ({
    exact: (window as unknown as { lastCopy: string }).lastCopy,
    system: await navigator.clipboard.readText(),
  }));
  expect(system.replace(/\r\n/g, "\n")).toBe(exact);
  return exact;
}

// Clicks each code block's Copy button in the open document and checks the exact text.
async function copyEveryInlineBlock(page: Page, expected: string[]) {
  const blocks = page.locator(".markdown-preview .inline-block");
  await expect(blocks).toHaveCount(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const block = blocks.nth(i);
    await block.scrollIntoViewIfNeeded();
    await page.evaluate(() => navigator.clipboard.writeText("(empty)"));
    await block.getByRole("button", { name: "Copy code" }).click();
    await expect(block.getByRole("button", { name: "Copied!" })).toBeVisible();
    expect(await clipboard(page), `block ${i} (${BLOCKS[i]?.[0] ?? "notes"})`).toBe(expected[i]);
  }
}

async function openDocument(page: Page, filename: string) {
  await page.locator(".sidebar").getByRole("button", { name: filename, exact: true }).click();
  await expect(page.locator(".markdown-preview .inline-block").first()).toBeVisible();
}

// The view-only interface: Copy on code blocks, but no editing, file-level Copy/Download,
// image "Original" link or management controls; write requests are refused.
async function expectStillReadOnly(page: Page, id: string, signedIn: boolean) {
  await expect(page.getByLabel("Workspace access")).toContainText("View Only");
  for (const label of [
    "Copy file",
    "Download file",
    "Copy workspace link",
    "Share",
    "Edit",
    "Edit code block",
    "Insert Code Block",
    "New file",
    "Rename file",
    "Delete file",
    "Add Code Block",
    "Delete block",
  ])
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  await expect(page.locator(".inline-block-set")).toHaveCount(0);
  const statuses = await page.evaluate(
    async ({ id, signedIn }) => {
      const csrf = signedIn ? (await (await fetch("/api/auth/me")).json()).csrfToken : undefined;
      const headers = {
        "content-type": "application/json",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      };
      const tree = await (await fetch(`/api/rooms/${id}/tree`)).json();
      const docId = tree.documents[0].id;
      const blockId = (await (await fetch(`/api/rooms/${id}/blocks`)).json()).blocks[0].id;
      const send = async (method: string, path: string, body?: unknown) =>
        (
          await fetch(`/api/rooms/${id}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        ).status;
      return [
        await send("POST", "/documents", { filename: "evil.md", content: "x" }),
        await send("PATCH", `/documents/${docId}`, { filename: "renamed.md" }),
        await send("DELETE", `/documents/${docId}`),
        await send("PATCH", `/blocks/${blockId}`, { content: "changed" }),
        await send("DELETE", `/blocks/${blockId}`),
        await send("PATCH", "", { name: "Renamed" }),
      ];
    },
    { id, signedIn },
  );
  expect(statuses).toEqual([403, 403, 403, 403, 403, 403]);
}

test("every reader can copy every code block exactly; view-only stays read-only", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const permissions = ["clipboard-read", "clipboard-write"];
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext({ permissions })));
  await Promise.all(contexts.map((c) => c.addInitScript(RECORD_COPIES)));
  const [owner, vera, ed, student] = await Promise.all(contexts.map((c) => c.newPage()));
  const errors: string[] = [];
  for (const page of [owner, vera, ed, student]) page.on("pageerror", (e) => errors.push(e.message));
  try {
    const veraEmail = await signUp(vera, "Vera Viewer", uniqueEmail("vera"));
    const edEmail = await signUp(ed, "Ed Editor", uniqueEmail("ed"));
    await signUp(owner, "Olivia Owner");
    const url = await createWorkspace(owner, "Copy everything lab");
    const { id, statuses } = await setUp(owner, veraEmail, edEmail);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 201]);
    const expected = BLOCKS.map(([, code]) => code);
    const snapshot = () =>
      owner.evaluate(async (id) => {
        const tree = await (await fetch(`/api/rooms/${id}/tree`)).json();
        const blocks = (await (await fetch(`/api/rooms/${id}/blocks`)).json()).blocks;
        return {
          files: tree.documents.map((d: { filename: string }) => d.filename).sort(),
          blocks: blocks.map((b: { content: string }) => b.content),
        };
      }, id);
    const before = await snapshot();
    expect(before.files).toEqual(expect.arrayContaining(["lesson.md", "notes.txt"]));
    expect(before.blocks).toEqual(SNIPPETS.map((s) => s.content));

    const readers: [string, Page, "owner" | "editor" | "viewer"][] = [
      ["owner", owner, "owner"],
      ["editor account", ed, "editor"],
      ["viewer account", vera, "viewer"],
      ["anonymous student", student, "viewer"],
    ];
    for (const [who, page, role] of readers) {
      await test.step(`${who}: Copy on every block`, async () => {
        await page.goto(url);
        await expect(page.getByLabel("Workspace access")).toContainText(
          role === "viewer" ? "View Only" : "Editing",
        );
        await openDocument(page, "lesson.md");
        await copyEveryInlineBlock(page, expected);
        await openDocument(page, "notes.txt");
        await copyEveryInlineBlock(page, NOTES_BLOCKS);
        // Legacy snippets panel: compact commands and titled blocks alike.
        await page.getByRole("button", { name: /Legacy snippets/ }).click();
        const cards = page.locator(".snippet-card");
        await expect(cards).toHaveCount(SNIPPETS.length);
        for (let i = 0; i < SNIPPETS.length; i++) {
          await page.evaluate(() => navigator.clipboard.writeText("(empty)"));
          await cards.nth(i).getByRole("button", { name: "Copy", exact: true }).click();
          await expect(cards.nth(i).getByRole("button", { name: "Copied!" })).toBeVisible();
          expect(await clipboard(page), `snippet ${i}`).toBe(SNIPPETS[i].content);
        }
        if (role === "viewer") {
          await page.getByRole("button", { name: /Files & Editor/ }).click();
          await openDocument(page, "lesson.md");
          await expectStillReadOnly(page, id, who !== "anonymous student");
        }
      });
    }
    // Copying and the refused writes changed nothing: same files and snippets as before.
    expect(await snapshot()).toEqual(before);
    await student.screenshot({ path: "test-results/copy-student-view-only.png" });
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
  }
});
