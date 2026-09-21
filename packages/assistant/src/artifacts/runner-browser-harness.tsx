import { render } from "solid-js/web";
import Runner from "./Runner.island";

const authorized = new URLSearchParams(location.search).has("authorized");
render(
  () => (
    <Runner
      userId={authorized ? "RunnerUser" : "public-visitor"}
      initial={{
        id: "Run001",
        title: "Public calculator",
        sourceRevision: 1,
        publishedVersion: 1,
        serverAccess: authorized,
        canManage: new URLSearchParams(location.search).has("manager"),
      }}
    />
  ),
  document.getElementById("root")!,
);
