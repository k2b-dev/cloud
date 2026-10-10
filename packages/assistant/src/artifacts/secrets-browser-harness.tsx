import { Button } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { browserHttpHost, openSecretsDialog } from "./SecretsDialog";

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
      <Button onClick={async () => setResult(JSON.stringify(await openSecretsDialog({ resourceId: "Ab3dEf" })))}>
        Manage app approvals
      </Button>
      <Button
        onClick={async () => {
          // The order runHttp uses: a remembered website approval first, then the request dialog.
          const request = {
            type: "http" as const,
            name: "http.fetch:https://query1.finance.yahoo.com",
            id: crypto.randomUUID(),
            url: "https://query1.finance.yahoo.com/v7/finance/quote?symbols=NVDA,AAPL",
            method: "GET",
            headers: {},
            bodyBytes: 0,
            bodyPreview: "",
            bodyTruncated: false,
            resourceTitle: "Quotes",
          };
          const signal = new AbortController().signal;
          setResult("");
          const allowed = await browserHttpHost.allowed!(request, signal);
          setResult(`website:${allowed ? "allowed" : String(await browserHttpHost.approve(request, signal))}`);
        }}
      >
        Fetch quotes
      </Button>
      <output>{result()}</output>
    </>
  );
}
render(() => <Harness />, document.getElementById("root")!);
