import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as sync from "y-protocols/sync";
import * as awareness from "y-protocols/awareness";
import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import { Rooms, validateDocument, type Room } from "./rooms.js";
import { hashEditorToken, TOKEN_PATTERN } from "./access.js";

function send(peer: WebSocket, data: Uint8Array) {
  if (peer.readyState === WebSocket.OPEN) {
    if (peer.bufferedAmount > 4 * 1024 * 1024)
      peer.close(1013, "Slow connection");
    else peer.send(data);
  }
}
function wire(room: Room) {
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
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(
      enc,
      awareness.encodeAwarenessUpdate(room.awareness, [
        ...added,
        ...updated,
        ...removed,
      ]),
    );
    for (const peer of room.peers.keys())
      send(peer, encoding.toUint8Array(enc));
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
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024 + 256 * 1024,
    perMessageDeflate: false,
    // Never echo the credential subprotocol in the handshake response.
    handleProtocols: (protocols) =>
      protocols.has("devshare") ? "devshare" : false,
  });
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
        wire(room);
        room.peers.set(peer, new Set());
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
                if (!rooms.canEditHash(room.workspaceId, credentialHash))
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
                  rooms.canEditHash(room.workspaceId, credentialHash) &&
                  (!state.user ||
                    typeof state.user.name !== "string" ||
                    state.user.name.length > 40 ||
                    !/^#[0-9a-f]{6}$/i.test(state.user.color))
                )
                  throw new Error("Invalid presence");
                if (state !== null) {
                  ids.add(id);
                  room.awarenessOwners.set(id, peer);
                }
                // Roles are generated from the verified socket credential, never browser state.
                const safeState =
                  state === null
                    ? null
                    : rooms.canEditHash(room.workspaceId, credentialHash)
                      ? {
                          user: {
                            name: state.user.name,
                            color: state.user.color,
                          },
                          fileId:
                            typeof state.fileId === "string"
                              ? state.fileId.slice(0, 80)
                              : undefined,
                          selection: state.selection,
                          role: rooms.canEditHash(
                            room.workspaceId,
                            credentialHash,
                          )
                            ? "editor"
                            : "viewer",
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
              const enc = encoding.createEncoder();
              encoding.writeVarUint(enc, 1);
              encoding.writeVarUint8Array(
                enc,
                awareness.encodeAwarenessUpdate(room.awareness, [
                  ...room.awareness.getStates().keys(),
                ]),
              );
              send(peer, encoding.toUint8Array(enc));
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
        if (rooms.canEditHash(room.workspaceId, credentialHash))
          send(peer, encoding.toUint8Array(enc));
        const states = [...room.awareness.getStates().keys()];
        if (states.length) {
          const e = encoding.createEncoder();
          encoding.writeVarUint(e, 1);
          encoding.writeVarUint8Array(
            e,
            awareness.encodeAwarenessUpdate(room.awareness, states),
          );
          send(peer, encoding.toUint8Array(e));
        }
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
