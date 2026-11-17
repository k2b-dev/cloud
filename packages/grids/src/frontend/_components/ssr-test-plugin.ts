import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "grids-ssr-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
