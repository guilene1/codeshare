import { useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import Modal from "./Modal";
import { api } from "../lib";
export default function CreateWorkspace({
  onClose,
  navigate,
}: {
  onClose: () => void;
  navigate: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState("terraform");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      // The workspace belongs to the signed-in account; no credential goes in the URL.
      const item = await api<{ id: string; name: string }>("/rooms", "POST", {
        name: name.trim(),
        description,
        template,
      });
      navigate(`/w/${item.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Create Workspace"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="modal-description">
        A lasting home for your lessons, labs and code.
      </p>
      <form onSubmit={submit}>
        <label className="field">
          Workspace name
          <input
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Terraform Class"
          />
        </label>
        <label className="field">
          Description <span className="optional">optional</span>
          <textarea
            maxLength={400}
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="AWS infrastructure with Terraform"
          />
        </label>
        <fieldset className="template-options">
          <legend>Start with</legend>
          {[
            ["empty", "Empty Workspace", "Start with a clean slate"],
            ["terraform", "Terraform", "main.tf, variables.tf, outputs.tf"],
            [
              "kubernetes",
              "Kubernetes",
              "deployment.yaml, service.yaml, gateway.yaml",
            ],
            ["python", "Python", "A simple main.py"],
            ["devops", "General DevOps", "Notes, commands and a Dockerfile"],
          ].map(([id, label, detail]) => (
            <label key={id} className={template === id ? "selected" : ""}>
              <input
                type="radio"
                name="template"
                value={id}
                checked={template === id}
                onChange={() => setTemplate(id)}
              />
              <span>
                <strong>{label}</strong>
                <small>{detail}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !name.trim()}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}{" "}
            Create Workspace
          </button>
        </div>
        <p className="fine-print">
          The workspace is saved to your account. Share the student link with
          your class; students never need to sign in.
        </p>
      </form>
    </Modal>
  );
}
