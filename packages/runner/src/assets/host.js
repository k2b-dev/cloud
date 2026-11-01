// Trusted loader host. Never include this module in the dynamic worker's module map.
import { WorkerEntrypoint } from "cloudflare:workers";

export class Cloud extends WorkerEntrypoint {
  async call(operation, input) {
    let result;
    try {
      const response = await this.env.BRIDGE.fetch("http://bridge/call", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: this.env.CAPABILITY },
        body: JSON.stringify({ runId: this.ctx.props.runId, operation, input }),
      });
      if (!response.ok) throw new Error("runner_bridge_unavailable");
      result = await response.json();
    } catch {
      // The supervisor may close an oversized upload before workerd reads its 413.
      // Code sees one stable code, never transport details.
      throw new Error("runner_bridge_unavailable");
    }
    if (!result.ok) throw new Error(result.error.code);
    return result.data;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/ping") return new Response("pong");
    const { runId, source, entrypoint, input } = await request.json();
    // load() is unnamed: every attempt gets a fresh isolate, even for an identical bundle.
    const worker = env.LOADER.load({
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["disallow_importable_env", "nodejs_compat_do_not_populate_process_env", "disable_nodejs_fs_module"],
      mainModule: "entry.js",
      modules: {
        "bundle.js": source,
        "entry.js": `import {WorkerEntrypoint} from 'cloudflare:workers';
          import * as bundle from './bundle.js';
          export default class extends WorkerEntrypoint {
            async run(name, input) {
              if (typeof bundle[name] !== 'function') throw new Error('missing_entrypoint');
              await bundle[name](input, this.env.cloud);
            }
          }`,
      },
      env: { cloud: ctx.exports.Cloud({ props: { runId } }) },
      globalOutbound: null,
    });
    try {
      await worker.getEntrypoint().run(entrypoint, input);
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    } catch {
      return new Response("{}", { status: 500 });
    }
  },
};
