import { Bar, Button, Text, useLocale } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { aiUsageMessages } from "../settings/_components/ai-usage-messages";

/**
 * Previous and next page under a table, with where the page stands ("51–100 von 312").
 * k2b-ui gap: no pager primitive in v2; a `Bar` after the table with two link buttons stands in.
 */
export function PageBar(props: { page: number; perPage: number; total: number; href: (page: number) => string }) {
  const locale = useLocale();
  const t = () => aiUsageMessages.resolve([locale()]).t;
  const n = (value: number) => value.toLocaleString(locale());
  const last = () => Math.max(1, Math.ceil(props.total / props.perPage));
  return (
    <Show when={last() > 1}>
      <Bar
        start={
          <Text type="meta" muted>
            {t().pageRange({
              from: n(Math.min(props.total, (props.page - 1) * props.perPage + 1)),
              to: n(Math.min(props.total, props.page * props.perPage)),
              total: n(props.total),
            })}
          </Text>
        }
        end={
          <>
            <Button icon="chevron-left" href={props.page > 1 ? props.href(props.page - 1) : undefined} disabled={props.page <= 1}>
              {t().previous}
            </Button>
            <Button
              icon="chevron-right"
              href={props.page < last() ? props.href(props.page + 1) : undefined}
              disabled={props.page >= last()}
            >
              {t().next}
            </Button>
          </>
        }
      />
    </Show>
  );
}
