# Template: dashboard page

Dashboard page of a mailbox's Code: open work by status and the conversations that need action. The page reads live data on each request and changes nothing. Pages of resource Code open for every signed-in person, so it shows mailbox data only to members of one group. `follow` reloads it after new mail once the event service delivers to open pages; until then it reloads when its tab becomes visible again.

Owner: the Code of a mailbox. Copy it into `code.tsx`, replace the fictional IDs and names, then check, test and submit as usual.

<!-- check: resource mail.mailbox -->
```tsx
import { app, Chart, Column, jsx, Notice, owner, Page, Section, Stat, Stats, Table } from "@sdk";

// Fictional ID of the group that may see this mailbox's data.
const TEAM = "00000000-0000-4000-8000-0000000000aa";

const LIMIT = 50;
const count = (items: readonly unknown[], hasMore: boolean) => (hasMore ? `${items.length}+` : items.length);

app.get("/", async c => {
  if (!c.user?.groups.includes(TEAM))
    return c.page(<Page title="Mailbox overview"><Notice tone="warning" title="Only for the mailbox team" /></Page>);
  const [{ data: needsAction, page: needsActionPage }, { data: waiting, page: waitingPage }, { data: unassigned, page: unassignedPage }] = [
    await owner.conversation.list({ view: "needs_action", limit: LIMIT }),
    await owner.conversation.list({ view: "waiting", limit: LIMIT }),
    await owner.conversation.list({ view: "unassigned", limit: LIMIT }),
  ];
  const withAttachments = needsAction.filter(item => item.hasAttachments).length;
  const rows = needsAction.slice(0, 20).map(item => ({
    subject: item.title,
    people: item.participants,
    messages: item.messageCount,
    unread: item.unread ? "Unread" : "",
  }));
  const open = needsAction.length + waiting.length;

  return c.page(
    <Page title="Mailbox overview" subtitle="Open work right now" icon="ti ti-inbox" color="blue" follow={["mail.message.received"]}>
      <Stats>
        <Stat label="Needs action" value={count(needsAction, needsActionPage?.hasMore ?? false)} />
        <Stat label="Waiting" value={count(waiting, waitingPage?.hasMore ?? false)} />
        <Stat label="Unassigned" value={count(unassigned, unassignedPage?.hasMore ?? false)} />
      </Stats>
      <Section title="Open work" icon="ti ti-list-check" color="blue">
        {open > 0 ? (
          <Chart.Bar
            width="third"
            title="By status"
            data={[
              { label: "Needs action", value: needsAction.length },
              { label: "Waiting", value: waiting.length },
            ]}
          />
        ) : (
          <Chart.Empty width="third" title="By status" empty="No open conversations." />
        )}
        {needsAction.length > 0 ? (
          <Chart.Pie
            width="third"
            title="Attachments"
            data={[
              { label: "With attachments", value: withAttachments },
              { label: "Without", value: needsAction.length - withAttachments },
            ]}
          />
        ) : (
          <Chart.Empty width="third" title="Attachments" empty="Nothing needs action." />
        )}
        <Table title="Needs action" rows={rows} empty="Nothing needs action.">
          <Column key="subject" label="Subject" />
          <Column key="people" label="People" />
          <Column key="messages" label="Messages" />
          <Column key="unread" label="Unread" />
        </Table>
      </Section>
    </Page>,
  );
});

export default app;
```
