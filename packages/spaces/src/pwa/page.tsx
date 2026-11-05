import { type AuthContext, expectUserBackedActor, getDateConfig } from "@k2b/cloud/server";
import { PwaLayout } from "@k2b/cloud/ssr";
import type { Context } from "hono";
import { accepts } from "hono/accepts";
import { type OverviewView, OverviewViewSchema } from "@/overview-contracts";
import { loadOverviewWork } from "@/service/overview";
import { ssr } from "../config";
import { listOf, type PwaList, parseSpaceListFilter, spaceAddress } from "./paths";
import SpacesPwa from "./SpacesPwa.island";
import { searchPwaWork } from "./search";
import { loadPwaGroupPage, loadPwaSpace, loadPwaSpaceEntries, type PwaSpace, parsePwaGroupPage, parsePwaSpaceLoad } from "./space";
import { loadPwaTask, type PwaTask } from "./task";

const viewOf = (value: string | null): OverviewView => {
  const parsed = OverviewViewSchema.safeParse(value);
  return parsed.success ? parsed.data : "mine";
};

const wantsJson = <E extends AuthContext>(c: Context<E>) =>
  accepts(c, { header: "Accept", supports: ["text/html", "application/json"], default: "text/html" }) === "application/json";

const readerOf = <E extends AuthContext>(c: Context<E>) => ({
  actor: c.get("actor"),
  subject: c.get("accessSubject"),
  userId: expectUserBackedActor(c).id,
  dateConfig: getDateConfig(c),
});

/** The Space a list address names, read for the reader; null when it does not exist or they may not read it. */
const readSpace = <E extends AuthContext>(c: Context<E>, list: PwaList): Promise<PwaSpace | null> | undefined =>
  list.kind === "space" ? loadPwaSpace({ spaceShortId: list.spaceShortId, filter: list.filter, reader: readerOf(c) }) : undefined;

const render = async <E extends AuthContext>(c: Context<E>, options: { task?: PwaTask; space?: Promise<PwaSpace | null> } = {}) => {
  const user = expectUserBackedActor(c);
  const url = new URL(c.req.raw.url);
  const list = listOf(url, viewOf);
  const dateConfig = getDateConfig(c);
  // "My tasks" is read on every page: the title's switcher counts it, and the list is there at once after switching.
  const work = await loadOverviewWork({ userId: user.id, view: list.kind === "mine" ? list.view : "mine", dateConfig });
  const [entries, space] = await Promise.all([
    loadPwaSpaceEntries({ userId: user.id, cookieHeader: c.req.header("Cookie"), myWorkCount: work.counts.mine }),
    options.space ?? Promise.resolve(undefined),
  ]);
  const title = options.task?.title ?? (list.kind === "space" ? (space?.name ?? "Spaces") : "Spaces");
  return () => (
    <PwaLayout c={c} title={title} bare>
      <SpacesPwa
        userId={user.id}
        initialList={list}
        initialWork={work}
        spaces={entries}
        initialSpace={list.kind === "space" ? (space ?? null) : undefined}
        dateConfig={dateConfig}
        initialTask={options.task}
      />
    </PwaLayout>
  );
};

/**
 * `/pwa/spaces?view=`: the person's open work in the mobile app, with the web overview's views and its
 * permission-filtered, bounded read. Tasks are checked off in place. With `Accept: application/json` and `q=`, the
 * same address answers with the open tasks in every Space that match, as the search of "My tasks" shows them.
 */
export const myTasksPage = ssr<AuthContext>(async (c) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Accept");
  if (wantsJson(c)) {
    const query = (c.req.query("q") ?? "").trim().slice(0, 300);
    return c.json(query ? await searchPwaWork({ userId: expectUserBackedActor(c).id, query }) : []);
  }
  return render(c);
});

/**
 * `/pwa/spaces/<space>?mine=&tag=&q=`: one Space as a list of its statuses, read with the Space permission of the
 * API. The same address answers `Accept: application/json` with the Space (`load=<status>:<pages>` reads more pages
 * of a status), or with one page of one status for `status=&page=`. A Space that does not exist or that the reader
 * may not read is not found either way, and the page then says that it cannot be opened without naming it.
 */
export const spacePage = ssr<AuthContext>(async (c) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Accept");
  const url = new URL(c.req.raw.url);
  const spaceShortId = spaceAddress(url.pathname) ?? "";
  const filter = parseSpaceListFilter(url.searchParams);
  if (wantsJson(c)) {
    if (url.searchParams.has("status")) {
      const group = await loadPwaGroupPage({ spaceShortId, filter, ...parsePwaGroupPage(url), reader: readerOf(c) });
      return group ? c.json(group) : c.json({ message: "Not found" }, 404);
    }
    const space = await loadPwaSpace({ spaceShortId, filter, load: parsePwaSpaceLoad(url), reader: readerOf(c) });
    return space ? c.json(space) : c.json({ message: "Not found" }, 404);
  }
  const space = loadPwaSpace({ spaceShortId, filter, reader: readerOf(c) });
  if (!(await space)) c.status(404);
  return render(c, { space });
});

/**
 * `/pwa/spaces/<space>/<task>?view=`: one task beside the list, read with the Space permission of the API; with
 * `list=space` beside its Space. The same address answers `Accept: application/json` with the task alone, which the
 * page reads when a row opens a task in place. A task that does not exist or that the reader may not read is not
 * found either way.
 */
export const taskPage = ssr<AuthContext>(async (c) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Accept");
  const task = await loadPwaTask({
    spaceShortId: c.req.param("space") ?? "",
    taskShortId: c.req.param("task") ?? "",
    actor: c.get("actor"),
    subject: c.get("accessSubject"),
  });
  const json = wantsJson(c);
  if (!task) return json ? c.json({ message: "Not found" }, 404) : ssr.error(c, 404, { layout: "pwa" });
  if (json) return c.json(task);
  return render(c, { task, space: readSpace(c, listOf(new URL(c.req.raw.url), viewOf)) });
});
