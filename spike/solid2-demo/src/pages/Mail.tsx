import { For, Show } from "solid-js";
import {
  Avatar,
  Button,
  Chip,
  Column,
  Facts,
  Head,
  Icon,
  List,
  NavItem,
  Notice,
  Row,
  RowLine,
  Scroll,
  Section,
  Shell,
  SideLabel,
  Sidebar,
  StatusRow,
  Tabs,
} from "@k2b/ui/v2";
import { ssr } from "../config";
import { contacts, folders, type Mail, mails } from "../data";
import MailMenu from "../islands/MailMenu.island";
import NewMessage from "../islands/NewMessage.island";
import ShellBehaviour from "../islands/ShellBehaviour.client";

type View = { folder: string; filter?: string; id?: string };

const href = (view: View) => {
  const params = new URLSearchParams();
  if (view.folder !== "inbox") params.set("folder", view.folder);
  if (view.filter) params.set("filter", view.filter);
  if (view.id) params.set("id", view.id);
  const query = params.toString();
  return `/mail${query ? `?${query}` : ""}`;
};

function MailRow(props: { mail: Mail; view: View }) {
  return (
    <Row href={href({ ...props.view, id: props.mail.id })} current={props.view.id === props.mail.id} lines={3}>
      <RowLine>
        <span class="k2-fill k2-cut" data-unread={props.mail.unread ? "" : undefined}>
          <Show when={props.mail.unread} fallback={props.mail.from}>
            <b class="k2-strong">{props.mail.from}</b>
          </Show>
        </span>
        <Show when={props.mail.unread}>
          <span class="k2-sr">ungelesen</span>
        </Show>
        <span class="k2-meta k2-num">{props.mail.time}</span>
      </RowLine>
      <RowLine>
        <span class="k2-fill k2-cut">{props.mail.subject}</span>
        <Show when={props.mail.attachments}>
          <Icon name="clip" label="mit Anhang" />
        </Show>
      </RowLine>
      <RowLine meta>
        <span class="k2-fill k2-cut">{props.mail.preview}</span>
        <Show when={props.mail.tag}>{(tag) => <span data-tone={tag().tone} class="k2-tag">{tag().label}</span>}</Show>
      </RowLine>
    </Row>
  );
}

function Detail(props: { mail: Mail; view: View }) {
  const closeHref = () => href({ ...props.view, id: undefined });
  return (
    <Column region="detail" label="Nachricht">
      <Head
        edge="end"
        actions={
          <>
            <MailMenu subject={props.mail.subject} />
            <span class="k2-desk-only">
              <Button href={closeHref()} variant="ghost" icon="x" label="Schließen" />
            </span>
          </>
        }
      >
        <span class="k2-phone-only">
          <Button href={closeHref()} variant="ghost" icon="back" label="Zurück zur Liste" />
        </span>
        <h2 class="k2-head__title">{props.mail.subject}</h2>
      </Head>
      <Scroll label="Nachricht">
        <Show when={props.mail.problem}>
          {(problem) => (
            <Notice tone="bad" title={problem().title} text={problem().text} action={<Button href="#adresse">Adresse prüfen</Button>} />
          )}
        </Show>
        <Section title="Nachricht" action={<Button size="sm" variant="ghost" icon="reply">Antworten</Button>}>
          <div class="demo-sender">
            <Avatar name={props.mail.from} color={props.mail.color} size="lg" />
            <div class="k2-fill">
              <div class="k2-cut">
                <b class="k2-strong">{props.mail.from}</b>
              </div>
              <div class="k2-meta k2-cut">
                {props.mail.address} · {props.mail.date}
              </div>
            </div>
          </div>
          <div class="demo-body k2-body">
            <For each={props.mail.body}>{(paragraph) => <p>{paragraph}</p>}</For>
          </div>
        </Section>
        <Show when={props.mail.attachments}>
          {(files) => (
            <Section title="Anhänge" count={files().length} flush>
              <List label="Anhänge">
                <For each={files()}>
                  {(file) => (
                    <Row lead={<Icon name="draft" />} end={<span class="k2-meta k2-num">{file.size}</span>}>
                      <span class="k2-cut">{file.name}</span>
                    </Row>
                  )}
                </For>
              </List>
            </Section>
          )}
        </Show>
        <Section title="Details">
          <Facts
            items={[
              ["Von", props.mail.address],
              ["An", "kontakt@solberg-kramer.example"],
              ["Empfangen", props.mail.date],
              ["Ordner", folders.find((folder) => folder.id === props.mail.folder)?.label ?? ""],
              ["Schlagwort", props.mail.tag ? <Chip tone={props.mail.tag.tone}>{props.mail.tag.label}</Chip> : "–"],
            ]}
          />
        </Section>
      </Scroll>
    </Column>
  );
}

export default ssr(async (c) => {
  const view: View = {
    folder: c.req.query("folder") ?? "inbox",
    filter: c.req.query("filter") ?? undefined,
    id: c.req.query("id") ?? undefined,
  };
  const folder = folders.find((entry) => entry.id === view.folder) ?? folders[0];
  const inFolder = mails.filter((mail) => mail.folder === folder.id);
  const shown = inFolder.filter((mail) => (view.filter === "unread" ? mail.unread : view.filter === "files" ? mail.attachments : true));
  const selected = mails.find((mail) => mail.id === view.id);
  const unread = inFolder.filter((mail) => mail.unread).length;
  c.get("page").title = selected ? `${selected.subject} – Mail` : `${folder.label} – Mail`;
  return () => (
    <Shell detail={Boolean(selected)}>
      <ShellBehaviour />
      <Sidebar title="Mail" icon="mail">
        <SideLabel>Postfächer</SideLabel>
        <For each={folders}>
          {(entry) => (
            <NavItem href={href({ folder: entry.id })} icon={entry.icon} current={entry.id === folder.id} count={"count" in entry ? entry.count : undefined}>
              {entry.label}
            </NavItem>
          )}
        </For>
      </Sidebar>
      <Column region="main" label={folder.label}>
        <Head
          actions={<NewMessage contacts={contacts} />}
        >
          <span class="k2-phone-only k2-head__title">{folder.label}</span>
          <Tabs
            label="Ansichten"
            items={[
              { href: href({ folder: folder.id }), label: "Alle", count: inFolder.length, current: !view.filter },
              { href: href({ folder: folder.id, filter: "unread" }), label: "Ungelesen", count: unread, current: view.filter === "unread" },
              {
                href: href({ folder: folder.id, filter: "files" }),
                label: "Mit Anhang",
                count: inFolder.filter((mail) => mail.attachments).length,
                current: view.filter === "files",
              },
            ]}
          />
        </Head>
        <StatusRow
          lead={`${unread} ungelesen`}
          facts={[
            <>
              Heute <b>12</b> erledigt
            </>,
            <>5 davon automatisch</>,
          ]}
        />
        <Scroll label={folder.label}>
          <Show when={folder.id === "inbox"}>
            <Notice
              tone="warn"
              title="Postfach Rechnungen ist abgemeldet"
              text="Seit 08:12 kommen dort keine neuen Nachrichten an."
              action={<Button href="#anmelden">Neu anmelden</Button>}
            />
          </Show>
          <List label="Nachrichten">
            <For each={shown}>{(mail) => <MailRow mail={mail} view={view} />}</For>
          </List>
        </Scroll>
      </Column>
      <Show when={selected}>{(mail) => <Detail mail={mail()} view={view} />}</Show>
    </Shell>
  );
});
