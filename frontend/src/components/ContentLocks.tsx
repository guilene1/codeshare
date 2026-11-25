import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  CalendarClock,
  CalendarX2,
  Eye,
  EyeOff,
  History,
  Loader2,
  Lock,
  LockOpen,
  ShieldCheck,
  Trash2,
  Unlock,
} from "lucide-react";
import Modal from "./Modal";
import {
  browserTimeZone,
  releaseLong,
  releaseShort,
  timeZones,
  wallClock,
  type LockTarget,
  type TreeLock,
} from "../lib";

// Content locks in the Explorer: a padlock before each item's own icon and its availability on
// the right ("Available", "Locked" with any release date, "Locked by parent"). People who manage
// locks click the padlock for a menu; everyone else sees the status only. Nothing is shown as
// done before the server confirms it.

export type LockItem = LockTarget & { name: string; lock?: TreeLock };
export type LockScope = { folderId: string | null; manage: boolean; schedule: boolean; access: boolean };

export function lockLabel(lock: TreeLock | undefined) {
  if (!lock) return "Available";
  return lock.state === "inherited" ? "Locked by parent" : "Locked";
}
const lockState = (lock: TreeLock | undefined) => (!lock ? "available" : lock.state === "inherited" ? "inherited" : "locked");
// The status on the right of a row: "Available", "Locked" (with "Available from …" underneath
// when scheduled) or "Locked by parent".
export function LockLabel({ item }: { item: LockItem }) {
  const { lock } = item;
  const when = lock?.state === "locked" && lock.releaseAt ? lock.releaseAt : null;
  return (
    <>
      <span className={"lock-status " + lockState(lock)} aria-hidden="true">
        {/* "Locked by parent" on two lines, so it fits narrow Explorers. */}
        {lock?.state === "inherited" ? (
          <>
            <span>Locked</span>
            <small>by parent</small>
          </>
        ) : (
          <span>{lockLabel(lock)}</span>
        )}
        {lock?.hidden && <small>Hidden</small>}
      </span>
      {/* The release date gets a line of its own under the row, so it always shows in full. */}
      {when && (
        <span className="lock-date" aria-hidden="true">
          Available from {releaseShort(when)}
        </span>
      )}
    </>
  );
}
// The padlock before a row's own icon. `manage`: clicking opens the lock menu.
export function LockToggle({
  item,
  manage,
  onMenu,
}: {
  item: LockItem;
  manage: boolean;
  onMenu?: (anchor: HTMLElement) => void;
}) {
  const { lock } = item;
  const state = lockState(lock);
  const label = lockLabel(lock);
  const when = lock?.state === "locked" && lock.releaseAt ? lock.releaseAt : null;
  const title =
    (state === "available" ? `${item.name}: available` : `${item.name}: ${label.toLowerCase()}`) +
    (when ? `. Available from ${releaseLong(when)}` : "") +
    (lock?.hidden ? ". Hidden from students" : "") +
    (manage ? ". Click to manage access" : "");
  const icon = state === "available" ? <LockOpen size={12} aria-hidden="true" /> : <Lock size={12} aria-hidden="true" />;
  return manage ? (
    <button
      type="button"
      className={"lock-toggle " + state}
      aria-label={`Manage access to ${item.name} (${label}${when ? ", available from " + releaseShort(when) : ""})`}
      aria-haspopup="menu"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onMenu?.(event.currentTarget);
      }}
    >
      {icon}
    </button>
  ) : (
    <span
      className={"lock-toggle static " + state}
      role="img"
      aria-label={label + (when ? ", available from " + releaseShort(when) : "")}
      title={title}
    >
      {icon}
    </span>
  );
}

type Request = (path: string, method: string, body?: unknown) => Promise<unknown>;
type Dialog =
  | { mode: "schedule"; items: LockItem[] }
  | { mode: "confirm"; items: LockItem[]; action: "lock" | "unlock" }
  | { mode: "history"; item: LockItem }
  | { mode: "permissions"; folderId: string | null };

