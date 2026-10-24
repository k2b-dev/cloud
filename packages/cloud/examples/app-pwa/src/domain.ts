import { type AppPwaCommandContext, AppPwaError, type AppPwaVisitContext, appPwaCommand, appPwaQuery } from "@k2b/cloud/app-pwa";
import { parseSignature } from "@k2b/ui";
import { type SQL, sql } from "bun";
import { z } from "zod";
import { MAX_SIGNATURE_BYTES, SUBJECT_ID } from "./constants";
import { VisitViewSchema } from "./model";

export const SubjectSchema = z.strictObject({ customerId: z.uuid() });
const signatureSchema = z.unknown().transform((value, ctx) => {
  const serialized = JSON.stringify(value);
  if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_SIGNATURE_BYTES) {
    ctx.addIssue({ code: "custom", message: "Signature exceeds example budget" });
    return z.NEVER;
  }
  const signature = parseSignature(value);
  if (!signature) {
    ctx.addIssue({ code: "custom", message: "Invalid signature" });
    return z.NEVER;
  }
  return signature;
});
export const SignSchema = z.strictObject({
  documentId: z.enum(["contract", "receipt"]),
  revision: z.number().int().positive(),
  signature: signatureSchema,
  consent: z.literal(true),
});
const ResultSchema = z.strictObject({ completed: z.boolean() });
type DocumentRow = { id: "contract" | "receipt"; revision: number; title: string; paragraphs: string[]; signed: boolean };

/** App-owned durable data. Setup runs inside Cloud's exclusive lifecycle setup. */
export async function setupDomain(db: SQL = sql) {
  await db.begin(async (tx) => {
    await tx`CREATE SCHEMA IF NOT EXISTS visit_demo`;
    await tx`CREATE TABLE IF NOT EXISTS visit_demo.customers (id uuid PRIMARY KEY, name text NOT NULL)`;
    await tx`CREATE TABLE IF NOT EXISTS visit_demo.payments (customer_id uuid PRIMARY KEY REFERENCES visit_demo.customers(id), amount_cents integer NOT NULL CHECK(amount_cents = 45000), state text NOT NULL CHECK(state IN ('pending','paid')))`;
    await tx`CREATE TABLE IF NOT EXISTS visit_demo.document_revisions (customer_id uuid NOT NULL REFERENCES visit_demo.customers(id), id text NOT NULL CHECK(id IN ('contract','receipt')), revision integer NOT NULL CHECK(revision > 0), title text NOT NULL, paragraphs jsonb NOT NULL, PRIMARY KEY(customer_id,id,revision))`;
    await tx`CREATE TABLE IF NOT EXISTS visit_demo.documents (customer_id uuid NOT NULL REFERENCES visit_demo.customers(id), id text NOT NULL, revision integer NOT NULL, PRIMARY KEY(customer_id,id), FOREIGN KEY(customer_id,id,revision) REFERENCES visit_demo.document_revisions(customer_id,id,revision))`;
    await tx`CREATE TABLE IF NOT EXISTS visit_demo.signatures (visit_id uuid NOT NULL, customer_id uuid NOT NULL REFERENCES visit_demo.customers(id), document_id text NOT NULL, revision integer NOT NULL, signature jsonb NOT NULL, signed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(visit_id,document_id,revision), FOREIGN KEY(customer_id,document_id,revision) REFERENCES visit_demo.document_revisions(customer_id,id,revision))`;
    await tx`INSERT INTO visit_demo.customers VALUES (${SUBJECT_ID}::uuid,'Lea Muster') ON CONFLICT DO NOTHING`;
    // This is a fictional payment recorded as paid, never a real payment operation.
    await tx`INSERT INTO visit_demo.payments VALUES (${SUBJECT_ID}::uuid,45000,'paid') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO visit_demo.document_revisions VALUES (${SUBJECT_ID}::uuid,'contract',1,'Ankaufsvertrag',${JSON.stringify([
      "Objekt: Kommode, Nussbaum, um 1920. Vereinbarter Ankaufspreis: 450,00 €.",
      "Lea Muster verkauft das beschriebene Objekt an den Beispielbetrieb. Dieser verkürzte Mustertext ist kein verwendbarer Vertrag.",
      "Ausschließlich Beispieldaten. Die Unterschrift beweist keine Identität und ist keine qualifizierte elektronische Signatur.",
    ])}::text::jsonb), (${SUBJECT_ID}::uuid,'receipt',1,'Auszahlungsquittung',${JSON.stringify([
      "Lea Muster bestätigt den Empfang von 450,00 € für den Ankauf der Kommode.",
      "Ausschließlich Beispieldaten. Die Beispielzahlung ist bereits als ausgezahlt vermerkt; diese App führt keine Zahlung aus.",
    ])}::text::jsonb) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO visit_demo.documents VALUES (${SUBJECT_ID}::uuid,'contract',1), (${SUBJECT_ID}::uuid,'receipt',1) ON CONFLICT DO NOTHING`;
  });
}

