import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "public-site",
  name: "Lindenhof Bakery",
  icon: "ti ti-world",
  description: "The bakery's public website on its own domain.",
  basePath: "/app/public-site",
  // The operator supplies this service name on the Cloud private network.
  baseUrl: "http://public-site:3000",
  routes: ["/app/public-site"],
  public: true,
});
export const { plugin } = app;
