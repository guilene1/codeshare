import { useEffect, useRef, useState } from "react";
import { History, Loader2, X } from "lucide-react";
import {
  actorName,
  changeLabel,
  changeTarget,
  plural,
  targetKind,
  whenLabel,
  type Activity,
  type PresenceSummary,
} from "../workspaces";

const roles = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

// Owner/Editor-only summary in the workspace views bar: who is online, the last persisted
// change, and recent activity. Viewers never render it (and the server never sends it).
export default function WorkspaceActivity({
  presence,
  entries,
  hasMore,
  loading,
  onLoadMore,
}: {
  presence: PresenceSummary | null;
  entries: Activity[];
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const last = entries[0];
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const online = presence ? `${presence.total} online` : "Connecting…";

  return (
    <div className="workspace-activity" ref={root}>
      <button
        className={"activity-summary" + (open ? " active" : "")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="activity-online">
          <span className="live-dot" />
          {online}
        </span>
        {last && (
          <span className="activity-last" title={whenLabel(last.created_at)}>
            Updated {whenLabel(last.created_at)} · {actorName(last.actor)}
          </span>
        )}
        <History size={14} />
      </button>
      {open && (
        <div className="activity-panel" role="dialog" aria-label="Workspace activity">
          <div className="activity-panel-head">
            <strong>Workspace activity</strong>
            <button
              className="icon-button"
              aria-label="Close activity"
              onClick={() => setOpen(false)}
            >
              <X size={15} />
            </button>
          </div>
          <section aria-label="Online now">
            <h3>
              Online now<span>{presence?.total ?? 0}</span>
            </h3>
            {presence ? (
              <ul className="activity-people">
                {presence.users.map((person, index) => (
                  <li key={"u" + index}>
                    <span className="activity-name">
                      {person.name}
                      {person.you && <small> (you)</small>}
                    </span>
                    <span className={"activity-role " + person.role}>{roles[person.role]}</span>
                  </li>
                ))}
                {presence.guests.map((guest, index) => (
                  <li key={"g" + index}>
                    <span className="activity-name">
                      {guest.name}
                      {guest.you && <small> (you)</small>}
                    </span>
                    <span className="activity-role editor">Guest editor</span>
                  </li>
                ))}
                <li className="activity-anonymous">
                  {plural(presence.anonymous, "anonymous viewer")}
                </li>
              </ul>
            ) : (
              <p className="activity-empty">Connecting…</p>
            )}
          </section>
          <section aria-label="Last updated">
            <h3>Last updated</h3>
            {last ? (
              <dl className="activity-last-details">
                <dt>Last updated</dt>
                <dd>{whenLabel(last.created_at)}</dd>
                <dt>Updated by</dt>
                <dd>{actorName(last.actor)}</dd>
                {changeTarget(last) && (
                  <>
                    <dt>{targetKind(last.action)}</dt>
                    <dd className="activity-target">{changeTarget(last)}</dd>
                  </>
                )}
                <dt>Change</dt>
                <dd>{changeLabel(last.action)}</dd>
              </dl>
            ) : (
              <p className="activity-empty">No changes recorded yet.</p>
            )}
          </section>
          <section aria-label="Recent activity">
            <h3>Recent activity</h3>
            {entries.length ? (
              <ol className="activity-list">
                {entries.map((item) => (
                  <li key={item.id}>
                    <div>
                      <strong>{changeLabel(item.action)}</strong>
                      {changeTarget(item) && (
                        <span className="activity-target" title={changeTarget(item)}>
                          {changeTarget(item)}
                        </span>
                      )}
                    </div>
                    <small>
                      {actorName(item.actor)} · {whenLabel(item.created_at)}
                    </small>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="activity-empty">No activity yet.</p>
            )}
            {hasMore && (
              <button className="text-button activity-more" disabled={loading} onClick={onLoadMore}>
                {loading && <Loader2 size={13} className="spin" />} Show more activity
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
