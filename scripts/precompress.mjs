// Compresses the built frontend once at build time (zstd, Brotli, gzip next to each file)
// so Caddy serves ready-made files instead of compressing the multi-megabyte editor bundle
// again for every visitor. Usage: node scripts/precompress.mjs frontend/dist
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync, zstdCompressSync } from "node:zlib";

const root = process.argv[2] ?? "frontend/dist";
const compressible = /\.(js|mjs|css|html|svg|json|webmanifest|txt|map)$/i;
let files = 0,
  before = 0,
  after = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (compressible.test(entry.name) && (await stat(path)).size >= 1024) {
      const data = await readFile(path);
      const br = brotliCompressSync(data, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
      });
      await writeFile(path + ".br", br);
      await writeFile(path + ".gz", gzipSync(data, { level: 9 }));
      if (typeof zstdCompressSync === "function")
        await writeFile(path + ".zst", zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }));
      files++;
      before += data.length;
      after += br.length;
    }
  }
}
await walk(root);
console.log(
  `Precompressed ${files} files: ${(before / 1048576).toFixed(1)} MiB -> ${(after / 1048576).toFixed(1)} MiB (Brotli)`,
);
