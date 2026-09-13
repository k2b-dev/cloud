import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { Button } from "@k2b/ui";
import { openSecretsDialog, browserHttpHost } from "./SecretsDialog";
function Harness() {
  const [result, setResult] = createSignal("");
  return (
    <>
      <Button
        onClick={async () => setResult(JSON.stringify(await openSecretsDialog({ resourceId: "00000000-0000-4000-8000-000000000001" })))}
      >
        Manage secrets
      </Button>
      <Button
        onClick={async () =>
          setResult(
            JSON.stringify(
              await openSecretsDialog(
                { conversationId: "chat" },
                { name: "crm", origin: "https://api.example.com", header: "authorization", prefix: "Bearer " },
              ),
            ),
          )
        }
      >
        Request secret
      </Button>
      <Button
        onClick={async () =>
          setResult(
            String(
              await browserHttpHost.approve(
                {
                  type: "http",
                  name: "http.fetch:https://api.example.com",
                  id: crypto.randomUUID(),
                  url: "https://api.example.com/customers",
                  method: "POST",
                  headers: { authorization: { secret: "crm", prefix: "Bearer " } },
                  bodyBytes: 2,
                  bodyPreview: "{}",
                  bodyTruncated: false,
                },
                new AbortController().signal,
              ),
            ),
          )
        }
      >
        Request HTTP
      </Button>
      <output>{result()}</output>
    </>
  );
}
render(() => <Harness />, document.getElementById("root")!);
