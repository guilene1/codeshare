import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createWorkspace, PASSWORD, signIn, signUp, uniqueEmail } from "./helpers";

// Simulates a v1 workspace (unowned, editable only through its private link) with the
// operator script, against the Docker preview or the test-managed local database.
function makeUnowned(id: string) {
  if (process.env.DEVSHARE_BASE_URL)
    execFileSync("docker", [
      "compose",
      "-p",
      process.env.DEVSHARE_COMPOSE_PROJECT ?? "devshare-local",
      "exec",
      "-T",
      "application",
      "node",
      "scripts/assign-owner.mjs",
      id,
      "--unowned",
    ]);
  else
    execFileSync("node", ["scripts/assign-owner.mjs", id, "--unowned"], {
      env: { ...process.env, DB_PATH: "data/e2e.sqlite" },
    });
}
async function coEditorLink(page: Page) {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("button", { name: "Create co-editor link", exact: true }).click();
  const link = await page.getByLabel("Private editor link", { exact: true }).inputValue();
  await page.getByRole("button", { name: "Close dialog" }).click();
  return link;
}

test("sign up, sign out and sign in with HttpOnly sessions and no stored credentials", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("link", { name: "Sign Up" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.screenshot({ path: "test-results/signup.png" });
  await page.getByLabel("Display name").fill("Ada Lovelace");
  const email = uniqueEmail("ada");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD + "x");
  await expect(page.getByText("The passwords do not match.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Account" })).toBeDisabled();
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByLabel("Confirm password").fill("password123");
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("alert")).toContainText("less predictable");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
  const nav = page.getByRole("banner");
  for (const label of ["My Workspaces", "Create Workspace", "Ada Lovelace", "Sign Out"])
    await expect(nav.getByText(label, { exact: true })).toBeVisible();
  // The session cookie is HttpOnly; nothing secret is kept in web storage.
  expect(await page.evaluate(() => document.cookie)).not.toContain("devshare_sid");
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name.endsWith("devshare_sid"))!;
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe("Lax");
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }).match(/[\w-]{43}/),
    ),
  ).toBeNull();
  await page.screenshot({ path: "test-results/dashboard-empty.png" });
  await page.getByRole("button", { name: "Sign Out" }).click();
  await expect(page.getByRole("link", { name: "Sign In" })).toBeVisible();
  await page.goto("/workspaces");
  await expect(page).toHaveURL(/\/signin\?next=%2Fworkspaces$/);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("wrong-password-1");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Email or password is incorrect.");
  await page.screenshot({ path: "test-results/signin.png" });
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
  await page.getByRole("link", { name: /Ada Lovelace/ }).click();
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await page.screenshot({ path: "test-results/account.png", fullPage: true });
  await page.goto("/forgot-password");
  await expect(page.getByText("does not send email yet")).toBeVisible();
  expect(errors).toEqual([]);
});

