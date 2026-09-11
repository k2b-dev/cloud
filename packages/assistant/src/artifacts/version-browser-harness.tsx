import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { ArtifactPanel } from "./ArtifactPanel";
render(() => {
  const [refresh, setRefresh] = createSignal(0);
  return <><button onClick={() => setRefresh(v => v + 1)}>Tool completed</button>
    <ArtifactPanel artifactId="test" userId="test" refreshKey={String(refresh())} browseSource={() => {}} />
  </>;
}, document.getElementById("root")!);
