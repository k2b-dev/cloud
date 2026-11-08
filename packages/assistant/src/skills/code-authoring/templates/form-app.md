# Template: form app

Form app in personal Code: a request form that creates a task in one Space, validates on the server, confirms on a page and lists the latest requests. Personal routes open only for the owner. Creating a task is a silent Action visible to others: by default a Cloud administrator approves the version.

Owner: personal Code. Copy it into `code.tsx`, replace the fictional IDs and names, then check, test and submit as usual.

<!-- check: personal -->
```tsx
import { app, Column, Field, Form, jsx, Link, Notice, Option, Page, spaces, Table } from "@sdk";

// Fictional Space ID; read the real one with spaces.space.list and keep it as a constant.
const SPACE_ID = "Spc001";
const space = spaces.space(SPACE_ID);
const PRIORITIES = ["low", "medium", "high"] as const;
type Priority = (typeof PRIORITIES)[number];
type Values = { title: string; details: string; priority: string; due: string };
type Errors = Partial<Record<keyof Values, string>>;
// Leave optional props out instead of passing undefined.
const issue = (message?: string) => (message ? { error: message } : {});

const requestForm = (values: Values, errors: Errors = {}) => (
  <Form width="half" title="New request" action="/request" submit="Send request">
    <Field.Text name="title" label="What do you need?" value={values.title} {...issue(errors.title)} required />
    <Field.Textarea name="details" label="Details" value={values.details} {...issue(errors.details)} />
    <Field.Select name="priority" label="Priority" value={values.priority} {...issue(errors.priority)}>
      {PRIORITIES.map(priority => <Option value={priority} label={priority[0]!.toUpperCase() + priority.slice(1)} />)}
    </Field.Select>
    <Field.Text name="due" label="Due date (YYYY-MM-DD)" value={values.due} {...issue(errors.due)} />
  </Form>
);

const page = async (values: Values, errors: Errors = {}, created?: string) => {
  const { data: recent } = await spaces.app().task.list({ spaceId: SPACE_ID, status: "active", sort: "created", sortDesc: true, limit: 10 });
  return (
    <Page title="Requests" subtitle="Creates a task in the team Space" icon="ti ti-clipboard-list" color="blue">
      {created ? <Notice tone="success" title="Request sent" text={`Task “${created}” was created.`} /> : null}
      {requestForm(values, errors)}
      <Table width="half" title="Latest requests" rows={recent.map(task => ({ title: task.title, created: task.createdAt.slice(0, 10) }))} empty="No open requests.">
        <Column key="title" label="Request" />
        <Column key="created" label="Created" />
      </Table>
      <Link label="Start a new request" href="/" />
    </Page>
  );
};

const empty: Values = { title: "", details: "", priority: "medium", due: "" };

app.get("/", async c => c.page(await page(empty)));

app.post("/request", async c => {
  const form = await c.req.formData();
  const values: Values = {
    title: String(form.get("title") ?? "").trim(),
    details: String(form.get("details") ?? "").trim(),
    priority: String(form.get("priority") ?? "medium"),
    due: String(form.get("due") ?? "").trim(),
  };
  const errors: Errors = {};
  if (values.title.length < 3 || values.title.length > 200) errors.title = "Enter 3 to 200 characters.";
  if (values.details.length > 2000) errors.details = "Keep the details under 2,000 characters.";
  if (!PRIORITIES.includes(values.priority as Priority)) errors.priority = "Choose a priority.";
  // Date.parse accepts 2026-02-31; a real calendar date survives the round trip.
  const realDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
  if (values.due && !realDate(values.due)) errors.due = "Use a real date such as 2026-12-01.";
  if (Object.keys(errors).length) return c.page(await page(values, errors));

  // The key covers the complete request: sending the same form again after a lost answer creates one task,
  // while any other input is a different request.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values)));
  const key = `request:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
  const task = await space.task.create({
    title: values.title,
    ...(values.details ? { description: values.details } : {}),
    priority: values.priority as Priority,
    ...(values.due ? { deadline: values.due } : {}),
    idempotencyKey: key,
  });
  return c.page(await page(empty, {}, task.title));
});

export default app;
```
