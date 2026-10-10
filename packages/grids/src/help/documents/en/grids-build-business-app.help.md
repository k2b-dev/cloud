---
id: grids-build-business-app
title: Build a business app
icon: ti ti-building-store
description: Model inventory, loans, CRM, invoices, and expenses around the work people must complete.
order: 107
---
Start with one complete journey. You need **Manage** access to the Base to configure it. Templates are editable examples, not your business rules.

## Choose the records you need {icon="table"}

Every template includes workflows, document templates, and published apps. Template updates affect only new Bases. Existing Bases keep their configuration and data.

- **Bookshop:** Start from orders and add positions inside the order. The catalog and the customers have their own sections. The header shows the fulfillment status. **Next step** offers shipping, collection, or completion, as the order requires. Short forms to create and edit open in dialogs. Sending the order summary is optional and does not change the fulfillment. Review the saved sale prices before you send it. Later catalog changes do not update those prices or existing documents.
- **Personal finance:** Record income and expenses, check transactions against your bank, and compare the spending of the current month with its budget. Sending a receipt is optional and does not mark a transaction as reconciled. Transfers count neither as income nor as spending. The template does not synchronize bank balances.
- **Inventory:** Borrowers select several kits and single items in one request and track their own requests. A request needs at least one kit or item. Staff explicitly enable single items for the catalog. They use a separate loan-desk app for preparation, handover, and returns. Issuing starts the physical loan. Sending the agreement is optional. Returns work from the item detail and from a scanner.
- **Billing:** Draft and issue invoices, corrections, and commission self-billing. Then record actual payments. Follow the Billing journey below.

Bookshop and Personal finance each serve one working audience. Inventory separates borrowers from staff, because they need different records and actions. Share the right app with these audiences instead of giving them raw access to the Base.

Share **Equipment loans** with borrowers. Share **Loan desk** only with the staff who look after equipment and requests. The template does not assign these audiences automatically. The requester sees the comments on a loan. Use the separate **Admin notes** field for internal notes.

| Your task | Start with | First check |
| --- | --- | --- |
| List equipment | Items and Locations; Categories if needed | Each physical item has its own stable, unique code |
| Lend equipment | Items, Loans, and Loan positions | One position links one item to one loan and records its issue and return |
| Track customers and sales | Organisations, Contacts, Opportunities, and Activities | The responsible person and the customer are clear |
| Issue invoices | Customers, Invoices, and Invoice lines | Quantity, price, tax, and customer facts match the intended invoice |
| Reimburse expenses | Claims, Claim lines, receipt files, and payment references | The claimant, the reviewed facts, and the payment evidence are distinguishable |

An inventory list needs fields, records, and views. Add loans for handovers and returns. Use generated or unique codes for business identities. Use principal fields for Cloud people and groups. Customer relations do not give access.

For merchandise management, define the scope of purchases, receipts, orders, shipments, partial returns, and stock. Displayed totals do not reserve stock. Actions that change stock must prevent concurrent over-allocation. Grids is not a ready-made ERP, accounting system, or payment integration.

## Build in dependency order {icon="route"}

:::steps
1. **Define decisions.** Name the actors, the prerequisites, the changes that must happen together, and the completion criteria.
2. **Create tables and fields.** Add relations after their target tables exist. Add calculations after that.
3. **Store prices and tax.** Store price and tax facts where later source changes must not alter the business record.
4. **Try records.** Include missing data, several lines, and a rejected case.
5. **Add forms and workflows.** Forms collect input. Actions enforce transitions such as issue, return, approve, and send.
6. **Protect transition fields.** Keep them out of ordinary app editing. Review **Table settings → Data integrity → Record changes** to control other write paths.
7. **Build the app.** Add a task list, record details, a create form, actions, and documents. See [Build your first Grids App](/app/grids/help/grids-build-custom-app).
8. **Check access and publish.** Review the publish preflight. Test the published journey with an account from each intended audience.
:::

**View** access to a Base shows every record. Personal views and hidden navigation do not separate audiences. For narrower access, share Grids Apps with server-enforced queries and availability rules on lists, details, forms, and actions. Test a copied opportunity URL of another customer. Do not give raw access to the Base to make a portal work.

Bind all required workflow inputs before you publish. Fixed launchers use stored bindings. `inputMode: prompt` requires App-supplied inputs, not a free-form dialog. In Inventory, the row action Add loan position binds `item` to `ROW.id` and `loan` to `RECORD.id`. So it needs no raw record picker for the Base.

## Make handovers and deliveries safe to repeat {icon="repeat"}

Create one loan position per item. Issuing checks for an approved or active loan, an eligible position, and an available item. Then it stores the allocation and starts the loan. The return must match the issue: an old loan cannot return a newly lent item. Record damage before you make items available again. Close a loan only after all its positions are finished.

Inventory supplies issue and return actions. Inspect them before you adapt them. Add positions before you approve a requested loan. Kits describe equipment. They do not enforce future reservations.

Use `atomicRecords` for bounded checks and changes that must succeed together. Separate update steps are not one transaction. Competing actions must coordinate on the same existing record. See [Workflows](/app/grids/help/grids-workflows).

