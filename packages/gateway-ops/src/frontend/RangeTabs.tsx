import { ViewTabs } from "@k2b/ui";

type Props = {
  /** Visible caption before the ranges, such as "Traffic window". */
  caption: string;
  /** Accessible name of the range navigation. */
  label: string;
  current: string;
  items: readonly { id: string; href: string }[];
};

/** Time ranges as ordinary links: the open range carries the app's selection tint, like a view tab. */
export default function RangeTabs(props: Props) {
  return (
    <div class="flex min-w-0 items-center gap-1">
      <span class="mr-1 shrink-0 text-[10px] text-dimmed" aria-hidden="true">
        {props.caption}
      </span>
      <ViewTabs label={props.label} current={props.current} items={props.items.map((item) => ({ ...item, label: item.id }))} />
    </div>
  );
}
