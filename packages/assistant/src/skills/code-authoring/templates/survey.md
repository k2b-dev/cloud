# Template: survey

A public survey in personal Code: anyone with the link answers, signed in or not, on a page without the Cloud
layout. Each answer becomes a task in one Space. The same example appears in Fibel
(`/en/docs/platform/code-sdk#where-a-page-appears`); CI keeps both copies identical.

Owner: personal Code. Copy it into `code.tsx`, replace the fictional Space ID, the closing date and the questions,
then check, test and submit as usual. Public routes need the `public_routes` policy classification; by default a
Cloud administrator approves the version.

A public route has no visitor: `c.user` is `null`, also for signed-in people. The page still reads and writes with
this Code's rights, so it shows only the form and never earlier answers. Each form carries its own token in its
address: sending the same form again after a lost answer creates one task, and two people never share one.

<!-- code-survey-example -->
<!-- check: personal -->
```tsx
import { app, Field, Form, jsx, Notice, Option, Page, spaces } from "@sdk";

// Fictional Space ID; read the real one with spaces.space.list and keep it as a constant.
const SPACE_ID = "Spc001";
const space = spaces.space(SPACE_ID);
// The last day for answers (UTC).
const CLOSES = "2026-12-31";
const RATINGS = ["5", "4", "3", "2", "1"];
type Answer = { rating: string; comment: string };
const issue = (message?: string) => (message ? { error: message } : {});
const isClosed = () => new Date().toISOString().slice(0, 10) > CLOSES;

const survey = (token: string, answer: Answer, errors: Partial<Answer> = {}) => (
  <Page title="How was the workshop?" subtitle="Two questions, no sign-in needed" icon="ti ti-message-star" color="blue">
    <Form title="Your feedback" action={`/answer/${token}`} submit="Send">
      <Field.Select name="rating" label="How useful was it? (5 = very)" value={answer.rating} {...issue(errors.rating)} required>
        {RATINGS.map(rating => <Option value={rating} label={rating} />)}
      </Field.Select>
      <Field.Textarea name="comment" label="What should we change?" value={answer.comment} {...issue(errors.comment)} />
    </Form>
  </Page>
);
const closed = (
  <Page title="How was the workshop?" icon="ti ti-message-star" color="blue">
    <Notice tone="info" title="The survey has closed" text="Thank you for your interest." />
  </Page>
);

// Public, without the Cloud layout: the page stands alone, like a form you hand out.
app.get("/", c => c.page(isClosed() ? closed : survey(crypto.randomUUID(), { rating: "", comment: "" })), {
  public: true,
  layout: "plain",
});

app.post("/answer/:token", async c => {
  // The check: answers count only while the survey is open.
  if (isClosed()) return c.page(closed);
  // A changed address starts a new form.
  const token = /^[0-9a-f-]{36}$/.test(c.req.param("token")) ? c.req.param("token") : crypto.randomUUID();
  const form = await c.req.formData();
  const answer: Answer = { rating: String(form.get("rating") ?? ""), comment: String(form.get("comment") ?? "").trim() };
  const errors: Partial<Answer> = {};
  if (!RATINGS.includes(answer.rating)) errors.rating = "Choose a rating.";
  if (answer.comment.length > 1000) errors.comment = "Keep it under 1,000 characters.";
  if (Object.keys(errors).length) return c.page(survey(token, answer, errors));
  await space.task.create({
    title: `Workshop feedback: ${answer.rating} of 5`,
    ...(answer.comment ? { description: answer.comment } : {}),
    idempotencyKey: `survey:${token}`,
  });
  return c.page(
    <Page title="Thank you" icon="ti ti-message-star" color="blue">
      <Notice tone="success" title="Your answer arrived" text="You can close this page." />
    </Page>,
  );
}, { public: true, layout: "plain" });

export default app;
```
