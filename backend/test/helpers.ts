import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { createApp } from "../src/app.js";

type App = ReturnType<typeof createApp>;
export const PASSWORD = "Correct-Horse-Battery-42";
export const DEFAULT_ORIGIN = "http://localhost:3000";

// Registers a fresh account and returns headers for cookie-authenticated requests.
export async function signUp(
  base: string,
  origin = DEFAULT_ORIGIN,
  displayName = "Course Owner",
) {
  const email = `owner-${randomUUID()}@example.test`;
  const response = await fetch(base + "/api/auth/signup", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      displayName,
      email,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const body = (await response.json()) as {
    csrfToken: string;
    user: { id: string; displayName: string };
  };
  return {
    email,
    user: body.user,
    cookie,
    csrfToken: body.csrfToken,
    headers: { origin, cookie, "x-csrf-token": body.csrfToken },
  };
}

const owners = new WeakMap<App, Promise<Awaited<ReturnType<typeof signUp>>>>();
// Creates a workspace through the authenticated REST API. When the v1 test supplies an
// `editorTokenHash`, the workspace is turned into an unclaimed legacy workspace that is
// editable only through that private link, which is exactly how v1 data looks after the
// migration, so the original capability tests keep exercising the legacy path.
export async function createRoom(
  app: App,
  base: string,
  body: Record<string, unknown>,
  origin = DEFAULT_ORIGIN,
  signupOrigin = origin,
) {
  if (!owners.has(app)) owners.set(app, signUp(base, signupOrigin));
  const owner = await owners.get(app)!;
  const { editorTokenHash, ...fields } = body;
  const response = await fetch(base + "/api/rooms", {
    method: "POST",
    headers: {
      ...owner.headers,
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(fields),
  });
  const text = await response.text();
  if (response.status === 201 && typeof editorTokenHash === "string")
    app.rooms.db
      .prepare("UPDATE rooms SET editor_token_hash=?,owner_id=NULL WHERE id=?")
      .run(editorTokenHash, JSON.parse(text).id);
  return new Response(text, {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}
