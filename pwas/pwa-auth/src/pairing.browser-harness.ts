import { resolve } from "node:path";
import { solid } from "../scripts/build";
import { iconStyles } from "../scripts/icons";

export async function pairingPage() {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "pairing-fixture.browser-harness.tsx"), resolve(import.meta.dir, "styles.css")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [solid],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new AggregateError(built.logs, "Could not bundle pairing fixture");
  const script = await built.outputs.find((o) => o.path.endsWith(".js"))!.text();
  const css = (await built.outputs.find((o) => o.path.endsWith(".css"))!.text()) + (await iconStyles(script));
  return {
    script,
    html: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  };
}
