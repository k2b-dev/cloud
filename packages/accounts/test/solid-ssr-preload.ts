import { registerSsrTestPlugin } from "../../ui/test/ssr-test-plugin";

registerSsrTestPlugin({ dev: true, rootDir: `${import.meta.dir}/..` });
