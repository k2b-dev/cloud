import { SegmentedControl } from "@k2b/ui";
import type { AccountCategory } from "@k2b/cloud/contracts";

export default function AccountCategorySwitch(props: {
  options: { value: AccountCategory; label: string; href: string }[];
  value: AccountCategory | "email" | null;
  ariaLabel: string;
}) {
  return (
    <SegmentedControl
      options={props.options}
      value={props.value ?? ""}
      ariaLabel={props.ariaLabel}
      class="w-full"
      onValueChange={(value) => {
        const option = props.options.find((candidate) => candidate.value === value);
        if (option && value !== props.value) window.location.assign(option.href);
      }}
    />
  );
}
