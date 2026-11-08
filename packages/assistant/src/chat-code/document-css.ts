import { env } from "@k2b/cloud/config";

let css: Promise<string> | undefined;
export function documentCss() {
  css ??= (
    env.NODE_ENV === "production"
      ? Bun.file(new URL("./assistant-app-base.css", import.meta.url)).text()
      : import("./build-document-css").then((m) => m.buildBaseCss())
  ).catch((error) => {
    css = undefined;
    throw error;
  });
  return css;
}
