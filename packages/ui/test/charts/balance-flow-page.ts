import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { balanceFixture } from "./balance-flow-fixture";

const root = resolve(import.meta.dir, "../..");
export const balanceFlowSpec = {
  kind: "balanceFlow" as const,
  ...balanceFixture,
  title: "Marketplace settlements",
  subtitle: "Fictional data · EUR",
};
/** The browser guard and published screenshots use the same real Chart component. */
export async function balanceFlowPage() {
  const ServerChart = (await import(resolve(root, "dist/ssr/content/Chart.js"))).default;
  const server = renderToString(() => createComponent(ServerChart, balanceFlowSpec));
  const build = await Bun.build({
    entrypoints: ["balance-flow-fixture"],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "fixture",
        setup(b) {
          b.onResolve({ filter: /^balance-flow-fixture$/ }, () => ({ path: "fixture", namespace: "fixture" }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "ts",
            resolveDir: import.meta.dir,
            contents: `
        import {createComponent,createSignal} from 'solid-js';import {render} from 'solid-js/web';
        import Chart from ${JSON.stringify(resolve(root, "dist/browser/content/Chart.js"))};
        const [state,setState]=createSignal('data'),[selected,setSelected]=createSignal(null);
        document.querySelector('#mount').replaceChildren();
        render(()=>createComponent(Chart,{...${JSON.stringify(balanceFlowSpec)},get state(){return state()},get selected(){return selected()},onSelect:s=>setSelected(s.datum),onRetry:()=>setState('data')}),document.querySelector('#mount'));
        document.querySelectorAll('[data-state-button]').forEach(b=>b.onclick=()=>setState(b.dataset.stateButton));
      `,
          }));
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Balance flow fixture did not bundle");
  const bundle = await build.outputs[0]!.text(),
    css = await Bun.file(resolve(root, "dist/styles.css")).text();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
    body{margin:0;padding:20px;background:var(--k2b-surface-canvas,#fafafa);color:var(--k2b-text,#27272a);font-family:system-ui}main{max-width:1240px;margin:auto}article{padding:20px;border:1px solid var(--k2b-border,#e4e4e7);border-radius:14px;background:var(--k2b-surface,#fff)}h1{font-size:22px;margin:0 0 8px}.intro{margin:0 0 24px;color:var(--k2b-text-muted,#71717a)}.states{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}.states button{padding:8px}#standalone{margin-top:30px}
    </style></head><body class="k2b-ui"><main><h1>Liquidity · Marketplace</h1><p class="intro">Invented marketplace data. Each closing balance continues into the next month. Scroll horizontally for earlier months.</p><article><div id="mount">${server}</div></article><div class="states">${["data", "loading", "empty", "error", "stale"].map((s) => `<button data-state-button="${s}">${s}</button>`).join("")}</div></main></body></html>`;

  return { html, bundle };
}
