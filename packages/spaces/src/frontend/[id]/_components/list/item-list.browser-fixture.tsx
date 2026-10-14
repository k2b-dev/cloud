import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import SpacesListRoute from "../workspace/SpacesListRoute.island";

type Props = ComponentProps<typeof SpacesListRoute> & { locale: string };

/** The List route as the workspace page mounts it: an island below the server locale. */
export default function ListFixture(props: Props) {
  return (
    <LocaleProvider locale={props.locale}>
      <SpacesListRoute
        spaceId={props.spaceId}
        currentView="list"
        columns={props.columns}
        tags={props.tags}
        filter={props.filter}
        initialItemsResult={props.initialItemsResult}
        initialSelectedItemId={props.initialSelectedItemId}
        itemLinkBaseUrl={props.itemLinkBaseUrl}
        paginationBaseUrl={props.paginationBaseUrl}
        canWrite={props.canWrite}
        currentUserId={props.currentUserId}
      />
    </LocaleProvider>
  );
}
