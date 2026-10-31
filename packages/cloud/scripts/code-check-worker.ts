/** Trusted child role. Source is parsed/bundled, never imported into this Bun process. */

import { readFile } from "node:fs/promises";
import ts from "@typescript/typescript6";
import { analyzeCode, resolveLocal, runtimeModuleSpecifiers } from "../src/code/checker-analysis";
import type { CodeCheckRequest, CodeVersionManifest } from "../src/code/checker-contract";

if (Bun.argv.includes("--help")) {
  console.log("Usage: bun --no-env-file code-check-worker.ts analyze|bundle REQUEST_JSON");
} else {
  const request: CodeCheckRequest & { entrypoints: CodeVersionManifest["entrypoints"] } = JSON.parse(await readFile(Bun.argv[3]!, "utf8"));
  if (Bun.argv[2] === "analyze") {
    console.log(JSON.stringify(analyzeCode(request)));
  } else if (Bun.argv[2] === "bundle") {
    const expected = JSON.stringify(
      request.entrypoints.filter((e) => e.kind === "schedule").map(({ entrypoint, cron }) => ({ kind: "schedule", entrypoint, cron })),
    );
    const exports = request.entrypoints
      .map((entry, i) => {
        const body =
          request.sdk.manifest.mode === "code_run"
            ? `return user.default(input);`
            : `return __codeSdk.run(${JSON.stringify(entry.entrypoint)});`;
        return `async function run${i}(input, cloud) { __codeSdk.bind(cloud); const user = await import("code:entry"); if (JSON.stringify(__codeSdk.entries()) !== ${JSON.stringify(expected)}) throw new Error("code_entrypoints_changed"); ${body} }\nexport { run${i} as ${JSON.stringify(entry.entrypoint)} };`;
      })
      .join("\n");
    const modules = new Set<string>();
    const build = await Bun.build({
      entrypoints: ["code:host"],
      target: "browser",
      format: "esm",
      splitting: false,
      plugins: [
        {
          name: "code-virtual-files",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (args.path === "code:entry") return { path: request.entry, namespace: "code" };
              if (args.path === "code:host" || args.path === "@sdk") return { path: args.path, namespace: "code" };
              const name = resolveLocal(args.path, args.importer === "code:entry" ? request.entry : args.importer, request.files);
              if (!name) throw new Error("code_import_forbidden");
              return { path: name, namespace: "code" };
            });
            builder.onLoad({ filter: /.*/, namespace: "code" }, (args) => {
              const name = args.path === "code:entry" ? request.entry : args.path;
              if (name === "code:host") return { contents: `import { __codeSdk } from "@sdk";\n${exports}`, loader: "js" };
              if (name === "@sdk") return { contents: request.sdk.runtime, loader: "js" };
              modules.add(name);
              const contents = request.files[name];
              if (contents === undefined) throw new Error("code_missing_source");
              // Bun elides unused TS value imports in virtual namespaces even with verbatimModuleSyntax.
              // Explicit side-effect imports preserve the same ESM dependency order used by analysis.
              const dependencies = runtimeModuleSpecifiers(ts.createSourceFile(name, contents, ts.ScriptTarget.ESNext, false));
              const prefix = dependencies.map((specifier) => `import ${JSON.stringify(specifier)};`).join("");
              const preserved = contents.replace(/^(#![^\n]*(?:\n|$))?/, (shebang) => `${shebang}${prefix}`);
              return { contents: preserved, loader: name.endsWith(".tsx") ? "tsx" : "ts" };
            });
          },
        },
      ],
    });
    if (!build.success || build.outputs.length !== 1) throw new Error("code_bundle_failed");
    const bundle = await build.outputs[0]!.text();
    if (Buffer.byteLength(bundle) > (request.limits?.bundleBytes ?? 0)) throw new Error("code_bundle_limit");
    console.log(JSON.stringify({ bundle, modules: [...modules] }));
  } else throw new Error("code_check_unknown_role");
}
