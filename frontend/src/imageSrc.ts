import { useEffect, useState } from "react";

// Edit Link guests have no session cookie, and an <img> request can't carry their link, so
// in a Restricted workspace the server refuses it. While such a guest has the workspace
// open, its own images are fetched with the link instead and shown as data: URLs (which
// the Content-Security-Policy already allows for images; blob: is not allowed).
// Signed-in users and "Anyone with the link" workspaces keep plain, lazily loaded <img>.
let credential: string | undefined;
export function setImageCredential(token: string | undefined) {
  credential = token;
}
const workspaceImage = /^\/api\/rooms\/[\w-]{16}\/images\/[\w-]+$/;

export function useImageSrc(src: string): string | undefined {
  const token = workspaceImage.test(src) ? credential : undefined;
  const [shown, setShown] = useState<string | undefined>(token ? undefined : src);
  useEffect(() => {
    if (!token) {
      setShown(src);
      return;
    }
    let canceled = false;
    setShown(undefined);
    fetch(src, { credentials: "same-origin", headers: { Authorization: `Bearer ${token}` } })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          }),
      )
      .then((url) => !canceled && setShown(url))
      // Fall back to the plain URL, so the image's own error and retry handling applies.
      .catch(() => !canceled && setShown(src));
    return () => {
      canceled = true;
    };
  }, [src, token]);
  return shown;
}
