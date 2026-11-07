import type { UserProfile, UserProvider } from "../../contracts/shared";
import { sql } from "../../runtime/clients";
import * as settings from "../settings";
import type { IpaAccountTransitionPolicy } from "./model";

type SqlExecutor = typeof sql;

/**
 * Remove provider-scoped group and manager relations for a user.
 * Local group memberships are intentionally preserved when switching providers.
 */
export const clearUserRelationsForProvider = async (params: {
  userId: string;
  provider: UserProvider;
  db?: SqlExecutor;
}): Promise<void> => {
  const db = params.db ?? sql;

  await db`
    DELETE FROM auth.user_groups_v2 ug
    USING auth.groups g
    WHERE ug.group_id = g.id
      AND ug.user_id = ${params.userId}
      AND g.provider = ${params.provider}
  `;

  await db`
    DELETE FROM auth.group_manager_users_v2 gmu
    USING auth.groups g
    WHERE gmu.group_id = g.id
      AND gmu.user_id = ${params.userId}
      AND g.provider = ${params.provider}
  `;
};

const getLocalExpiryDays = async (profile: UserProfile): Promise<number> => {
  if (profile === "guest") {
    const configured = await settings.get<number | null>("user.account.local_guest_expires_days");
    return typeof configured === "number" ? configured : 365;
  }

  const configured = await settings.get<number | null>("user.account.local_user_expires_days");
  return typeof configured === "number" ? configured : 0;
};

export const resolveDefaultLocalAccountExpiry = async (profile: UserProfile): Promise<Date | null> => {
  const days = await getLocalExpiryDays(profile);
  if (days <= 0) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
};

export const resolveIpaTransitionTarget = async (params: {
  currentProfile: UserProfile;
  policy: Exclude<IpaAccountTransitionPolicy, "delete">;
}): Promise<{ targetProfile: UserProfile; accountExpires: Date | null }> => {
  const targetProfile = resolveIpaTransitionProfile(params);

  return {
    targetProfile,
    accountExpires: await resolveDefaultLocalAccountExpiry(targetProfile),
  };
};

export const resolveIpaTransitionProfile = (params: {
  currentProfile: UserProfile;
  policy: Exclude<IpaAccountTransitionPolicy, "delete">;
}): UserProfile => {
  if (params.policy === "demote_to_local") return params.currentProfile;
  if (params.policy === "demote_to_local_user") return "user";
  return "guest";
};

export const transitionIpaUserToLocal = async (params: {
  userId: string;
  targetProfile: UserProfile;
  accountExpires: Date | null;
  db?: SqlExecutor;
}): Promise<void> => {
  const db = params.db ?? sql;

  await db`
    UPDATE auth.users
    SET provider = 'local',
        profile = ${params.targetProfile},
        admin = false,
        account_expires = ${params.accountExpires}
    WHERE id = ${params.userId}::uuid
  `;

  await db`
    DELETE FROM auth.user_ipa_data
    WHERE user_id = ${params.userId}::uuid
  `;

  await db`
    DELETE FROM auth.ipa_user_effective_groups
    WHERE user_id = ${params.userId}::uuid
  `;

  await clearUserRelationsForProvider({
    userId: params.userId,
    provider: "ipa",
    db,
  });
};

export const applyIpaAccountTransitionPolicy = async (params: {
  userId: string;
  currentProfile: UserProfile;
  policy: Exclude<IpaAccountTransitionPolicy, "delete">;
  db?: SqlExecutor;
}): Promise<{ targetProfile: UserProfile; accountExpires: Date | null }> => {
  const target = await resolveIpaTransitionTarget({
    currentProfile: params.currentProfile,
    policy: params.policy,
  });

  await transitionIpaUserToLocal({
    userId: params.userId,
    targetProfile: target.targetProfile,
    accountExpires: target.accountExpires,
    db: params.db,
  });

  return target;
};
