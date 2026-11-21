import { expect, test } from "bun:test";
import { codeCheckHostSource } from "./checker-bundle-source";
import type { CodeVersionManifest } from "./checker-contract";

const route = { method: "GET" as const, path: "/", public: false, layout: "plain" as const };
const registration: Pick<CodeVersionManifest["entrypoints"][number], "kind" | "entrypoint" | "route" | "cron"> = {
  kind: "route",
  entrypoint: "route:GET:/",
  route,
  cron: null,
};

/** Execute the generated host with the SDK's actual registration shape, without a native runner. */
async function run(page: boolean, actual: typeof registration) {
  const source = codeCheckHostSource([{ ...registration, file: "code.tsx", line: 1, route: { ...route, page } }], false);
  const built = await Bun.build({
    entrypoints: ["host"],
    target: "bun",
    plugins: [
      {
        name: "registration-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^(host|@sdk|code:entry)$/ }, ({ path }) => ({ path, namespace: "fixture" }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            contents:
              path === "host"
                ? source
                : path === "@sdk"
                  ? `export const __codeSdk = { bind() {}, entries: () => ${JSON.stringify([actual])}, run: () => "ran" };`
                  : "export {};",
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "Registration host did not build");
  const module = await import(`data:text/javascript;base64,${Buffer.from(await built.outputs[0]!.text()).toString("base64")}`);
  return module[registration.entrypoint](null, {});
}

test("page and data evidence do not change the SDK's route registration", async () => {
  await expect(run(true, registration)).resolves.toBe("ran");
  await expect(run(false, registration)).resolves.toBe("ran");
});

test("route registration still rejects changed method, path, public access and layout", async () => {
  const changes: Partial<NonNullable<typeof registration.route>>[] = [
    { method: "POST" },
    { path: "/other" },
    { public: true },
    { layout: undefined },
  ];
  for (const changed of changes)
    await expect(run(true, { ...registration, route: { ...route, ...changed } })).rejects.toThrow("code_entrypoints_changed");
});
