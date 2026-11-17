import { createConfig, type SsrOptions, type SsrResult } from "@k2b/ssr";

/** Register the same island-aware compiler in every server-rendering test. Local Bun.build plugins stay local. */
export function registerSsrTestPlugin<T extends object = object>(options: SsrOptions<T>): SsrResult<T>;
export function registerSsrTestPlugin<T extends Pick<SsrResult<object>, "plugin">>(config: T): T;
export function registerSsrTestPlugin(options: SsrOptions | Pick<SsrResult<object>, "plugin">) {
  const config = "plugin" in options ? options : createConfig(options);
  Bun.plugin(config.plugin());
  return config;
}