// The lock menu for one item, placed at its padlock.
export function LockMenu({
  item,
  anchor,
  scopes,
  owner,
  onClose,
  onAction,
}: {
  item: LockItem;
  anchor: HTMLElement;
  scopes: { manage: boolean; schedule: boolean };
  owner: boolean;
  onClose: () => void;
  onAction: (action: "lock" | "unlock" | "schedule" | "cancel" | "show" | "hide" | "history" | "permissions" | "select") => void;
}) {
  const rect = anchor.getBoundingClientRect();
  const top = Math.min(rect.bottom + 4, window.innerHeight - 300);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - 228);
  const own = item.lock?.state === "locked";
  const scheduled = own && !!item.lock?.releaseAt;
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, []);
  const entry = (action: Parameters<typeof onAction>[0], icon: React.ReactNode, label: string) => (
    <button role="menuitem" onClick={() => onAction(action)}>
      {icon} {label}
    </button>
  );
  return (
    <>
      <div className="lock-menu-backdrop" onClick={onClose} />
      <div className="lock-menu" role="menu" aria-label={`Access to ${item.name}`} style={{ top, left }}>
        <p className="lock-menu-state">
          <strong title={item.name}>{item.name}</strong>
          <span>
            {lockLabel(item.lock)}
            {scheduled ? ` · from ${releaseShort(item.lock!.releaseAt!)}` : ""}
          </span>
        </p>
        {scopes.manage && !own && entry("lock", <Lock size={13} />, item.lock ? "Lock this item too" : "Lock now")}
        {scopes.manage && own && entry("unlock", <Unlock size={13} />, "Unlock now")}
        {scopes.manage && scopes.schedule && entry("schedule", <CalendarClock size={13} />, scheduled ? "Change scheduled release" : "Schedule unlock")}
        {scopes.manage && scopes.schedule && scheduled && entry("cancel", <CalendarX2 size={13} />, "Cancel scheduled release")}
        {scopes.manage && own && item.lock?.visibility !== "hidden" && entry("hide", <EyeOff size={13} />, "Hide from students until released")}
        {scopes.manage && own && item.lock?.visibility === "hidden" && entry("show", <Eye size={13} />, "Show name and status to students")}
        {item.kind !== "file" && owner && entry("permissions", <ShieldCheck size={13} />, "Manage lock permissions")}
        {entry("history", <History size={13} />, "View lock history")}
        {scopes.manage && item.kind !== "workspace" && entry("select", <Lock size={13} />, "Select several items…")}
      </div>
    </>
  );
}

// Every lock dialog: confirm (workspace and bulk), schedule, history and permissions.
export function LockDialogs({
  dialog,
  setDialog,
  request,
  notify,
  folders,
}: {
  dialog: Dialog | null;
  setDialog: (next: Dialog | null) => void;
  request: Request;
  notify: (message: string) => void;
  folders: Array<{ id: string; name: string }>;
}) {
  if (!dialog) return null;
  if (dialog.mode === "confirm")
    return <ConfirmLock items={dialog.items} action={dialog.action} request={request} notify={notify} onClose={() => setDialog(null)} />;
  if (dialog.mode === "schedule")
    return <ScheduleRelease items={dialog.items} request={request} notify={notify} onClose={() => setDialog(null)} />;
  if (dialog.mode === "history") return <LockHistory item={dialog.item} request={request} onClose={() => setDialog(null)} />;
  return <LockPermissions folderId={dialog.folderId} folders={folders} request={request} notify={notify} onClose={() => setDialog(null)} />;
}
export type { Dialog as LockDialog };

const describe = (items: LockItem[]) =>
  items.length === 1
    ? items[0].kind === "workspace"
      ? "the whole workspace"
      : `“${items[0].name}”`
    : `${items.length} items`;
// Runs one lock change and reports it only after the server confirms.
export async function applyLock(
  request: Request,
  items: LockTarget[],
  action: "lock" | "unlock" | "schedule" | "cancel" | "visibility",
  extra: Record<string, unknown> = {},
) {
  return request("/locks", "PUT", { targets: items.map(({ kind, id }) => ({ kind, id })), action, ...extra }) as Promise<{ changed: number }>;
}

