import type { BunPlugin } from "bun";

/** PDF.js runs in Kit's existing worker using its in-process message port.
 * Its standalone worker auto-bootstrap would otherwise post non-Kit messages
 * onto the host channel. Scope the sentinel to this module, never the sandbox.
 */
const pdfBackend: BunPlugin = {
  name: "kit-pdf-backend",
  setup(build) {
    build.onLoad({ filter: /pdfjs-dist\/build\/pdf\.worker\.mjs$/ }, async ({ path }) => ({
      contents: "const window = {};\n" + (await Bun.file(path).text()),
      loader: "js",
    }));
  },
};
export const workerBuildOptions = {
  target: "browser" as const,
  format: "iife" as const,
  // Only the unused Node canvas factory needs import.meta.url. Classic opaque
  // blob workers cannot parse import.meta; no runtime asset URLs are fetched.
  define: { "import.meta.url": JSON.stringify("about:blank") },
  plugins: [pdfBackend],
  minify: true,
};
