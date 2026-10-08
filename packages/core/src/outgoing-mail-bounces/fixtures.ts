// IMAP BODYSTRUCTURE and the two partial BODY.PEEK responses for a standard report.
export const structure = {
  type: "multipart/report",
  parameters: { "report-type": "delivery-status" },
  childNodes: [
    { part: "1", type: "text/plain" },
    { part: "2", type: "message/delivery-status" },
    { part: "3", type: "message/rfc822", size: 25 * 1024 * 1024 },
  ],
};
export const headers =
  "From: Sender <sender@example.org>\r\nMessage-ID: <01234567-89ab-4def-8012-3456789abcde@example.org>\r\nSubject: Example\r\n\r\n";
export const status = [
  "Reporting-MTA: dns; mx.example.org",
  "",
  "Final-Recipient: rfc822; first@example.org",
  "Action: failed",
  "Status: 5.1.1",
  "Diagnostic-Code: smtp; 550 Unknown",
  " recipient",
  "",
  "final-recipient: rfc822; second@example.org",
  "action: failed",
  "status: 5.2.2",
  "diagnostic-code: smtp; 552 Mailbox full",
  "",
  "Final-Recipient: rfc822; later@example.org",
  "Action: delayed",
  "Status: 4.2.0",
  "",
].join("\r\n");
export const report = {
  id: "01234567-89ab-4def-8012-3456789abcde",
  messageId: "<01234567-89ab-4def-8012-3456789abcde@example.org>",
  failures: [
    { recipient: "first@example.org", reason: "5.1.1 smtp; 550 Unknown recipient" },
    { recipient: "second@example.org", reason: "5.2.2 smtp; 552 Mailbox full" },
  ],
};

/** Raw RFC 3501 BODYSTRUCTURE for the same report, including returned message metadata. */
export const wireStructure = `(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1)
("MESSAGE" "DELIVERY-STATUS" NIL NIL NIL "7BIT" ${Buffer.byteLength(status)})
("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 26214400 (NIL NIL NIL NIL NIL NIL NIL NIL NIL NIL)
("TEXT" "PLAIN" NIL NIL NIL "7BIT" 25000000 1) 1)
"REPORT" ("REPORT-TYPE" "delivery-status") NIL NIL NIL)`.replaceAll("\n", " ");
