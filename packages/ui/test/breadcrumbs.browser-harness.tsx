import { render } from "solid-js/web";
import { Breadcrumbs } from "../src/layout/Breadcrumbs";

// A path in a host whose width the test changes: four levels above the current folder.
render(
  () => (
    <div id="host" style={{ width: "640px", display: "flex" }}>
      <Breadcrumbs
        label="Path"
        items={[
          { label: "My files", href: "#root" },
          { label: "Projects and customers", href: "#projects" },
          { label: "2026 archive", href: "#2026" },
          { label: "Trade fair in spring", href: "#fair" },
          { label: "Stand plan and material" },
        ]}
      />
    </div>
  ),
  document.getElementById("root")!,
);
