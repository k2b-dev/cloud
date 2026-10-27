import { query } from "@k2b/stdlib/solid";
import { RichSelect, RichSelectFacts, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";

export default function WormholeSelect(props: {
  spaceId: string;
  revision?: string;
  itemId: string;
  disabled: boolean;
  onChoose: (id: string) => void;
}) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const previews = query.create({
    source: () => ({ spaceId: props.spaceId, itemId: props.itemId, revision: props.revision }),
    load: async ({ spaceId, itemId }, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"]["wormhole-previews"].$get(
        { param: { id: spaceId, itemId } },
        { init: { signal: abortSignal } },
      );
      if (response.status === 403) return { spaceId, itemId, denied: true, items: [] };
      if (!response.ok) throw new Error(await readResponseError(response, t.wormholeMoveFailed));
      return { spaceId, itemId, denied: false, items: await response.json() };
    },
  });
  const current = () =>
    previews.data()?.itemId === props.itemId && previews.data()?.spaceId === props.spaceId ? previews.data() : undefined;
  const removed = (preview: NonNullable<ReturnType<typeof current>>["items"][number]) => [
    ...(preview.removedTags.length ? [t.wormholeTagCount({ count: preview.removedTags.length })] : []),
    ...(preview.removedAssignees.length ? [t.wormholeAssigneeCount({ count: preview.removedAssignees.length })] : []),
    ...(preview.removedDependencies.length ? [t.wormholeDependencyCount({ count: preview.removedDependencies.length })] : []),
  ];
  const join = (parts: string[]) => new Intl.ListFormat(locale()).format(parts);
  return (
    <RichSelect
      aria-label={t.moveThroughWormhole}
      title={t.moveThroughWormhole}
      placeholder={t.moveThroughWormhole}
      value={null}
      onValueChange={(id) => {
        if (id) props.onChoose(id);
      }}
      appearance="plain"
      icon="ti ti-arrow-bounce"
      disabled={props.disabled}
      search={false}
      status={previews.loading() || previews.refreshing() ? "loading" : previews.error() ? "error" : "ready"}
      onRetry={() => void previews.refresh()}
      onOpenChange={(open) => {
        if (open && !previews.loading()) void previews.refresh();
      }}
      empty={current()?.denied ? t.wormholeNoWrite : t.noWormholeTargets}
      items={(current()?.items ?? []).map((preview) => ({
        value: preview.id,
        label: preview.target ? `${preview.target.spaceName} · ${preview.target.columnName}` : t.unavailableWormhole,
        color: preview.target?.spaceColor,
        // A guest who sees the card there matters as much as what the move drops.
        description:
          [
            ...(preview.audience?.guestCount ? [t.wormholeGuestsSee({ count: preview.audience.guestCount })] : []),
            ...(removed(preview).length
              ? [
                  t.wormholeDrops({
                    changes: join(removed(preview)),
                    count: preview.removedTags.length + preview.removedAssignees.length + preview.removedDependencies.length,
                  }),
                ]
              : []),
          ].join(", ") || t.wormholeNothingDrops,
        disabledReason: !preview.canWrite ? t.wormholeNoWrite : undefined,
      }))}
      renderPreview={(item) => {
        const preview = current()?.items.find((preview) => preview.id === item.value);
        if (!preview?.audience || item.disabledReason) return <p>{item.disabledReason}</p>;
        const audience = preview.audience;
        const visibility = audience.public
          ? t.wormholePublic
          : audience.authenticated
            ? t.wormholeAuthenticated
            : t.wormholeMembers({ count: audience.memberCount });
        const losses = [
          ...(preview.removedTags.length ? [t.wormholeTagNames({ names: join(preview.removedTags) })] : []),
          ...(preview.removedAssignees.length ? [t.wormholeAssigneeNames({ names: join(preview.removedAssignees) })] : []),
          ...(preview.removedDependencies.length ? [t.wormholeDependencyNames({ names: join(preview.removedDependencies) })] : []),
        ];
        return (
          <RichSelectFacts
            facts={[
              {
                icon: "ti ti-eye",
                text: [
                  visibility,
                  ...(audience.guestCount ? [t.wormholeGuests({ count: audience.guestCount })] : []),
                  ...(audience.serviceAccountCount ? [t.wormholeAccounts({ count: audience.serviceAccountCount })] : []),
                ].join(" "),
              },
              {
                icon: losses.length ? "ti ti-alert-triangle" : "ti ti-check",
                tone: losses.length ? "warning" : "default",
                text: losses.length ? t.wormholeLossDetails({ changes: join(losses) }) : t.wormholeNothingDrops,
              },
              { icon: "ti ti-paperclip", text: t.wormholeContentMoves },
            ]}
          />
        );
      }}
    />
  );
}
