import type { CloudCliModule } from "@k2b/cloud/cli";
import { createEchoPlugin } from "./echo-plugin/src/cli";

declare const ECHO_CONFIG: Pick<CloudCliModule, "name" | "alias" | "shortcuts">;

export default createEchoPlugin(ECHO_CONFIG);
