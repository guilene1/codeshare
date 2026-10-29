import { expect, test, type Page } from "@playwright/test";

export const PASSWORD = "Correct-Horse-Battery-42";
export const uniqueEmail = (prefix = "instructor") =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

// Registers through the real Sign Up page and lands on My Workspaces.
export async function signUp(page: Page, displayName = "Instructor", email = uniqueEmail()) {
  await page.goto("/signup");
  await page.getByLabel("Display name").fill(displayName);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
  return email;
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
}

// Creates a workspace from My Workspaces and waits until the owner is editing live.
export async function createWorkspace(
  page: Page,
  name: string,
  options: { template?: string; description?: string } = {},
) {
  if (!/\/workspaces$/.test(page.url())) await page.goto("/workspaces");
  await page
    .locator(".workspace-dashboard")
    .getByRole("button", { name: "Create Workspace", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Workspace name").fill(name);
  if (options.description)
    await dialog.getByLabel(/Description/).fill(options.description);
  if (options.template) await dialog.getByText(options.template, { exact: true }).click();
  const create = () =>
    Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/rooms"),
      dialog.getByRole("button", { name: "Create Workspace", exact: true }).click(),
    ]).then(([response]) => response);
  let response = await create();
  // The server allows 10 new workspaces per minute per IP, and the whole suite runs from one
  // IP: wait out the limit (as the server's Retry-After says) and create it once more.
  if (response.status() === 429) {
    const wait = Number(response.headers()["retry-after"] ?? 60);
    console.log(`createWorkspace: rate limited, retrying in ${wait}s`);
    test.info().setTimeout(test.info().timeout + (wait + 5) * 1000);
    await page.waitForTimeout((wait + 1) * 1000);
    response = await create();
  }
  expect(response.status()).toBe(201);
  await expect(page.getByLabel("Workspace access")).toContainText("Editing");
  await expect(page.locator(".status-bar")).toContainText("Connected");
  expect(page.url()).not.toContain("/edit/");
  return page.url().split("?")[0];
}

// Documents (Markdown, Plain Text) open in Preview. Tests that type into the source switch
// view first; the choice then holds for the rest of the page session.
export async function chooseDocumentView(page: Page, view: "Edit" | "Split" | "Preview") {
  const button = page.locator(".markdown-switch").getByRole("button", { name: view, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

// Opens a file from the Explorer (tabs only show files the user has opened).
export async function openFromExplorer(page: Page, filename: string) {
  await page
    .locator(".sidebar")
    .getByRole("button", { name: filename, exact: true })
    .click();
  await expect(page.getByRole("tab", { name: filename, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}
