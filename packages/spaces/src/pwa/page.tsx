import { type AuthContext, expectUserBackedActor, getDateConfig } from "@k2b/cloud/server";
import { PwaLayout } from "@k2b/cloud/ssr";
import type { Context } from "hono";
import { accepts } from "hono/accepts";
import { type OverviewView, OverviewViewSchema } from "@/overview-contracts";
import { loadOverviewWork } from "@/service/overview";
import { ssr } from "../config";
import SpacesPwa from "./SpacesPwa.island";
import { loadPwaTask, type PwaTask } from "./task";

const viewOf = <E extends AuthContext>(c: Context<E>): OverviewView => {
  const parsed = OverviewViewSchema.safeParse(c.req.query("view"));
  return parsed.success ? parsed.data : "mine";
};

const render = async <E extends AuthContext>(c: Context<E>, task?: PwaTask) => {
  const user = expectUserBackedActor(c);
  const view = viewOf(c);
  const dateConfig = getDateConfig(c);
  const work = await loadOverviewWork({ userId: user.id, view, dateConfig });
  return () => (
    <PwaLayout c={c} title={task ? task.title : "Spaces"} bare>
      <SpacesPwa userId={user.id} initialView={view} initialWork={work} dateConfig={dateConfig} initialTask={task} />
    </PwaLayout>
  );
};

/**
 * `/pwa/spaces?view=`: the person's open work in the mobile app, with the web overview's views and its
 * permission-filtered, bounded read. Tasks are checked off in place.
 */
export const myTasksPage = ssr<AuthContext>(async (c) => {
  c.header("Cache-Control", "private, no-store");
  return render(c);
});

/**
 * `/pwa/spaces/<space>/<task>?view=`: one task beside the list, read with the Space permission of the API. The same
 * address answers `Accept: application/json` with the task alone, which the page reads when a row opens a task in
 * place. A task that does not exist or that the reader may not read is not found either way.
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
  const json = accepts(c, { header: "Accept", supports: ["text/html", "application/json"], default: "text/html" }) === "application/json";
  if (!task) return json ? c.json({ message: "Not found" }, 404) : ssr.error(c, 404, { layout: "pwa" });
  if (json) return c.json(task);
  return render(c, task);
});
