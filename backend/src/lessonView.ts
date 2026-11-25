import * as Y from "yjs";
import { randomBytes } from "node:crypto";
import { Awareness } from "y-protocols/awareness";
import type { WebSocket } from "ws";

// A filtered live copy of one lesson for the people locks restrict there.
//
// Everyone connected to a lesson receives its whole live document, so a locked file can't be
// "hidden" from someone connected to the lesson itself: its text would still arrive. People who
// may not open locked content in a lesson (and only while it has locked files, or is locked
// itself) are connected to this copy instead. It holds only the files they may open (none when
// the whole lesson is locked: `blank`), plus the lesson's code blocks.
//
// Both documents live on the server and every change to one is applied to the other at once,
// in the same tick, as the exact text change (Yjs delta) that happened: the texts are identical
// before each change, so replaying the change keeps them identical. Clients of either document
// keep editing their own copy with normal Yjs merging. Structure (files added, renamed, removed)
// changes only through the REST API on the lesson itself and flows into the copy; a lock change
// adds or removes files of the copy live (setAccess).
//
// The copy is never saved: it is rebuilt from the lesson when needed, under a new `lineage`, and
// clients that still hold an older copy are told to start over (see websocket.ts), so two
// unrelated copies are never merged.
export const MIRROR = Symbol("lesson-view-mirror");
const VALUE_MAPS = ["codeBlocks", "migrations"] as const;

// The live channel a socket is connected to: the lesson itself, or its filtered copy.
export type Channel = {
  lineage: string;
  doc: Y.Doc;
  awareness: Awareness;
  peers: Map<WebSocket, Set<number>>;
  awarenessOwners: Map<number, WebSocket>;
  viewerIds: Set<number>;
  dispose?: () => void;
};

type Delta = Array<{ insert?: unknown; retain?: number; delete?: number }>;
export function applyDelta(text: Y.Text, delta: Delta) {
  let index = 0;
  for (const op of delta) {
    if (op.retain !== undefined) index += op.retain;
    else if (op.insert !== undefined) {
      const value = typeof op.insert === "string" ? op.insert : "";
      if (value) text.insert(index, value);
      index += value.length;
    } else if (op.delete !== undefined) text.delete(index, op.delete);
  }
}

