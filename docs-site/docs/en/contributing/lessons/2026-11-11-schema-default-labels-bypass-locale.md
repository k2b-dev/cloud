### Schema defaults put English labels into a German chat

- **What happened:** In a German chat, Gustav's text editor showed "Continue" and "Suggest changes", the survey button "Submit", and a survey text answer could lose its accessible name.
- **Root cause:** The tool input schemas defaulted `submitLabel` to English text, so the client's translated fallback never ran; other texts were literals in the component; survey labels were joined by an ID built from the model's answer key, which may hold spaces or repeat.
- **Error class:** A presentation default resolved before the reader's locale is known, and a DOM ID derived from model-controlled data.
- **Guard:** `packages/cloud/src/ai/chat/blocks.render.test.tsx` renders the editor from schema-parsed arguments in German and checks unique, resolvable `aria-labelledby` targets for repeated and spaced answer keys; `packages/cloud/src/ai/tools.test.ts` checks the contract injects no label.
