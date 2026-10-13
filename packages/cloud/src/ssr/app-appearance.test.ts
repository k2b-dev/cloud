import { expect, test } from "bun:test";
import type { RuntimeAppMeta } from "../contracts/app";
import { resolveCurrentApp } from "./app-appearance";

const apps: RuntimeAppMeta[] = [
  { id: "core", name: "Core", icon: "ti ti-cloud", description: "Core", routes: ["/", "/help"] },
  ...["spaces", "timetrack"].map((id) => ({ id, name: id, icon: "ti ti-apps", description: id, routes: [`/app/${id}`] })),
];
test("only Core's exact full-page Help routes belong to the app named in the URL", () => {
  for (const id of ["spaces", "timetrack"]) {
    expect(resolveCurrentApp(apps, `/help/apps/${id}`)?.id).toBe(id);
    expect(resolveCurrentApp(apps, `/help/apps/${id}/start/`)?.id).toBe(id);
  }
  for (const path of ["/help", "/help/apps", "/help/apps/spaces/a/b", "/helpx/apps/spaces", "/help/apps/missing"])
    expect(resolveCurrentApp(apps, path)?.id).toBe("core");
  expect(resolveCurrentApp(apps, "/app/timetrack")?.id).toBe("timetrack");
  expect(resolveCurrentApp(apps, "/app/spaces/help/start")?.id).toBe("spaces");
});