Claim a ready delivery before you generate documents or send email. A retry key identifies one invocation. Independent requests still need a shared check of the business state. Complete the delivery only after all its steps finish.

:::warning Cancelling does not undo sent items
Cancellation does not undo sent email or generated documents. If a delivery is stuck, inspect the original run, the documents, and the email delivery before you retry.
:::

When a template delivery is interrupted, a person with **Manage** access to the Base reviews the original run under **Workflows**. Resolve the delivery there before you reset its status in the Base table. The app offers no blind resend action on purpose.

## Preserve invoices {icon="file-invoice"}

Generated documents keep their original snapshot and their exact files. Editing the sources does not rewrite them. A repeatable template creates another document. A template that runs once per finalized record returns the existing document. Finalizing a header does not recursively finalize related lines. Object-list positions belong to the header and freeze with it. Keep later payments in separate records.

## Start with Billing {icon="file-invoice"}

The **Billing** template provides invoices, corrections, and commission self-billing in EUR. It covers distinct German business partners with German VAT IDs and 7% or 19% VAT. Other cases need a different model or renderer.

:::steps
1. Ask a person with **Manage** access to the Base to complete **Base settings → Documents** with real company and bank details. The sample records are drafts.
2. Create an invoice. Choose or create its partner and enter the object-list positions.
3. Check the totals, the service date, and the due date before you issue.
4. Choose **Issue invoice** on the saved document page. You can keep working while Grids creates the PDF.
5. After a rendering failure, choose **Continue creation**. It keeps the same document, company details, and number.
6. Choose **Record payment received**, **Record payout**, or **Record refund** on the bill.
7. Enter the actual date and amount in the dialog and submit once.
:::

`REF-…` is an internal reference, not the invoice number. Recording a payment also locks it. The balance updates immediately. Recording a payment does not execute a bank transfer. Existing unreviewed entries still need review and confirmation. Until then, they do not affect the balance.

**Open payments** groups payments into **Overdue**, **Due today or later**, and **Overpayments to review**. Open an amount due to record a payment. An overpayment opens the original document for review. Only confirmed payments affect these lists.

Choose **Use as new invoice** on a finalized invoice to create a fresh draft with its recipient, buyer reference, and positions. Check the current partner details and prices, and choose new service and due dates. Payments, corrections, internal notes, and issued files are not copied.

Partners receive a read-only customer number such as KD-00001, unique within the Base. You find it in the partner list, the recipient selection, the partner details, and the bill details. Renaming a partner keeps the number.

### Correct and settle bills

Prepare a correction from the original invoice. For a partial correction, reduce the copied positions. Checks preserve the remaining net and VAT at each rate. Self-billing needs an agreement reference and the bank account of the recipient. Enter its positions directly, and do not settle the same obligation twice. **Discard draft** moves unfinished bills to the trash. It does not apply to issued bills. Internal notes do not appear in the PDF or XML.

A correction starts with today's document date and no due date. Review both before you issue it. Record a customer refund with **Record refund** on the original invoice, with a positive amount. Confirmation subtracts the refund from the received payments. It rejects amounts above the current overpayment, also when confirmations compete. A correction has no separate payment balance. You can discard pending payments and refunds. Confirmed ones stay immutable.

HTML invoice starters are not E-Invoices. Check the currency, tax, address, and correction scope of the installed renderer and both output artifacts. The issuer stays responsible. Validation is not a tax or legal approval. Bookshop sends order summaries. Use Billing for invoices.

## Review expenses {icon="checklist"}

For expenses, fix the signed-in claimant in the form. Do not let people choose another identity. Four-eyes finalization requires a person other than the one who requested finalization. It does not compare a separate claimant field. If someone submits for the claimant, you must still enforce that the claimant does not approve their own claim.

A review covers one exact record version. Changes to its values, relations, or files invalidate its pending request. Edits of related lines do not. Define which records and receipt versions a submission contains, and require a fresh review after changes. Header approval does not approve later line edits. [Tables & fields](/app/grids/help/grids-tables-fields) describes access and the permanent settings for history and finalization.

A Paid checkbox transfers nothing. Payment execution needs a connected system, stable references, and handling of duplicate or uncertain requests. Investigate uncertain HTTP effects in that system before you retry. Personal finance tracks transactions and receipt delivery. It does not reimburse claimants after approval.

## Verify the whole journey {icon="checklist"}

:::steps
1. Test an empty list, a normal submission, a stale edit, and missing or inaccessible record IDs.
2. Repeat the journey after a reload and through a copied detail URL.
3. Try two independent issue, send, or payment requests.
4. Inspect an interrupted operation.
5. For expenses, test self-approval by the claimant and receipts or lines that change after review.
:::

Record the results, the uncertainties, the app link, the responsible operator, and the recovery steps. A valid draft does not prove isolation, safe retries, or correct payments.

Continue with [Build your first Grids App](/app/grids/help/grids-build-custom-app), [Workflows](/app/grids/help/grids-workflows), [Documents & PDFs](/app/grids/help/grids-documents-pdfs), and [Tables & fields](/app/grids/help/grids-tables-fields).
