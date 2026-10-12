// What a paste or drop offers as images: image files (screenshots, "Copy image" from a
// website, a PDF or Word picture, several files from the file manager) or, failing that,
// pasted direct links to images.
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export type FoundImages = { files: File[]; urls: string[]; unsupported: number };

export function imagesIn(data: DataTransfer | null, allowUrls = true): FoundImages {
  const found: FoundImages = { files: [], urls: [], unsupported: 0 };
  if (!data) return found;
  for (const file of Array.from(data.files))
    if (IMAGE_TYPES.includes(file.type)) found.files.push(file);
    else if (file.type.startsWith("image/")) found.unsupported++;
  if (found.files.length || found.unsupported || !allowUrls) return found;
  const lines = data
    .getData("text/plain")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length && lines.every(isImageUrl)) found.urls = lines;
  return found;
}

// Only https links whose path ends in an image extension are treated as images, so
// pasting an ordinary link still pastes the text.
export function isImageUrl(text: string) {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && /\.(png|jpe?g|gif|webp)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

// Alt text from a file name ("k8s-architecture.png" -> "k8s architecture"); generic
// clipboard names ("image.png") give a neutral description.
export function altFor(source: File | string) {
  const name =
    typeof source === "string"
      ? decodeURIComponent(new URL(source).pathname.split("/").pop() ?? "")
      : source.name;
  const base = name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  return !base || (/^(image|clipboard|screenshot|untitled|blob)\b/i.test(base) && base.length < 12)
    ? "Pasted image"
    : base;
}
