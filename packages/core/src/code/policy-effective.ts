import type { CodeOwner } from "./contracts";
import type { CodePolicyDefinition, CodePolicyRow, CodePolicyValue } from "./policy-contracts";

/** Live group membership and same-provider strict ancestry. IPA groups have no hierarchy and are peers. */
export type CodePolicyGroups = {
  groups: { id: string; provider: string }[];
  ancestors: { groupId: string; ancestorId: string }[];
};
export type EffectiveCodePolicyRow = {
  row: CodePolicyRow;
  value: CodePolicyValue;
  source: "default" | "group" | "veto";
  groupIds: string[];
};
/**
 * Resolve one classification for the personal owner, or a resource/app version's author.
 * Default/group never vetoes every relaxation. Proper descendants beat ancestors;
 * cycles and unrelated/provider-separated groups are peers, with the stricter value winning.
 * Resource/app Code uses default rows plus author vetoes; group rules cannot loosen its policy.
 * Supply current database groups, not a request's potentially cached memberof fields.
 */
export function effective(
  row: CodePolicyRow,
  owner: CodeOwner,
  policy: CodePolicyDefinition,
  membership: CodePolicyGroups,
): EffectiveCodePolicyRow {
  const fallback = policy.rules.find((rule) => rule.row === row && rule.groupId === null)?.value ?? "never";
  const base = { row, value: fallback, source: "default" as const, groupIds: [] };
  if (fallback === "never") return { ...base, source: "veto" };
  const groups = new Map(membership.groups.map((group) => [group.id, group]));
  const rules = policy.rules.filter((rule) => rule.row === row && rule.groupId !== null && groups.has(rule.groupId));
  const vetoes = rules.filter((rule) => rule.value === "never").map((rule) => rule.groupId!);
  if (vetoes.length) return { row, value: "never", source: "veto", groupIds: vetoes.sort() };
  if (owner.kind !== "person" || !rules.length) return base;
  const ancestry = new Set(membership.ancestors.map((edge) => `${edge.groupId}:${edge.ancestorId}`));
  const descendant = (child: string, parent: string) => {
    const group = groups.get(child);
    return (
      group?.provider !== "ipa" &&
      group?.provider === groups.get(parent)?.provider &&
      ancestry.has(`${child}:${parent}`) &&
      !ancestry.has(`${parent}:${child}`)
    );
  };
  const candidates = rules.filter((rule) => !rules.some((other) => descendant(other.groupId!, rule.groupId!)));
  const value = candidates.some((rule) => rule.value === "admin") ? "admin" : "automatic";
  return {
    row,
    value,
    source: "group",
    groupIds: candidates
      .filter((rule) => rule.value === value)
      .map((rule) => rule.groupId!)
      .sort(),
  };
}
