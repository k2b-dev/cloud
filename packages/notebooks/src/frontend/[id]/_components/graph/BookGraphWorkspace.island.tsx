import BookGraphLive from "../book/BookGraphLive";
import BookNavigatorBody, { type BookNavigatorProps, useBookNavigator } from "../book/BookNavigatorBody";
import GraphFrame, { type GraphFrameProps, type GraphShell } from "./GraphWorkspace";

/**
 * The Links graph in Book's shell, for readers and for people who open it from Book: Book's navigation in the
 * sidebar, and Book's live updates, since no Book page is open to follow the notebook's changes.
 */
export default function BookGraphWorkspace(props: Omit<GraphFrameProps, "shell"> & { navigator: BookNavigatorProps }) {
  const navigator = useBookNavigator(props.navigator);
  // Each part is made once: an object literal in JSX props becomes a getter, which would make them anew on every read
  // (one more live listener, one more Book request per change).
  const shell: GraphShell = {
    sidebar: <BookNavigatorBody navigator={navigator} current={props.navigator.current} />,
    navigation: navigator.mobileNavigation,
    get navigationLabel() {
      return navigator.state().notebookName;
    },
    live: <BookGraphLive notebookId={props.notebookId} bookHref={props.navigator.currentHref} />,
  };
  return <GraphFrame {...props} shell={shell} />;
}