export class LessonView implements Channel {
  lineage = "v" + randomBytes(12).toString("base64url");
  doc = new Y.Doc();
  awareness = new Awareness(this.doc);
  peers = new Map<WebSocket, Set<number>>();
  awarenessOwners = new Map<number, WebSocket>();
  viewerIds = new Set<number>();
  dispose?: () => void;
  // No longer needed (nobody connected to the lesson is restricted any more): dropped once its
  // last socket leaves.
  stale = false;
  private blank: boolean;
  private hidden: Set<string>;
  private detach: () => void;
  constructor(
    private main: Y.Doc,
    blank: boolean,
    hidden: Set<string>,
  ) {
    this.awareness.setLocalState(null);
    this.blank = blank;
    this.hidden = new Set(hidden);
    const mainDocs = main.getMap<Y.Map<unknown>>("documents"),
      viewDocs = this.doc.getMap<Y.Map<unknown>>("documents");
    this.doc.transact(() => {
      for (const [id, item] of mainDocs) if (this.visible(id)) this.copyFile(id, item);
      this.syncValues();
    }, MIRROR);
    const fromMain = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, transaction: Y.Transaction) => {
      if (transaction.origin === MIRROR) return;
      this.doc.transact(() => {
        const added = new Set<string>();
        for (const event of events) {
          if (event.target !== mainDocs) continue;
          for (const id of (event as Y.YMapEvent<unknown>).keysChanged) {
            const item = mainDocs.get(id);
            if (item && this.visible(id)) {
              if (!viewDocs.has(id)) {
                this.copyFile(id, item);
                added.add(id);
              }
            } else if (!item && viewDocs.has(id)) viewDocs.delete(id);
          }
        }
        for (const event of events) {
          if (event.target === mainDocs) continue;
          const id = event.path[0];
          if (typeof id !== "string" || added.has(id) || !this.visible(id)) continue;
          const copy = viewDocs.get(id);
          const item = mainDocs.get(id);
          if (!copy || !item) continue;
          if (event.target instanceof Y.Text) applyDelta(copy.get("content") as Y.Text, event.delta as Delta);
          else if (event.target instanceof Y.Map)
            for (const name of (event as Y.YMapEvent<unknown>).keysChanged) {
              if (name === "content") continue;
              if (item.has(name)) copy.set(name, item.get(name));
              else copy.delete(name);
            }
        }
      }, MIRROR);
    };
    const fromView = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, transaction: Y.Transaction) => {
      if (transaction.origin === MIRROR) return;
      main.transact(() => {
        for (const event of events) {
          // Clients change only file text (the WebSocket validator refuses anything else).
          if (!(event.target instanceof Y.Text)) continue;
          const id = event.path[0];
          const item = typeof id === "string" && this.visible(id) ? mainDocs.get(id) : undefined;
          if (item) applyDelta(item.get("content") as Y.Text, event.delta as Delta);
        }
      }, MIRROR);
    };
    const values = (_event: unknown, transaction: Y.Transaction) => {
      if (transaction.origin !== MIRROR) this.doc.transact(() => this.syncValues(), MIRROR);
    };
    mainDocs.observeDeep(fromMain);
    viewDocs.observeDeep(fromView);
    for (const name of VALUE_MAPS) main.getMap(name).observe(values);
    this.detach = () => {
      mainDocs.unobserveDeep(fromMain);
      viewDocs.unobserveDeep(fromView);
      for (const name of VALUE_MAPS) main.getMap(name).unobserve(values);
    };
  }
  visible(id: string) {
    return !this.blank && !this.hidden.has(id);
  }
  get isBlank() {
    return this.blank;
  }
  hiddenFiles() {
    return new Set(this.hidden);
  }
  // Bytes of the lesson's files that this copy leaves out (lesson size limits count them).
  hiddenBytes() {
    let bytes = 0;
    for (const [id, item] of this.main.getMap<Y.Map<unknown>>("documents"))
      if (!this.visible(id)) bytes += Buffer.byteLength((item.get("content") as Y.Text).toString());
    return bytes;
  }
  private copyFile(id: string, item: Y.Map<unknown>) {
    const copy = new Y.Map<unknown>();
    for (const [name, value] of item)
      copy.set(name, name === "content" ? new Y.Text((value as Y.Text).toString()) : value);
    this.doc.getMap<Y.Map<unknown>>("documents").set(id, copy);
  }
  private syncValues() {
    for (const name of VALUE_MAPS) {
      const source = this.main.getMap<unknown>(name),
        target = this.doc.getMap<unknown>(name);
      for (const id of [...target.keys()]) if (this.blank || !source.has(id)) target.delete(id);
      if (this.blank) continue;
      for (const [id, value] of source)
        if (JSON.stringify(target.get(id)) !== JSON.stringify(value)) target.set(id, value);
    }
  }
  // Locks changed: files newly locked leave the copy, files released join it, live.
  setAccess(blank: boolean, hidden: Set<string>) {
    this.blank = blank;
    this.hidden = new Set(hidden);
    const mainDocs = this.main.getMap<Y.Map<unknown>>("documents"),
      viewDocs = this.doc.getMap<Y.Map<unknown>>("documents");
    this.doc.transact(() => {
      for (const id of [...viewDocs.keys()]) if (!this.visible(id) || !mainDocs.has(id)) viewDocs.delete(id);
      for (const [id, item] of mainDocs) if (this.visible(id) && !viewDocs.has(id)) this.copyFile(id, item);
      this.syncValues();
    }, MIRROR);
  }
  destroy() {
    this.detach();
    this.dispose?.();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
