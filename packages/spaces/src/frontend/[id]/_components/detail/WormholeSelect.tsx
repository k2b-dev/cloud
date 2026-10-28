import { query } from "@k2b/stdlib/solid";
import { Button, InlineGuidance, RichSelect, RichSelectFacts, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceWormhole } from "@/contracts";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";

export default function WormholeSelect(props: {
  spaceId: string;
  wormholes: readonly SpaceWormhole[];
  itemId: string;
  disabled: boolean;
  onChoose: (id: string) => void;
}) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const [opened, setOpened] = createSignal(false);
  const previews = query.create({
    source: () => [props.spaceId, props.itemId] as const,
    isSameSource: (a, b) => a[0] === b[0] && a[1] === b[1],
    enabled: opened,
    load: async ([spaceId, itemId], { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"]["wormhole-previews"].$get(
        { param: { id: spaceId, itemId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.wormholeMoveFailed));
      return { spaceId, itemId, items: await response.json() };
    },
  });
  const current = () =>
    !previews.error() && previews.data()?.itemId === props.itemId && previews.data()?.spaceId === props.spaceId
      ? previews.data()
      : undefined;
  const removed = (preview: NonNullable<ReturnType<typeof current>>["items"][number]) => [
    ...(preview.removedTags.length ? [t.wormholeTagCount({ count: preview.removedTags.length })] : []),
    ...(preview.removedAssignees.length ? [t.wormholeAssigneeCount({ count: preview.removedAssignees.length })] : []),
    ...(preview.removedDependencyCount ? [t.wormholeDependencyCount({ count: preview.removedDependencyCount })] : []),
  ];
  const wormholes = () => [
    ...new Map([...props.wormholes, ...(current()?.items ?? [])].map((wormhole) => [wormhole.id, wormhole])).values(),
  ];
  const missingPreview = () => (previews.loading() || previews.refreshing() ? t.wormholePreviewLoading : t.wormholePreviewUnknown);
  const join = (parts: string[]) => new Intl.ListFormat(locale()).format(parts);
  return (
    <>
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
        status="ready"
        onRetry={() => void previews.refresh()}
        onOpenChange={(open) => {
          setOpened(open);
          if (open) void previews.refresh();
        }}
        empty={t.noWormholeTargets}
        items={wormholes().flatMap((wormhole) => {
          if (!wormhole.target) return [];
          const preview = current()?.items.find((preview) => preview.id === wormhole.id);
          return [
            {
              value: wormhole.id,
              label: `${wormhole.target.spaceName} · ${wormhole.target.columnName}`,
              color: wormhole.target.spaceColor,
              description: preview
                ? [
                    ...(preview.audience?.guestCount ? [t.wormholeGuestsSee({ count: preview.audience.guestCount })] : []),
                    ...(removed(preview).length
                      ? [
                          t.wormholeDrops({
                            changes: join(removed(preview)),
                            count: preview.removedTags.length + preview.removedAssignees.length + preview.removedDependencyCount,
                          }),
                        ]
                      : []),
                  ].join(", ") || t.wormholeNothingDrops
                : missingPreview(),
              disabledReason: preview && !preview.canWrite ? t.wormholeNoWrite : undefined,
            },
          ];
        })}
        renderPreview={(item) => {
          const preview = current()?.items.find((preview) => preview.id === item.value);
          if (!preview?.audience || item.disabledReason) return <p>{item.disabledReason ?? missingPreview()}</p>;
          const audience = preview.audience;
          const visibility = audience.public
            ? t.wormholePublic
            : audience.authenticated
              ? t.wormholeAuthenticated
              : t.wormholeMembers({ count: audience.memberCount });
          const losses = [
            ...(preview.removedTags.length ? [t.wormholeTagNames({ names: join(preview.removedTags) })] : []),
            ...(preview.removedAssignees.length ? [t.wormholeAssigneeNames({ names: join(preview.removedAssignees) })] : []),
            ...(preview.removedDependencies.length
              ? [t.wormholeDependencyNames({ names: join(preview.removedDependencies), count: preview.removedDependencyCount })]
              : []),
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
      <Show when={opened() && previews.error()}>
        <InlineGuidance tone="warning">
          {t.wormholePreviewUnknown}{" "}
          <Button size="xs" variant="text" onClick={() => void previews.refresh()}>
            {t.retry}
          </Button>
        </InlineGuidance>
      </Show>
    </>
  );
}