function ConfirmLock({
  items,
  action,
  request,
  notify,
  onClose,
}: {
  items: LockItem[];
  action: "lock" | "unlock";
  request: Request;
  notify: (message: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [hidden, setHidden] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await applyLock(request, items, action, action === "lock" ? { visibility: hidden ? "hidden" : "visible" } : {});
      notify(
        action === "lock"
          ? `Locked ${result.changed === 1 ? describe(items) : result.changed + " items"}`
          : result.changed
            ? `Unlocked ${result.changed === 1 ? describe(items) : result.changed + " items"}`
            : "Nothing to unlock",
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={action === "lock" ? "Lock content" : "Unlock content"} onClose={() => !busy && onClose()}>
      <form onSubmit={submit} className="lock-dialog">
        <p className="modal-description">
          {action === "lock"
            ? `Lock ${describe(items)}? Students and other people without lock access can't open it until it's unlocked. You can still view and edit it.`
            : `Unlock ${describe(items)}? It opens at once for everyone its sharing already allows. Items locked on their own, and anything inside a locked parent, stay locked.`}
        </p>
        {action === "lock" && (
          <fieldset className="lock-visibility">
            <legend>Before release</legend>
            <label>
              <input type="radio" name="visibility" checked={!hidden} onChange={() => setHidden(false)} /> Show the name and a padlock
            </label>
            <label>
              <input type="radio" name="visibility" checked={hidden} onChange={() => setHidden(true)} /> Hide completely until released
            </label>
          </fieldset>
        )}
        {error && (
          <p className="error share-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy && <Loader2 size={15} className="spin" />}
            {action === "lock" ? (items.length > 1 ? `Lock ${items.length} Items` : "Lock") : items.length > 1 ? `Unlock ${items.length} Items` : "Unlock"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// "Manage Content Access": when locked content becomes available, in a chosen time zone.
function ScheduleRelease({
  items,
  request,
  notify,
  onClose,
}: {
  items: LockItem[];
  request: Request;
  notify: (message: string) => void;
  onClose: () => void;
}) {
  const first = items[0];
  const existing = items.length === 1 && first.lock?.state === "locked" ? first.lock : undefined;
  const zones = useMemo(timeZones, []);
  const [zone, setZone] = useState(existing?.zone ?? browserTimeZone());
  const start = existing?.releaseAt ? wallClock(existing.releaseAt, existing.zone ?? browserTimeZone()) : wallClock(Date.now() + 7 * 86_400_000, zone);
  const [date, setDate] = useState(start.date),
    [time, setTime] = useState(existing?.releaseAt ? start.time : "08:00"),
    [hidden, setHidden] = useState(existing?.visibility === "hidden"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await applyLock(request, items, "schedule", { release: { date, time, timeZone: zone }, visibility: hidden ? "hidden" : "visible" });
      notify(`Scheduled: ${describe(items)} unlocks ${date} at ${time} (${zone})`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Manage Content Access" onClose={() => !busy && onClose()}>
      <form onSubmit={submit} className="lock-dialog">
        <p className="lock-dialog-target">
          <strong>{items.length === 1 ? first.name : `${items.length} items`}</strong>
          <span>
            Current status: {items.length === 1 ? lockLabel(first.lock) : "Mixed"}
            {existing?.releaseAt ? ` · available from ${releaseLong(existing.releaseAt)}` : ""}
          </span>
        </p>
        <fieldset className="lock-when">
          <legend>Available from</legend>
          <label className="field">
            Date
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            Time
            <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label className="field lock-zone">
            Time zone
            <select value={zone} onChange={(e) => setZone(e.target.value)}>
              {(zones.includes(zone) ? zones : [zone, ...zones]).map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <fieldset className="lock-visibility">
          <legend>Visibility before release</legend>
          <label>
            <input type="radio" name="visibility" checked={!hidden} onChange={() => setHidden(false)} /> Show {first.kind === "file" ? "file" : "folder"} name and availability date
          </label>
          <label>
            <input type="radio" name="visibility" checked={hidden} onChange={() => setHidden(true)} /> Hide completely until release
          </label>
        </fieldset>
        <p className="lock-dialog-note">
          The content locks now (if it isn’t already) and unlocks automatically at that time. A locked parent folder still keeps it closed.
        </p>
        {error && (
          <p className="error share-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy || !date || !time}>
            {busy && <Loader2 size={15} className="spin" />}
            {existing?.releaseAt ? "Save Release Time" : "Schedule Unlock"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

type HistoryEvent = { id: string; action: string; detail: string; actor: string; createdAt: number; name: string };
const ACTIONS: Record<string, string> = {
  locked: "Locked",
  unlocked: "Unlocked",
  scheduled: "Release scheduled",
  rescheduled: "Release changed",
  "schedule.canceled": "Release canceled",
  released: "Released automatically",
  visibility: "Visibility changed",
  "permission.added": "Lock permission added",
  "permission.removed": "Lock permission removed",
};
function LockHistory({ item, request, onClose }: { item: LockItem; request: Request; onClose: () => void }) {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const query = item.kind === "workspace" ? "" : `?kind=${item.kind}&id=${encodeURIComponent(item.id)}`;
    (request("/locks/history" + query, "GET") as Promise<{ events: HistoryEvent[] }>)
      .then((r) => setEvents(r.events))
      .catch((e) => setError((e as Error).message));
  }, [item.id]);
  return (
    <Modal title="Lock history" onClose={onClose}>
      <p className="modal-description">{item.kind === "workspace" ? "Every lock change in this workspace." : `Lock changes for “${item.name}”.`}</p>
      {error && (
        <p className="error share-error" role="alert">
          {error}
        </p>
      )}
      {!events && !error && <Loader2 size={18} className="spin" />}
      {events && !events.length && <p className="muted">No lock changes yet.</p>}
      {events && !!events.length && (
        <ol className="lock-history">
          {events.map((event) => (
            <li key={event.id}>
              <strong>{ACTIONS[event.action] ?? event.action}</strong>
              {item.kind === "workspace" && <span className="lock-history-name">{event.name}</span>}
              <span>{event.detail}</span>
              <small>
                {event.actor} · {new Date(event.createdAt).toLocaleString()}
              </small>
            </li>
          ))}
        </ol>
      )}
      <div className="dialog-actions">
        <button className="button secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

type Permission = {
  id: string;
  displayName?: string | null;
  email?: string | null;
  teamName?: string | null;
  folderId: string | null;
  folderName?: string | null;
  manage: boolean;
  schedule: boolean;
  access: boolean;
};
// Who else manages locks (the owner only): accounts or teams, in the whole workspace or one
// folder. Permissions never grant access to content by themselves.
function LockPermissions({
  folderId,
  folders,
  request,
  notify,
  onClose,
}: {
  folderId: string | null;
  folders: Array<{ id: string; name: string }>;
  request: Request;
  notify: (message: string) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<Permission[] | null>(null),
    [email, setEmail] = useState(""),
    [scope, setScope] = useState<string>(folderId ?? ""),
    [manage, setManage] = useState(true),
    [schedule, setSchedule] = useState(true),
    [access, setAccess] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = () =>
    (request("/lock-permissions", "GET") as Promise<{ permissions: Permission[] }>)
      .then((r) => setList(r.permissions))
      .catch((e) => setError((e as Error).message));
  useEffect(() => void load(), []);
  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = (await request("/lock-permissions", "POST", {
        email,
        folderId: scope || null,
        manage,
        schedule: manage && schedule,
        access,
      })) as { permissions: Permission[] };
      setList(r.permissions);
      setEmail("");
      notify("Lock permission added");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      const r = (await request("/lock-permissions/" + id, "DELETE")) as { permissions: Permission[] };
      setList(r.permissions);
      notify("Lock permission removed");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Lock permissions" onClose={() => !busy && onClose()}>
      <p className="modal-description">
        Let co-instructors manage locks and open locked content. They still need access through sharing: lock permissions never share
        anything by themselves.
      </p>
      <form onSubmit={add} className="lock-dialog lock-permission-form">
        <label className="field">
          Kodelumi account email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="co-instructor@example.com" />
        </label>
        <label className="field">
          Where
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">The whole workspace</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <div className="lock-permission-options">
          <label>
            <input type="checkbox" checked={manage} onChange={(e) => setManage(e.target.checked)} /> Lock and unlock
          </label>
          <label>
            <input type="checkbox" checked={manage && schedule} disabled={!manage} onChange={(e) => setSchedule(e.target.checked)} /> Schedule releases
          </label>
          <label>
            <input type="checkbox" checked={access} onChange={(e) => setAccess(e.target.checked)} /> Open locked content
          </label>
        </div>
        {error && (
          <p className="error share-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="submit" className="button primary" disabled={busy || !email || (!manage && !access)}>
            {busy && <Loader2 size={15} className="spin" />} Add Permission
          </button>
        </div>
      </form>
      <div className="lock-permission-list" aria-label="Current lock permissions">
        {list === null && !error && <Loader2 size={16} className="spin" />}
        {list && !list.length && <p className="muted">Only you manage locks in this workspace.</p>}
        {list?.map((p) => (
          <div key={p.id} className="lock-permission">
            <span>
              <strong>{p.teamName ? `Team ${p.teamName}` : p.displayName}</strong>
              <small>
                {p.folderId ? p.folderName : "Whole workspace"} ·{" "}
                {[p.manage && "lock", p.schedule && "schedule", p.access && "open locked content"].filter(Boolean).join(", ")}
              </small>
            </span>
            <button className="icon-button" aria-label={`Remove lock permission of ${p.teamName ?? p.displayName}`} disabled={busy} onClick={() => void remove(p.id)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
