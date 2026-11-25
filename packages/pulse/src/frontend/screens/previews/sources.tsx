import { LocaleProvider } from "@k2b/ui";
import SourcesScreen from "../SourcesScreen";
import { sourcesProps } from "../fixtures";

/** The sources of a base with one source open, for `v2-preview`. */
export default () => (
  <LocaleProvider locale="de">
    <SourcesScreen {...sourcesProps({ open: "s7Ee8Ff9" })} />
  </LocaleProvider>
);
