import { SelectChip, useLocale } from "@k2b/ui";
import type { CardSize } from "../records-view/query-url";
import { toolbarMessages } from "./messages";

export function CardSizeDropdown(props: { value: CardSize; onChange: (size: CardSize) => void }) {
  const locale = useLocale();
  const t = () => toolbarMessages.resolve([locale()]).t;
  const options = (): Array<{ value: CardSize; label: string; icon: string }> => [
    { value: "small", label: t().smallCards, icon: "ti ti-layout-grid" },
    { value: "medium", label: t().mediumCards, icon: "ti ti-layout-cards" },
    { value: "large", label: t().largeCards, icon: "ti ti-square" },
  ];
  const selected = () => options().find((option) => option.value === props.value) ?? options()[1]!;

  return (
    <SelectChip<CardSize>
      aria-label={t().cardSize}
      value={() => props.value}
      onValueChange={props.onChange}
      icon={selected().icon}
      position="bottom-right"
      options={options().map(({ value, label, icon }) => ({ value, label, icon }))}
    />
  );
}
