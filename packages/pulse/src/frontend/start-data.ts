import { type AuthContext, expectUserBackedActor } from "@k2b/cloud/server";
import type { Context } from "hono";
import type { PulseBaseNav } from "../contracts";
import { baseNav } from "../service/base-nav";
import { rememberedBase } from "./base-cookie";

export type PulseStart = { kind: "open"; href: string } | { kind: "start"; deleting: PulseBaseNav[] };

/**
 * Where `/app/pulse` leads, in one statement (the sidebar's own read): the base the person worked in last while they
 * may still read it and it is not being deleted, else the base changed most recently, else the start before the
 * first base, with the bases in deletion its admins still follow.
 */
export const loadPulseStart = async <T extends AuthContext>(c: Context<T>): Promise<PulseStart> => {
  const remembered = rememberedBase(c);
  const nav = await baseNav(expectUserBackedActor(c), { currentId: remembered });
  const base = nav.bases.find((entry) => entry.id === remembered) ?? nav.bases[0];
  if (base) return { kind: "open", href: `/app/pulse/${encodeURIComponent(base.id)}` };
  return { kind: "start", deleting: nav.deleting };
};
