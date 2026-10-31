import { Hono } from "hono";
import { app } from "./config";
import "./site";

// The Cloud-host part only points administrators to the site; the website itself is app.public.
const cloud = new Hono().get("/app/public-site", (c) =>
  c.text("The bakery website runs on the domains assigned under Administration › Apps."),
);

export default await app.start({ fetch: cloud.fetch });
