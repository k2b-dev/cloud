import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import SpacesCalendarRoute from "../workspace/SpacesCalendarRoute.island";

type Props = ComponentProps<typeof SpacesCalendarRoute> & { locale: string };

/** The calendar route as the workspace page mounts it: an island below the server locale. */
export default function TimelineFixture(props: Props) {
  return (
    <LocaleProvider locale={props.locale}>
      <SpacesCalendarRoute
        spaceId={props.spaceId}
        baseUrl={props.baseUrl}
        columns={props.columns}
        tags={props.tags}
        initialState={props.initialState}
        selectedItemId={props.selectedItemId}
        dateConfig={props.dateConfig}
        canWrite={props.canWrite}
      />
    </LocaleProvider>
  );
}
