import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as sync from "y-protocols/sync";
import * as awareness from "y-protocols/awareness";
import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import { Rooms, validateDocument, type Actor, type Room } from "./rooms.js";
import {
  hashEditorToken,
  TOKEN_PATTERN,
  workspaceAccess,
  type Auth,
} from "./access.js";
import type { Accounts } from "./auth.js";

function send(peer: WebSocket, data: Uint8Array) {
  if (peer.readyState === WebSocket.OPEN) {
    if (peer.bufferedAmount > 4 * 1024 * 1024)
      peer.close(1013, "Slow connection");
    else peer.send(data);
  }
}
// Message type 4 (Kodelumi): JSON presence and activity, sent only to Owners and Editors.
const MESSAGE_JSON = 4;
function awarenessMessage(room: Room, ids: number[]) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint8Array(
    enc,
    awareness.encodeAwarenessUpdate(room.awareness, ids),
  );
  return encoding.toUint8Array(enc);
}
// View-only (and untracked) sockets receive Editors' states (classroom cursors) but never
// other viewers'.
function sendAwareness(rooms: Rooms, room: Room, peer: WebSocket, ids: number[]) {
  const visible = rooms.canSeePresence(peer)
    ? ids
    : ids.filter((id) => !room.viewerIds.has(id));
  if (visible.length) send(peer, awarenessMessage(room, visible));
}
function wire(rooms: Rooms, room: Room) {
  if (room.dispose) return;
  const update = (data: Uint8Array) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    sync.writeUpdate(enc, data);
    for (const peer of room.peers.keys())
      send(peer, encoding.toUint8Array(enc));
  };
  const presence = (
    {
      added,
      updated,
      removed,
    }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin instanceof WebSocket) {
      const ids = room.peers.get(origin);
      added.forEach((id) => ids?.add(id));
      removed.forEach((id) => ids?.delete(id));
    }
    removed.forEach((id) => room.awarenessOwners.delete(id));
    const ids = [...added, ...updated, ...removed],
      editorIds = ids.filter((id) => !room.viewerIds.has(id));
    let full: Uint8Array | undefined, editorsOnly: Uint8Array | undefined;
    for (const peer of room.peers.keys()) {
      if (rooms.canSeePresence(peer)) {
        full ??= awarenessMessage(room, ids);
        send(peer, full);
      } else {
        if (!editorIds.length) continue;
        editorsOnly ??= awarenessMessage(room, editorIds);
        send(peer, editorsOnly);
      }
    }
    removed.forEach((id) => room.viewerIds.delete(id));
  };
  room.doc.on("update", update);
  room.awareness.on("update", presence);
  room.dispose = () => {
    room.doc.off("update", update);
    room.awareness.off("update", presence);
  };
}
export function setupWebsocket(
  server: Server,
  rooms: Rooms,
  origins: Set<string>,
  accounts: Accounts,
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024 + 256 * 1024,
    perMessageDeflate: false,
    // Never echo the credential subprotocol in the handshake response.
    handleProtocols: (protocols) =>
      protocols.has("devshare") ? "devshare" : false,
  });
  rooms.sendJson = (peer, payload) => {
    // Central gate for every presence/activity message, whatever the caller checked.
    if (!rooms.canSeePresence(peer)) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_JSON);
    encoding.writeVarString(enc, JSON.stringify(payload));
    send(peer, encoding.toUint8Array(enc));
  };
  server.on("upgrade", (req, socket, head) => {
    const match = /^\/ws\/([A-Za-z0-9_-]{16})$/.exec(
      (req.url ?? "").split("?")[0],
    );
    if (!match || !req.headers.origin || !origins.has(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    try {
      const folder = new URL(req.url!, "http://localhost").searchParams.get(
        "folder",
      );
      if (folder && !/^[\w-]{36}$/.test(folder))
        throw new Error("Invalid lesson");
      const room = rooms.get(match[1], folder);
      if (!room) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const credentials = (req.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.startsWith("editor."));
      const token = credentials[0]?.slice(7);
      const credentialHash =
        token && TOKEN_PATTERN.test(token) ? hashEditorToken(token) : undefined;
      // Browsers send the session cookie with same-origin upgrades; the Origin check above
      // prevents cross-site WebSocket hijacking.
      const session = accounts.session(accounts.tokenFrom(req));
      const auth: Auth = {
        userId: session?.user.id,
        sessionHash: session?.tokenHash,
        tokenHash: credentialHash,
      };
      const access = () =>
        workspaceAccess(
          rooms.db,
          (hash, user) => accounts.sessionValid(hash, user),
          room.workspaceId,
          auth,
        );
      const canEdit = () => access() !== "viewer";
      // Changes are attributed to the verified account, never to a self-entered name.
      const actor: Actor = session
        ? { kind: "user", id: session.user.id, name: session.user.displayName }
        : { kind: "link" };
      if (
        credentials.length &&
        (credentials.length !== 1 ||
          !rooms.canEditHash(room.workspaceId, credentialHash))
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (peer) => {
        wire(rooms, room);
        room.peers.set(peer, new Set());
        rooms.connections.set(peer, { ...auth, workspaceId: room.workspaceId });
        rooms.live.set(peer, {
          workspaceId: room.workspaceId,
          room,
          access: access(),
          userId: session?.user.id,
          name: session?.user.displayName.slice(0, 40),
        });
        rooms.schedulePresence(room.workspaceId);
        room.touched = Date.now();
        let alive = true,
          count = 0,
          frames = 0,
          windowStart = Date.now();
        const countAccepted = () => {
          if (++count > 120) throw new Error("Too many updates");
        };
        peer.on("pong", () => {
          alive = true;
        });
        const heartbeat = setInterval(() => {
          if (!alive) {
            peer.terminate();
            return;
          }
          alive = false;
          peer.ping();
        }, 30_000);
        peer.on("message", (raw, isBinary) => {
          try {
            if (!isBinary) throw new Error("Binary messages required");
            if (Date.now() - windowStart > 1000) {
              windowStart = Date.now();
              count = 0;
              frames = 0;
            }
            if (++frames > 2000) throw new Error("Too many messages");
            const dec = decoding.createDecoder(new Uint8Array(raw as Buffer)),
              type = decoding.readVarUint(dec);
            // Standard y-websocket clients echo remote awareness states. Those are
            // ignored by ownership checks and must not consume a user's write budget.
            if (type !== 1) countAccepted();
            if (type === 0) {
              const subtype = decoding.readVarUint(dec);
              if (subtype === 0) {
                const enc = encoding.createEncoder();
                encoding.writeVarUint(enc, 0);
                sync.writeSyncStep2(
                  enc,
                  room.doc,
                  decoding.readVarUint8Array(dec),
                );
                send(peer, encoding.toUint8Array(enc));
              } else if (subtype === 1 || subtype === 2) {
                if (!canEdit())
                  throw new Error(
                    "View-only access: document changes are not permitted",
                  );
                const data = decoding.readVarUint8Array(dec),
                  candidate = new Y.Doc();
                const before = room.doc.getMap<Y.Map<unknown>>("documents"),
                  changed: string[] = [];
                // Validate a candidate before applying untrusted CRDT updates to live state.
                try {
                  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
                  Y.applyUpdate(candidate, data);
                  validateDocument(candidate);
                  if (
                    JSON.stringify(candidate.getMap("catalog").toJSON()) !==
                    JSON.stringify(room.doc.getMap("catalog").toJSON())
                  )
                    throw new Error("Use the course API");
                  if (
                    JSON.stringify(candidate.getMap("codeBlocks").toJSON()) !==
                    JSON.stringify(room.doc.getMap("codeBlocks").toJSON())
                  )
                    throw new Error("Use the code block API");
                  if (
                    JSON.stringify(candidate.getMap("workspace").toJSON()) !==
                    JSON.stringify(room.doc.getMap("workspace").toJSON())
                  )
                    throw new Error("Use the workspace API");
                  if (
                    JSON.stringify(candidate.getMap("migrations").toJSON()) !==
                    JSON.stringify(room.doc.getMap("migrations").toJSON())
                  )
                    throw new Error("Use the migration API");
                  const after = candidate.getMap<Y.Map<unknown>>("documents");
                  if (after.size !== before.size)
                    throw new Error("Use the file API");
                  for (const [id, d] of before) {
                    const a = after.get(id);
                    for (const key of [
                      "id",
                      "filename",
                      "language",
                      "createdAt",
                      "updatedAt",
                      "position",
                    ])
                      if (a?.get(key) !== d.get(key))
                        throw new Error("Use the file API");
                    if (
                      (a!.get("content") as Y.Text).toString() !==
                      (d.get("content") as Y.Text).toString()
                    )
                      changed.push(id);
                  }
                } finally {
                  candidate.destroy();
                }
                Y.applyUpdate(room.doc, data, peer);
                room.doc.transact(() => {
                  for (const id of changed)
                    before.get(id)?.set("updatedAt", Date.now());
                });
                for (const id of changed) rooms.noteEdit(room, id, actor);
              } else throw new Error("Unsupported sync message");
            } else if (type === 1) {
              const data = decoding.readVarUint8Array(dec);
              if (data.byteLength > 2 * 1024 * 1024)
                throw new Error("Presence too large");
              const check = decoding.createDecoder(data),
                n = decoding.readVarUint(check);
              // Each encoded state needs at least an ID, clock and string length.
              // Bound malformed batches by their payload, not classroom size.
              if (n > Math.floor(data.byteLength / 3))
                throw new Error("Invalid presence batch");
              const editing = canEdit();
              const accepted: Array<{
                id: number;
                clock: number;
                json: string;
              }> = [];
              for (let i = 0; i < n; i++) {
                const id = decoding.readVarUint(check),
                  clock = decoding.readVarUint(check),
                  json = decoding.readVarString(check);
                // y-websocket echoes remote awareness updates. Ignore other sockets' identities.
                const owner = room.awarenessOwners.get(id);
                const ownedElsewhere = !!owner && owner !== peer;
                const ids = room.peers.get(peer)!;
                if (ownedElsewhere || (ids.size && !ids.has(id))) continue;
                const state = JSON.parse(json);
                if (!ids.size && state === null) continue;
                if (
                  state !== null &&
                  editing &&
                  !session &&
                  (!state.user ||
                    typeof state.user.name !== "string" ||
                    state.user.name.length > 40 ||
                    !/^#[0-9a-f]{6}$/i.test(state.user.color))
                )
                  throw new Error("Invalid presence");
                if (state !== null) {
                  ids.add(id);
                  room.awarenessOwners.set(id, peer);
                  if (!editing) room.viewerIds.add(id);
                  // A link guest's typed name is shown live to Owners and Editors only.
                  const live = rooms.live.get(peer);
                  if (
                    live &&
                    editing &&
                    !session &&
                    live.name !== state.user.name
                  ) {
                    live.name = state.user.name;
                    rooms.schedulePresence(room.workspaceId);
                  }
                }
                // Roles are generated from the verified socket credential, never browser state.
                const safeState =
                  state === null
                    ? null
                    : editing
                      ? {
                          user: {
                            // Signed-in editors are shown by their verified account name.
                            name: session
                              ? session.user.displayName.slice(0, 40)
                              : (state.user.name as string),
                            color: /^#[0-9a-f]{6}$/i.test(state.user?.color)
                              ? state.user.color
                              : "#a78bfa",
                          },
                          fileId:
                            typeof state.fileId === "string"
                              ? state.fileId.slice(0, 80)
                              : undefined,
                          selection: state.selection,
                          role: "editor",
                        }
                      : { viewer: true, role: "viewer" };
                accepted.push({ id, clock, json: JSON.stringify(safeState) });
              }
              if (accepted.length) {
                countAccepted();
                const filtered = encoding.createEncoder();
                encoding.writeVarUint(filtered, accepted.length);
                for (const item of accepted) {
                  encoding.writeVarUint(filtered, item.id);
                  encoding.writeVarUint(filtered, item.clock);
                  encoding.writeVarString(filtered, item.json);
                }
                awareness.applyAwarenessUpdate(
                  room.awareness,
                  encoding.toUint8Array(filtered),
                  peer,
                );
              }
            } else if (type === 3) {
              sendAwareness(rooms, room, peer, [
                ...room.awareness.getStates().keys(),
              ]);
            }
          } catch (error) {
            console.warn(
              "Rejected websocket update:",
              (error as Error).message,
            );
            peer.close(1008, (error as Error).message.slice(0, 100));
          }
        });
        peer.on("error", () => peer.terminate());
        peer.on("close", () => {
          clearInterval(heartbeat);
          rooms.connections.delete(peer);
          rooms.live.delete(peer);
          rooms.schedulePresence(room.workspaceId);
          const ids = room.peers.get(peer);
          for (const id of ids ?? []) room.awarenessOwners.delete(id);
          room.peers.delete(peer);
          awareness.removeAwarenessStates(
            room.awareness,
            [...(ids ?? [])],
            null,
          );
          room.touched = Date.now();
          if (!room.peers.size && room.dirty) rooms.save(room);
        });
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        sync.writeSyncStep1(enc, room.doc);
        // A viewer only pulls server state; do not request its potentially modified local document.
        if (canEdit()) send(peer, encoding.toUint8Array(enc));
        const states = [...room.awareness.getStates().keys()];
        if (states.length) sendAwareness(rooms, room, peer, states);
      });
    } catch {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
    }
  });
  return wss;
}
