import { initializePlatform, startPlatform } from "@k2b/cloud/start";

export const loadInventory = () =>
  startPlatform({
    appId: "inventory",
    load: () => import("./build-app"),
  });

export const initializeInventoryWorker = () => initializePlatform({ appId: "inventory", source: "env" });
