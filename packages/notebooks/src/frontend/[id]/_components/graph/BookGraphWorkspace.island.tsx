import BookGraphLive from "../book/BookGraphLive";
import BookNavigatorBody, { type BookNavigatorProps, useBookNavigator } from "../book/BookNavigatorBody";
import GraphFrame, { type GraphFrameProps } from "./GraphWorkspace";

/**
 * The Links graph in Book's shell, for readers and for people who open it from Book: Book's navigation in the
 * sidebar, and the live notice over the drawing, since no Book page is open to follow the notebook's changes.
 */
export default function BookGraphWorkspace(props: Omit<GraphFrameProps, "shell"> & { navigator: BookNavigatorProps }) {
  const navigator = useBookNavigator(props.navigator);
  return (
    <GraphFrame
      {...props}
      shell={{
        sidebar: <BookNavigatorBody navigator={navigator} current={props.navigator.current} />,
        navigation: navigator.mobileNavigation,
        navigationLabel: navigator.state().notebookName,
        overlay: <BookGraphLive notebookId={props.notebookId} bookHref={props.navigator.currentHref} />,
      }}
    />
  );
}
