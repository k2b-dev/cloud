import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import CloudCalendar from "./CloudCalendar.island";

type Props = ComponentProps<typeof CloudCalendar> & { locale: string };

/** The calendar page as it mounts: the island below the server locale. */
export default function CloudCalendarFixture(props: Props) {
  return (
    <LocaleProvider locale={props.locale}>
      <CloudCalendar
        sidebar={props.sidebar}
        route={props.route}
        sources={props.sources}
        range={props.range}
        items={props.items}
        reads={props.reads}
        today={props.today}
        canCreateSpace={props.canCreateSpace}
        dateConfig={props.dateConfig}
      />
    </LocaleProvider>
  );
}
