import { gridsService } from "../service";
import { parseRecentBases } from "./_components/sidebar/GridsSettingsStore";

/** The most bases the switcher lists: the service's largest page. More are reached by their address. */
export const BASE_CHOICES_LIMIT = 500;

/** A base the switcher offers, by its public id. */
export type BaseChoice = { id: string; name: string };

/** The bases a person can switch to: the ones opened last first (as the cookie names them), then all others by name. */
export type BaseChoices = { recent: BaseChoice[]; others: BaseChoice[] };

/** Reads the bases the person may open once (one statement) and orders them for the switcher. */
export const loadBaseChoices = async (
  subject: { userId: string; userGroups: string[] },
  cookie: string | undefined,
  locale: string,
): Promise<BaseChoices> => {
  const visible = await gridsService.base.listVisibleItems({ ...subject, limit: BASE_CHOICES_LIMIT });
  const byId = new Map(visible.map((base) => [base.shortId, { id: base.shortId, name: base.name }]));
  // a base opened last that the person may no longer open, or that no longer exists, drops out here
  const recent = parseRecentBases(cookie).flatMap((id) => byId.get(id) ?? []);
  const opened = new Set(recent.map((base) => base.id));
  const others = [...byId.values()].filter((base) => !opened.has(base.id)).sort((a, b) => a.name.localeCompare(b.name, locale));
  return { recent, others };
};
