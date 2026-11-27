import { afterEach, expect, spyOn, test } from "bun:test";
import { type AuthContext, ok } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { type Context, Hono } from "hono";
import { pulseService } from "../../service";
import * as access from "../../service/access-control";
import * as attention from "../../service/base-attention";
import * as baseNavModule from "../../service/base-nav";
import * as resources from "../../service/public-resources";
import { savedQueries } from "../../service/saved-queries";
import * as sqlService from "../../service/sql-service";
import { adminFixtureIdentity } from "../../store/admin-identity.test-fixture";
import { figuresOf, fixtureBase, fixtureNav } from "../screens/fixtures";
import { SOURCES_PAGE } from "../workspace/source-page";
import { sqlTestLimits } from "../workspace/sql-test-fixtures";
import { loadPulseQueriesPageData, loadPulseSettingsPageData, loadPulseWorkspacePageData } from "./page-data";

const baseId = "11111111-1111-4111-8111-111111111111";
const identity = adminFixtureIdentity();
const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Every read the pages of a base make besides their sources, answered without a database. */
const stubBase = () => {
  const list = spyOn(pulseService.source, "list").mockResolvedValue(ok([]));
  const count = spyOn(pulseService.source, "count").mockResolvedValue(ok(4));
  spies.push(spyOn(pulseService.source, "figures").mockResolvedValue(ok(figuresOf([]))));
  spies.push(
    list,
    count,
    spyOn(resources, "resolvePublicId").mockResolvedValue(baseId),
    spyOn(baseNavModule, "baseNav").mockResolvedValue(fixtureNav()),
    spyOn(pulseService.base, "get").mockResolvedValue(ok(fixtureBase({ id: baseId, name: "Werkstatt" }))),

    spyOn(access, "requireBaseAccess").mockResolvedValue(ok("admin")),
    spyOn(savedQueries, "list").mockResolvedValue(ok({ items: [], total: 0, nextOffset: null })),
    spyOn(sqlService, "baseSqlLimits").mockResolvedValue(ok(sqlTestLimits)),
    spyOn(attention, "readBaseAttention").mockResolvedValue(
      ok({ alerts: [], readAt: "2026-11-25T09:00:00.000Z", store: { unavailable: false, since: null } }),
    ),
    spyOn(services, "get").mockResolvedValue("https://cloud.example.test"),
  );
  return { list, count };
};

/** Runs one loader inside a request for `path`, as the page does. */
const load = async <T>(pattern: string, path: string, loader: (c: Context<AuthContext>) => Promise<T>) => {
  let result: T | undefined;
  await new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", identity.actor);
      c.set("accessSubject", identity.accessSubject);
      await next();
    })
    .get(pattern, async (c) => {
      result = await loader(c);
      return c.text("ok");
    })
    .request(path);
  return result;
};

test("saved queries and settings count the sources for their tab and never read the list with its store figures", async () => {
  const { list, count } = stubBase();
  await load("/app/pulse/:baseId/queries", "/app/pulse/Base01/queries", (c) => loadPulseQueriesPageData(c, 50));
  await load("/app/pulse/:baseId/settings", "/app/pulse/Base01/settings", (c) => loadPulseSettingsPageData(c, "general"));
  expect(list).not.toHaveBeenCalled();
  expect(count).toHaveBeenCalledTimes(2);
});

test("the sources view reads one page of sources, and its tab still counts them all", async () => {
  const { list, count } = stubBase();
  const data = await load("/app/pulse/:baseId", "/app/pulse/Base01", (c) => loadPulseWorkspacePageData(c));
  expect(list).toHaveBeenCalledTimes(1);
  expect(list.mock.calls[0]?.[2]).toMatchObject({ limit: SOURCES_PAGE });
  expect(count).toHaveBeenCalledTimes(1);
  expect(data).toMatchObject({ kind: "ok", sourceCount: 4 });
});
