import { useState, type FormEvent } from "react";
import Modal from "./Modal";
import { IMAGE_TYPES, isImageUrl, type FoundImages } from "../documentImages";

// "Insert Image": choose image files (several at once) or enter a direct https image link.
export default function ImageDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (found: FoundImages) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    const link = url.trim();
    if (link && !/^https:\/\//i.test(link)) {
      setError("Image links must start with https://.");
      return;
    }
    if (!files.length && !link) {
      setError("Choose an image file or enter an image link.");
      return;
    }
    onInsert({ files, urls: link ? [link] : [], unsupported: 0 });
    onClose();
  }
  return (
    <Modal title="Insert Image" onClose={onClose}>
      <form onSubmit={submit} className="image-dialog">
        <p className="modal-description">
          Tip: you can also paste a copied image or screenshot straight into the document
          with Ctrl / ⌘ V. Images keep their original resolution.
        </p>
        <label className="field">
          Image files <span className="optional">PNG, JPG, WebP or GIF · up to 15 MB each</span>
          <input
            type="file"
            multiple
            accept={IMAGE_TYPES.join(",")}
            onChange={(event) => {
              setFiles(Array.from(event.target.files ?? []));
              setError("");
            }}
          />
        </label>
        <label className="field">
          Or an image link <span className="optional">optional</span>
          <input
            type="url"
            inputMode="url"
            value={url}
            placeholder="https://example.com/architecture.png"
            onChange={(event) => {
              setUrl(event.target.value);
              setError("");
            }}
          />
        </label>
        {url.trim() && /^https:\/\//i.test(url.trim()) && !isImageUrl(url.trim()) && (
          <p className="muted">Kodelumi will download this link and check that it is an image.</p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Insert {files.length > 1 ? `${files.length} images` : "image"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
