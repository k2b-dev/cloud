import type { PermissionLevel } from "../contracts/shared";
import type { accessMessages } from "./messages";

/** The three grantable permission levels — `"none"` exists in the
 *  contract for resolution semantics but is never directly granted. */
export type GrantableLevel = Exclude<PermissionLevel, "none">;

/** Either a bare level (uses the default View / Edit / Manage label and
 *  icon) or an object with per-context overrides. A `scope` offers the level
 *  on a narrower part of the resource that the application defines, such as
 *  Mail's assigned conversations; it reaches the callbacks and matches the
 *  entry's `scope`. `description` explains an option in the level menu. */
export type AllowedLevel = GrantableLevel | { level: GrantableLevel; scope?: string; label?: string; icon?: string; description?: string };

export const defaultLabels = (
  t: ReturnType<typeof accessMessages.resolve>["t"],
): Record<PermissionLevel, { label: string; icon: string }> => ({
  read: { label: t.view, icon: "ti-eye" },
  write: { label: t.edit, icon: "ti-pencil" },
  admin: { label: t.manage, icon: "ti-shield" },
  // Defensive — never granted by this editor, but renders correctly if
  // a legacy entry has permission === "none".
  none: { label: t.noAccess, icon: "ti-ban" },
});

export type ResolvedLevel = {
  level: GrantableLevel;
  scope: string | undefined;
  /** Unique per option: the level, prefixed by its scope. */
  key: string;
  label: string;
  icon: string;
  description: string | undefined;
};

export const levelKey = (level: PermissionLevel, scope: string | undefined): string => (scope ? `${scope}:${level}` : level);

/** Resolve the AllowedLevel union into a flat shape the renderer can
 *  loop over. Falls back to the default View / Edit / Manage list when
 *  no override is given. */
export const resolveAllowedLevels = (
  allowed: AllowedLevel[] | undefined,
  t: ReturnType<typeof accessMessages.resolve>["t"],
): ResolvedLevel[] => {
  const defaults = defaultLabels(t);
  const list = allowed && allowed.length > 0 ? allowed : (["read", "write", "admin"] as GrantableLevel[]);
  return list.map((entry) => {
    const level = typeof entry === "string" ? entry : entry.level;
    const override = typeof entry === "string" ? null : entry;
    const def = defaults[level];
    return {
      level,
      scope: override?.scope,
      key: levelKey(level, override?.scope),
      label: override?.label ?? def.label,
      icon: override?.icon ?? def.icon,
      description: override?.description,
    };
  });
};