test("users cannot see or change each other's workspaces; public links stay view-only for signed-in users", async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  const alice = await a.newPage(),
    bob = await b.newPage();
  try {
    await signUp(alice, "Alice");
    const url = await createWorkspace(alice, "Alice private course");
    const id = url.split("/").pop()!;
    await signUp(bob, "Bob");
    await expect(bob.getByText("Your workspace starts here.")).toBeVisible();
    await expect(bob.getByText("Alice private course")).toHaveCount(0);
    await bob.goto(url);
    await expect(bob.getByLabel("Workspace access")).toContainText("View Only");
    await expect(bob.getByLabel("Your name")).toHaveCount(0);
    await expect(bob.getByRole("button", { name: "New file", exact: true })).toHaveCount(0);
    const statuses = await bob.evaluate(async (room) => {
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const call = async (path: string, method: string, body?: unknown) =>
        (
          await fetch("/api/rooms/" + room + path, {
            method,
            headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        ).status;
      return [
        await call("", "PATCH", { name: "Taken" }),
        await call("", "DELETE"),
        await call("/documents", "POST", { filename: "x.tf", language: "hcl" }),
        await call("/claim", "POST", {}),
        await call("/editor-link", "POST", {}),
        await call("/summary", "GET"),
      ];
    }, id);
    expect(statuses).toEqual([403, 403, 403, 403, 403, 404]);
    await expect(alice.getByLabel("Workspace access")).toContainText("Editing");
    await alice.reload();
    await expect(alice.locator(".room-title")).toContainText("Alice private course");
  } finally {
    await a.close();
    await b.close();
  }
});

test("v1 workspaces are claimed once with their editor link, and remembered v1 shortcuts import into the account", async ({
  browser,
}) => {
  const a = await browser.newContext(),
    c = await browser.newContext(),
    d = await browser.newContext();
  const alice = await a.newPage(),
    carol = await c.newPage(),
    dave = await d.newPage();
  try {
    await signUp(alice, "Alice");
    const firstUrl = await createWorkspace(alice, "v1 Terraform class");
    const firstLink = await coEditorLink(alice);
    await alice.goto("/workspaces");
    const secondUrl = await createWorkspace(alice, "v1 Python class");
    const secondLink = await coEditorLink(alice);
    makeUnowned(firstUrl.split("/").pop()!);
    makeUnowned(secondUrl.split("/").pop()!);
    // Opening a v1 editor link while signed out offers sign-in, then claiming.
    await carol.goto(firstLink);
    await carol.getByLabel("Your name").fill("Carol");
    await carol.getByRole("button", { name: "Open Workspace" }).click();
    await expect(carol.getByLabel("Workspace access")).toContainText("Editing");
    await expect(carol.getByRole("region", { name: "Claim workspace" })).toBeVisible();
    await carol.getByRole("region", { name: "Claim workspace" }).getByRole("button", { name: "Sign in" }).click();
    await carol.getByRole("link", { name: "Create an account" }).click();
    await carol.getByLabel("Display name").fill("Carol Claimer");
    await carol.getByLabel("Email address").fill(uniqueEmail("carol"));
    await carol.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await carol.getByLabel("Confirm password").fill(PASSWORD);
    await carol.getByRole("button", { name: "Create Account" }).click();
    await expect(carol).toHaveURL(firstLink);
    await carol.screenshot({ path: "test-results/claim-banner.png" });
    await carol.getByRole("button", { name: "Add to my account" }).click();
    await expect(carol).toHaveURL(firstUrl);
    await expect(carol.getByLabel("Workspace access")).toContainText("Editing");
    await expect(carol.getByRole("region", { name: "Claim workspace" })).toHaveCount(0);
    await carol.getByRole("button", { name: "My Workspaces", exact: true }).click();
    await expect(carol.getByRole("article", { name: "v1 Terraform class" })).toBeVisible();
    // The v1 editor link keeps working for content after the claim.
    const anonymous = await (await browser.newContext()).newPage();
    await anonymous.goto(firstLink);
    await anonymous.getByLabel("Your name").fill("Co-teacher");
    await anonymous.getByRole("button", { name: "Open Workspace" }).click();
    await expect(anonymous.getByLabel("Workspace access")).toContainText("Editing");
    await expect(anonymous.getByRole("region", { name: "Claim workspace" })).toHaveCount(0);
    await anonymous.context().close();
    // A second account cannot claim it again.
    await signUp(dave, "Dave");
    const repeat = await dave.evaluate(async (link) => {
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const [, , id, , token] = new URL(link).pathname.split("/");
      return (
        await fetch(`/api/rooms/${id}/claim`, {
          method: "POST",
          headers: { authorization: "Bearer " + token, "x-csrf-token": csrfToken },
        })
      ).status;
    }, firstLink);
    expect(repeat).toBe(409);
    // v1 kept editor shortcuts in localStorage; v2 imports them once and deletes them.
    const [, , secondId, , secondToken] = new URL(secondLink).pathname.split("/");
    await dave.evaluate(
      ([id, token]) =>
        localStorage.setItem(
          "devshare.workspaces.v1",
          JSON.stringify([{ id, token, name: "v1 Python class", lastOpened: Date.now() }]),
        ),
      [secondId, secondToken],
    );
    await dave.reload();
    const banner = dave.getByRole("region", { name: "Import workspaces" });
    await expect(banner).toContainText("1 workspace saved in this browser");
    await dave.screenshot({ path: "test-results/import-banner.png" });
    await banner.getByRole("button", { name: "Add to my account" }).click();
    await expect(dave.getByRole("article", { name: "v1 Python class" })).toBeVisible();
    expect(await dave.evaluate(() => localStorage.getItem("devshare.workspaces.v1"))).toBeNull();
  } finally {
    await a.close();
    await c.close();
    await d.close();
  }
});

test("changing the password signs out other devices", async ({ browser }) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  const phone = await a.newPage(),
    laptop = await b.newPage();
  try {
    const email = await signUp(phone, "Grace");
    await signIn(laptop, email);
    await phone.goto("/account");
    const next = "Another-Strong-Pass-77";
    await phone.getByLabel("Current password").fill(PASSWORD);
    await phone.getByLabel("New password", { exact: true }).fill(next);
    await phone.getByLabel("Confirm new password").fill(next);
    await phone.getByRole("button", { name: "Change password" }).click();
    await expect(phone.getByRole("status")).toContainText("Other devices were signed out");
    await laptop.reload();
    await expect(laptop).toHaveURL(/\/signin/);
    await signIn(laptop, email, next);
  } finally {
    await a.close();
    await b.close();
  }
});
