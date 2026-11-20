### Send without recipients said nothing where the address belongs

- **What happened:** A reply draft without recipients (one an automation created with `to: []`) did not go out on
  Send, and the person saw no clear reason at the field that needed it. At best a generic "Not sent" toast offered to try
  the same send again.
- **Root cause:** The composer treated a missing recipient like a failed delivery: `validateDelivery`
  (`MailComposer.tsx`) threw a plain error that ended in the send-failure toast, far from the To field and with a retry
  that could not help.
- **Error class:** A validation failure reported as a delivery failure, away from the field that fixes it.
- **Guard:** The To field is the required recipient field: Send without anybody addressed marks it, shows the reason
  inside it and moves the caret there; a server refusal while nobody is addressed does the same. Behavior tests cover
  the window (normal and large), the reply box in English and German, and a server refusal that stays visible.
