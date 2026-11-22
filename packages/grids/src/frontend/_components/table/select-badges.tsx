import { Tag, Tooltip, useLocale } from "@k2b/ui";
import type { JSX } from "solid-js";
import { tableMessages } from "./messages";
import type { SelectBadgeItem } from "./select-badge-utils";

export function SelectValueBadges(props: { items: SelectBadgeItem[]; empty?: JSX.Element }) {
  const locale = useLocale();
  const t = () => tableMessages.resolve([locale()]).t;
  return (
    <span class="inline-flex min-w-0 flex-wrap items-center gap-1">
      {props.items.length === 0
        ? (props.empty ?? "")
        : props.items.map((item) => (
            <Tooltip.Anchor content={t().unknownOption({ id: item.id })} disabled={item.known}>
              <Tag size="sm" color={item.color} class={`max-w-full shrink-0 ${item.known ? "" : "opacity-75"}`}>
                {item.label}
              </Tag>
            </Tooltip.Anchor>
          ))}
    </span>
  );
}