const customerId = (context: AppPwaVisitContext) => SubjectSchema.parse(context.actor.subject).customerId;
export async function readVisit(context: AppPwaVisitContext) {
  const { tx, actor } = context;
  const id = customerId(context);
  const [customer] = await tx<{ name: string }[]>`SELECT name FROM visit_demo.customers WHERE id = ${id}::uuid`;
  if (!customer) throw new AppPwaError("NOT_FOUND", 404);
  const rows = await tx<DocumentRow[]>`SELECT d.id,d.revision,r.title,r.paragraphs,
    EXISTS(SELECT 1 FROM visit_demo.signatures s WHERE s.visit_id = ${actor.visitId}::uuid AND s.customer_id = d.customer_id AND s.document_id = d.id AND s.revision = d.revision) AS signed
    FROM visit_demo.documents d JOIN visit_demo.document_revisions r ON r.customer_id = d.customer_id AND r.id = d.id AND r.revision = d.revision WHERE d.customer_id = ${id}::uuid
    AND (d.id = 'contract' OR EXISTS(SELECT 1 FROM visit_demo.payments p WHERE p.customer_id = d.customer_id AND p.state = 'paid')) ORDER BY d.id`;
  return VisitViewSchema.parse({
    id: actor.visitId,
    customerName: customer.name,
    documents: rows.map((row) => ({ ...row, ...(row.id === "receipt" ? { receiptAmount: "450,00 €" } : {}) })),
  });
}

export async function signDocument(context: AppPwaCommandContext, input: z.output<typeof SignSchema>, expected: "contract" | "receipt") {
  const { tx, actor } = context;
  if (input.documentId !== expected) throw new AppPwaError("INVALID_INPUT", 400);
  const id = customerId(context);
  // Authority is already locked by the platform. Domain lock order is customer,
  // payment, documents, signatures. All reads and writes share the supplied tx.
  const [customer] = await tx`SELECT id FROM visit_demo.customers WHERE id = ${id}::uuid FOR UPDATE`;
  if (!customer) throw new AppPwaError("NOT_FOUND", 404);
  const [payment] = await tx<{ state: string }[]>`SELECT state FROM visit_demo.payments WHERE customer_id = ${id}::uuid FOR SHARE`;
  const documents = await tx<
    { id: string; revision: number }[]
  >`SELECT id,revision FROM visit_demo.documents WHERE customer_id = ${id}::uuid ORDER BY id FOR SHARE`;
  const document = documents.find((row) => row.id === expected);
  if (!document) throw new AppPwaError("NOT_FOUND", 404);
  if (document.revision !== input.revision) throw new AppPwaError("APP_REVISION_CONFLICT", 409);
  const signatures = await tx<
    { document_id: string; revision: number }[]
  >`SELECT document_id,revision FROM visit_demo.signatures WHERE visit_id = ${actor.visitId}::uuid`;
  const signed = (documentId: string) =>
    signatures.some((s) => s.document_id === documentId && documents.some((d) => d.id === documentId && d.revision === s.revision));
  if (signed(expected)) throw new AppPwaError("APP_REVISION_CONFLICT", 409);
  if (expected === "receipt" && (payment?.state !== "paid" || !signed("contract"))) throw new AppPwaError("FORBIDDEN", 403);
  await tx`INSERT INTO visit_demo.signatures(visit_id,customer_id,document_id,revision,signature) VALUES (${actor.visitId}::uuid,${id}::uuid,${expected},${input.revision},${JSON.stringify(input.signature)}::text::jsonb)`;
  const completed = expected === "receipt" || payment?.state !== "paid";
  if (completed) context.endVisit();
  // Only non-sensitive state is stored with the platform attempt.
  return { completed };
}
export const queries = { document: appPwaQuery({ input: z.strictObject({}), output: VisitViewSchema, handler: readVisit }) };
export const commands = {
  "sign-contract": appPwaCommand({
    input: SignSchema,
    output: ResultSchema,
    handler: (context, input) => signDocument(context, input, "contract"),
  }),
  "sign-receipt": appPwaCommand({
    input: SignSchema,
    output: ResultSchema,
    handler: (context, input) => signDocument(context, input, "receipt"),
  }),
};
