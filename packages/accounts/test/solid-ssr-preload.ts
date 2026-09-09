import { createConfig } from "@k2b/ssr";

const { plugin } = createConfig({ dev: true, rootDir: `${import.meta.dir}/..` });
Bun.plugin(plugin());
