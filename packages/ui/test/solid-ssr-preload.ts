import { registerSsrTestPlugin } from "./ssr-test-plugin";

registerSsrTestPlugin({ dev: true, rootDir: import.meta.dir, componentRoots: [] });
