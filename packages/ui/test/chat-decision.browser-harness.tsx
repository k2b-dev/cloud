import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Button, Chat, type ChatDecisionState, type ChatOutcomeLine, ReferenceChip } from "../src/index";

export const fullTitle = `${"Quarterly".repeat(8)}.pdf`;
export const runningSentence = "Sending the mail to Lea.";
export const doneSentence = "Sent the mail to Lea.";
// Long enough to wrap where the running line does not: only a shared cell keeps what follows in place.
export const doneDetail =
  "Mail took it over for sending and delivers it to every recipient listed above, including the copy for Tom, within the next few minutes.";

declare global {
  interface Window {
    __finish: () => void;
    __expire: () => void;
    __check: () => void;
    __fail: () => void;
    __mark: () => void;
    __errors: string[];
  }
}

function Fixture() {
  const [state, setState] = createSignal<ChatDecisionState>("open");
  const [current, setCurrent] = createSignal("running");
  window.__finish = () => {
    setCurrent("done");
    setState("decided");
  };
  const [mark, setMark] = createSignal<"added" | undefined>();
  // A retained element: marking its line later must not move it out of the page.
  const retained = <b id="retained">Retained words</b>;
  window.__errors = [];
  window.__mark = () => setMark("added");
  window.__check = () => setCurrent("checkfail");
  window.__fail = () => {
    setCurrent("failed");
    setState("decided");
  };
  window.__expire = () => {
    setCurrent("expired");
    setState("expired");
  };
  const lines: Record<string, ChatOutcomeLine> = {
    running: { tone: "running", text: runningSentence },
    done: { tone: "done", text: doneSentence, detail: doneDetail, time: "09:41" },
    declined: { tone: "off", text: "Kept the mail as a draft.", detail: "You declined." },
    checkfail: {
      tone: "warning",
      text: "Still checking whether the mail went out.",
      actions: (
        <>
          <Button size="sm" variant="subtle">
            Open the draft
          </Button>
          <Button size="sm" variant="subtle">
            Check again
          </Button>
        </>
      ),
    },
    failed: {
      tone: "error",
      text: "The mail was not sent.",
      action: {
        label: "Send again",
        onSelect: async () => {
          throw new Error("offline");
        },
      },
    },
    expired: {
      tone: "off",
      text: "This question expired.",
      icon: "ti ti-clock-x",
      action: {
        label: "Ask again",
        onSelect: () => {
          setState("open");
        },
      },
    },
  };
  return (
    <main>
      <Chat.Decision
        state={state()}
        sentence={
          <>
            Send <ReferenceChip kind="object" title={fullTitle} icon="ti ti-file-type-pdf" href="#file" accent="var(--k2b-reference-pdf)" />{" "}
            to <ReferenceChip kind="person" name="Lea Berg" href="#lea" />?
          </>
        }
        reason={{ text: "You asked to check the draft before sending.", icon: "ti ti-info-circle" }}
        preview={
          <Chat.Preview>
            <Chat.Preview.Header
              rows={[
                { label: "From", people: [{ name: "Robin Example", address: `${"long.sender.".repeat(9)}@example.test` }] },
                { label: "To", people: [{ name: "Lea Berg", address: `${"long.recipient.".repeat(9)}@example.test` }] },
                { label: "Cc", people: [{ address: "team@example.test" }] },
                { label: "Bcc", emphasis: true, people: [{ name: "Tom Weber", address: "tom@example.test" }] },
              ]}
              note="Sends immediately after your answer."
            />
            <Chat.Preview.Title meta="Draft · version 3">Workshop delivery</Chat.Preview.Title>
            <Chat.Preview.Excerpt>
              {"Hello Lea,\nThe delivery is ready for Friday.\nPlease find the full report attached.\nThank you for checking the details."}
            </Chat.Preview.Excerpt>
            <Chat.Preview.Line icon="ti ti-file-type-pdf" accent="var(--k2b-reference-pdf)" meta="PDF · 240 KB">
              Delivery report.pdf
            </Chat.Preview.Line>
            <Chat.Preview.Line icon="ti ti-alert-triangle" tone="warning">
              The draft contains outside content.
            </Chat.Preview.Line>
            <Chat.Preview.ReadMore href="#draft" title="Open this version of the draft">
              Read full draft
            </Chat.Preview.ReadMore>
            <Chat.Preview.Lines label="Consequences">
              <Chat.Preview.Line icon="ti ti-send" mark="added">
                Lea receives the report.
              </Chat.Preview.Line>
              <Chat.Preview.Line icon="ti ti-x" mark="removed" tone="muted">
                The previous attachment is removed.
              </Chat.Preview.Line>
            </Chat.Preview.Lines>
          </Chat.Preview>
        }
        confirm={{
          label: "Send to Lea",
          icon: "ti ti-send",
          onSelect: () => {
            setCurrent("running");
            setState("sending");
          },
        }}
        decline={{
          label: "Keep draft",
          onSelect: () => {
            setCurrent("declined");
            setState("decided");
          },
        }}
        outcome={<Chat.Outcome lines={lines} current={current()} onActionError={(error) => window.__errors.push(String(error))} />}
      />
      <Chat.Preview>
        <Chat.Preview.Line icon="ti ti-pencil" mark={mark()}>
          {retained}
        </Chat.Preview.Line>
      </Chat.Preview>
      <p id="sentinel">The next conversation paragraph stays in place.</p>
      <Chat.Activity label="Checked the draft" icon="ti ti-alert-triangle" tone="warning" />
    </main>
  );
}
render(() => <Fixture />, document.getElementById("root")!);
