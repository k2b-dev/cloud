import type { CodePageTarget } from "./data";
import type { CodePageMessages } from "./messages";

/**
 * What a Code version calls at which target, as its checked manifest records it. Browser-safe: the Code page, Core's
 * switch-on preview and the chat's version card group and name targets with these same rules.
 */
type Ref = { type: string; id: string };
type Permission = { operation: string; target: { type: string; id: string | null } | null };

export const targetKey = (ref: Ref) => `${ref.type}\u0000${ref.id}`;

/** Core turns a permission without a target into a grant at the receiving app; dynamic personal IDs have none. */
export const permissionRef = (permission: Permission): Ref | null =>
  permission.target === null
    ? { type: "app", id: permission.operation.split(".")[0]! }
    : permission.target.id === null
      ? null
      : { type: permission.target.type, id: permission.target.id };

/** The operations of one manifest per target, in the order the manifest first names each target. */
export const codeTargetsOf = (manifest: { permissions: readonly Permission[] } | null) => {
  const map = new Map<string, { ref: Ref; operations: Set<string> }>();
  for (const permission of manifest?.permissions ?? []) {
    const ref = permissionRef(permission);
    if (!ref) continue;
    const entry = map.get(targetKey(ref)) ?? { ref, operations: new Set<string>() };
    entry.operations.add(permission.operation);
    map.set(targetKey(ref), entry);
  }
  return map;
};

/**
 * Every target switching on the waiting version uses, and whether it is new compared with the running version: a target
 * it did not call or an operation it did not make there. A resource owner is always listed, also when the Code only
 * works on itself.
 */
export const codeActivationRows = (
  active: { permissions: readonly Permission[] } | null,
  waiting: { permissions: readonly Permission[] },
  ownerRef: Ref | null,
): { ref: Ref; operations: string[]; isNew: boolean }[] => {
  const activeByTarget = codeTargetsOf(active);
  const waitingByTarget = codeTargetsOf(waiting);
  return [
    ...(!ownerRef || waitingByTarget.has(targetKey(ownerRef)) ? [] : [{ ref: ownerRef, operations: [] as string[], isNew: false }]),
    ...[...waitingByTarget.values()].map((entry) => {
      const present = activeByTarget.get(targetKey(entry.ref))?.operations;
      return {
        ref: entry.ref,
        operations: [...entry.operations],
        isNew: !present || [...entry.operations].some((operation) => !present.has(operation)),
      };
    }),
  ];
};

/** Operations whose target ID the Code picks while it runs, and whether the running version made none of them yet. */
export const codeDynamicOperations = (
  active: { permissions: readonly Permission[] } | null,
  waiting: { permissions: readonly Permission[] },
): { operations: string[]; isNew: boolean } | null => {
  const dynamic = (manifest: { permissions: readonly Permission[] } | null) =>
    new Set((manifest?.permissions ?? []).filter((permission) => permission.target?.id === null).map((permission) => permission.operation));
  const before = dynamic(active);
  const operations = [...dynamic(waiting)];
  return operations.length ? { operations, isNew: operations.some((operation) => !before.has(operation)) } : null;
};

/** A foreign target is never named: its type and ID only, like cron names a path. */
export const codeTargetName = (target: CodePageTarget, ownerTitle: string): string => {
  if (target.own) return ownerTitle;
  if (target.ref.type === "app") return target.title ?? target.ref.id;
  return [target.typeTitle, target.ref.id].filter(Boolean).join(" ");
};

/** "at Space sp_2lg8", "in the app Mail", or the owner itself. */
export const codeTargetLabel = (target: CodePageTarget, ownerTitle: string, t: CodePageMessages): string => {
  if (target.own) return t.atOwn({ name: ownerTitle });
  if (target.ref.type === "app") return t.atApp({ name: target.title ?? target.ref.id });
  if (target.typeTitle) return t.atTarget({ name: codeTargetName(target, ownerTitle) });
  return t.unknownTarget({ id: target.ref.id });
};
