import type { DateContext } from "@k2b/stdlib";
import type { OverviewView, OverviewWork } from "../overview-contracts";
import { dashboardSnapshot, listMyTasks } from "./items";

/** Both SSR and view navigation use the same permission-filtered reads and limits. */
export async function loadOverviewWork(params: { userId: string; view: OverviewView; dateConfig: DateContext }): Promise<OverviewWork> {
  const [dashboard, mine] = await Promise.all([
    dashboardSnapshot({ ...params, view: params.view === "mine" ? "counts" : params.view, todoLimit: 30 }),
    params.view === "mine" ? listMyTasks({ userId: params.userId, limit: 100 }) : Promise.resolve([]),
  ]);
  const items = params.view === "mine" ? mine : params.view === "today" ? dashboard.events : dashboard.todos;
  return {
    view: params.view,
    counts: { mine: dashboard.assignedToMeCount, today: dashboard.todayCount, upcoming: dashboard.upcomingCount },
    items: items.map((item) => ({
      shortId: item.shortId,
      spaceShortId: item.spaceShortId,
      spaceName: item.spaceName,
      spaceColor: item.spaceColor,
      title: item.title,
      priority: item.priority,
      startsAt: "startsAt" in item ? item.startsAt : null,
      endsAt: "endsAt" in item ? item.endsAt : null,
      deadline: item.deadline,
    })),
  };
}
