import { expect, test } from "bun:test";
import type { RuntimeAppMeta } from "../contracts/app";
import { appAccentStyle, appAppearanceStyle, resolveCurrentApp } from "./app-appearance";

const apps: RuntimeAppMeta[] = [
  { id: "core", name: "Core", icon: "ti ti-cloud", description: "Core", routes: ["/", "/help"] },
  ...["spaces", "timetrack"].map((id) => ({ id, name: id, icon: "ti ti-apps", description: id, routes: [`/app/${id}`] })),
];

test("accent scopes emit the six computed app color properties", () => {
  expect(appAccentStyle("#14b8a6")).toBe(
    "--app-accent:#14b8a6;--app-ink-light:#0d7469;--app-ink-dark:#14b8a6;--app-selected-light:#effaf9;--app-selected-dark:#112c2e;--app-selected-nav-light:#deeeed;--app-selected-nav-dark:#1e3d3f",
  );
});

test("appearance helpers reject invalid accents before emitting any CSS", () => {
  for (const accent of [undefined, "red", "#fff", "#12345g", "#123456;color:red"]) {
    expect(appAccentStyle(accent)).toBeUndefined();
    // @ts-expect-error Exercise unvalidated runtime input at the CSS emission boundary.
    expect(appAppearanceStyle(accent === undefined ? undefined : { accent })).toBeUndefined();
  }
});

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
