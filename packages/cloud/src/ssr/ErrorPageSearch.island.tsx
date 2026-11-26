import { Button } from "@k2b/ui/v2";
import { importOnDemand } from "../browser/reload";
import { openGlobalSearch } from "../browser/search";

/** The error page's second way out on a missing or closed page: the shell's search, opened in place. */
export default function ErrorPageSearch(props: { label: string }) {
  const open = () => void importOnDemand(() => import("./GlobalSearchDialog")).then(() => openGlobalSearch());
  return (
    <Button icon="search" onClick={open}>
      {props.label}
    </Button>
  );
}
