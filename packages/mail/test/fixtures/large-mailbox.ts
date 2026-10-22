/**
 * Deterministic mailbox, with no provider I/O. At the default scale, about 70%
 * of threads have 1–3 messages; the rest draw a discrete power law k^-1.7 on
 * 4–99, plus one designated 180-message detail-limit thread. Seeded random
 * +/-1 adjustments hit the exact message count: first tail threads within
 * 4–99, then the designated thread within 150–200, then short threads within
 * 1–3. Only infeasible shapes relax those bounds: sparse shapes lower tail
 * and designated minima to 1; dense shapes put excess in the designated
 * thread. No second >100 thread is needed, even at the supported limits.
 * Inbox/Archive dominate; other folders follow a
 * Zipf distribution in a three-level tree. 5% unread, 3% flagged, 10% attachments,
 * 30% HTML-only MIME (hydration also stores its extracted plain text), 2–50 KiB.
 * Conversation starts span roughly three years, skewed recent; the sparse
 * folder stays roughly three years old. Messages advance by seeded gaps of
 * minutes to days (long threads span weeks; dense custom threads can span
 * months). Every message precedes anchor minus one day; snoozes use 2099,
 * never the execution date.
 */
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { MAIL_ATTACHMENT_EXTRACTOR_VERSION } from "../../src/service/attachment-extraction-contract";

export const anchor = "2026-10-01T00:00:00Z";
export type Parameters = { seed: number; anchor: string; messages: number; conversations: number; folders: number };
const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";

/** ASCII words keep PostgreSQL character offsets equal to the planned byte sizes. */
function createBodyCorpus(random: () => number) {
  const vocabulary = `
    about above across action active address adjust advice after again agenda agree ahead allow almost along already also always
    amount analysis annual answer anyone appear apply approval archive area arrange arrive article ask asset assign assist attach
    audit available average aware balance basic before begin below benefit better between board booking brief budget build business
    calendar call campaign cancel capacity case category central certain change chart check choose city clarify client close collect
    comment complete concern confirm connect consider contact contain context continue contract copy correct cost country course cover
    create current customer daily data date decision deliver demand department describe design detail develop device direct discuss
    document draft during early effort either enable energy enjoy enough ensure entire entry environment equipment estimate event
    every example exchange expect expense explain export extend external extra facility fact feedback field figure file final finance
    finish first flexible focus folder follow forecast format forward found framework friday future general given goal good great group
    guide handle happy health helpful history hold holiday home hope hour however human idea identify image improve include income
    increase index indicate industry inform initial input insight install instance instead interest internal introduce inventory invite
    invoice issue item join journal journey keep kind knowledge label language large last later launch learn leave legal length letter
    level light likely limit line link list local location long look lunch main maintain major manage manual market match material
    matter measure meeting member mention message method middle might minute model modern monday month morning move much name nature
    near necessary need network next nice normal note notice number objective offer office once online open operate opinion option
    order organize original other output overall owner package page paper paragraph parent part partner past payment people period
    person phone photo place plan please point policy position possible prepare present previous price primary print priority private
    process produce product progress project proposal provide public purpose quality quarter question quick range rate reach read ready
    reason receive recent record reference region regular relation release remain remind remote remove renew repair repeat reply report
    request require research reserve resolve resource respond response rest result return review right risk role room route rule run
    safe sales sample save schedule scope search second section select send senior sentence separate series service session set several
    share short should show side similar simple since single site situation size skill small social software solution soon source space
    special specific spend staff stage standard start state status step still stock store strategy structure student study subject submit
    success suggest summary summer support system table take target task team technical term test text thank thing think third thursday
    ticket time today together tomorrow topic total track training transfer travel treatment trial tuesday turn type understand unit
    update useful user usual value various version view visit volume wait wanted warehouse week welcome whether whole window within
    without word work working world write year yesterday`
    .trim()
    .split(/\s+/);
  const sentences: string[] = [];
  let bytes = 0;
  let paragraphRemaining = 3 + Math.floor(random() * 4);
  while (bytes < 256 * 1024) {
    const words = Array.from({ length: 8 + Math.floor(random() * 13) }, () => vocabulary[Math.floor(random() * vocabulary.length)]!);
    const text = words.join(" ");
    const sentence = text[0]!.toUpperCase() + text.slice(1) + (--paragraphRemaining === 0 ? ".\n\n" : ". ");
    if (paragraphRemaining === 0) paragraphRemaining = 3 + Math.floor(random() * 4);
    sentences.push(sentence);
    bytes += sentence.length;
  }
  return sentences.join("").slice(0, 256 * 1024);
}

export function planLargeMailbox(parameters: Parameters, reservedIds: Iterable<string> = []) {
  const { seed, messages: count, conversations: threads, folders: folderCount } = parameters;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 100_000 ||
    !Number.isInteger(threads) ||
    threads < 1 ||
    threads > count ||
    !Number.isInteger(folderCount) ||
    folderCount < 6 ||
    folderCount > 1000 ||
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    seed > 4294967295 ||
    !Number.isFinite(Date.parse(parameters.anchor))
  )
    throw new Error("Invalid mailbox fixture parameters");
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Short IDs are globally unique per table, including across separately seeded mailboxes.
  const used = new Set(reservedIds);
  const shortId = (): string => {
    let id: string;
    do {
      id = Array.from({ length: 6 }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    } while (used.has(id));
    used.add(id);
    return id;
  };
  const roles = ["inbox", "sent", "archive", "trash", "junk", "drafts"];
  const folders = Array.from({ length: folderCount }, (_, i) => ({
    id: shortId(),
    parent: i >= 8 ? 6 + Math.floor((i - 7) / 4) : null,
    role: roles[i] ?? "other",
    name: roles[i] ?? `Project ${i - 5}`,
    stableKey: `perf-folder-${i}`,
  }));
  // Guarantee no cycles and cap nesting at three levels.
  for (const [i, folder] of folders.entries()) {
    if (folder.parent !== null) {
      const parent = folders[folder.parent];
      if (!parent || folder.parent >= i) folder.parent = null;
      else if (parent.parent !== null && folders[parent.parent]?.parent !== null) folder.parent = 6;
    }
  }
  const shortCount = Math.min(threads - 1, Math.round(threads * 0.7));
  const tailCount = threads - shortCount - 1;
  const tail = Array.from({ length: tailCount }, (_, i) => i + 2);
  const short = Array.from({ length: threads - 1 }, (_, i) => i + 1).filter((i) => i === 1 || i > tailCount + 1);
  const powerLaw = Array.from({ length: 96 }, (_, i) => (i + 4) ** -1.7);
  const tailWeight = powerLaw.reduce((a, b) => a + b, 0);
  const sizes = Array.from({ length: threads }, (_, i) => {
    if (i === 0) return 180;
    if (i === 1 || i > tailCount + 1) return 1 + Math.floor(random() * 3);
    let draw = random() * tailWeight;
    for (const [k, weight] of powerLaw.entries()) {
      draw -= weight;
      if (draw <= 0) return k + 4;
    }
    return 99;
  });
  let remaining = count - sizes.reduce((a, b) => a + b, 0);
  const balance = (indices: number[], min: number, max: number) => {
    const direction = Math.sign(remaining);
    const eligible = indices.filter((i) => (direction > 0 ? sizes[i]! < max : sizes[i]! > min));
    while (remaining && eligible.length) {
      const slot = Math.floor(random() * eligible.length);
      const i = eligible[slot]!;
      sizes[i]! += direction;
      remaining -= direction;
      if (sizes[i] === (direction > 0 ? max : min)) {
        eligible[slot] = eligible[eligible.length - 1]!;
        eligible.pop();
      }
    }
  };
  balance(tail, 4, 99);
  balance([0], 150, 200);
  balance(short, 1, 3);
  if (remaining < 0) {
    balance(tail, 1, 99);
    balance([0], 1, 200);
  } else if (remaining > 0) balance([0], 150, count);
  const sparseFolder = folderCount > 6 ? folderCount - 1 : 4;
  const weights = folders.map((f, i) =>
    f.role === "inbox" ? 6 : f.role === "archive" ? 5 : f.role === "drafts" || i === sparseFolder ? 0 : 1 / (i + 1),
  );
  const sum = weights.reduce((a, b) => a + b, 0);
  const chooseFolder = () => {
    let n = random() * sum;
    for (let i = 0; i < weights.length; i++) {
      n -= weights[i] ?? 0;
      if (n <= 0) return i;
    }
    return 0;
  };
  const conversations = sizes.map((size, i) => ({
    id: shortId(),
    size,
    folder: i === 0 ? 0 : i === threads - 1 ? sparseFolder : i === 2 && folderCount > 7 ? 6 : chooseFolder(),
    assigned: i % 7 === 0,
    status: i % 9 === 0 ? "done" : i % 5 === 0 ? "waiting" : "needs_action",
    snoozedUntil: i % 23 === 1 && i % 9 !== 0 ? "2099-01-01T00:00:00Z" : null,
  }));
  const rareWord = "zirconiumneedle";
  const commonWord = "correspondence";
  const day = 86400_000;
  const cutoff = Date.parse(parameters.anchor) - day;
  const messages = conversations.flatMap((conversation, ci) => {
    const offsets = [0];
    for (let j = 1; j < conversation.size; j++)
      offsets.push(offsets[j - 1]! + 60_000 + Math.floor(random() ** 3 * Math.min(2 * day, (28 * day * 4) / conversation.size)));
    const duration = offsets.at(-1)!;
    const start =
      conversation.folder === sparseFolder
        ? cutoff - 1094 * day + Math.floor(random() * day)
        : cutoff - 1 - duration - Math.floor(random() ** 2 * (1094 * day - duration));
    return Array.from({ length: conversation.size }, (_, j) => {
      const id = shortId();
      const html = ci === 3 || random() < 0.29;
      const attachment = random() < 0.1;
      const date = new Date(start + offsets[j]!).toISOString();
      const unread = random() < 0.05;
      const flagged = random() < 0.03;
      return {
        id,
        conversation: conversation.id,
        folder: folders[conversation.folder]!.id,
        date,
        flags: [...(unread ? [] : ["\\Seen"]), ...(flagged ? ["\\Flagged"] : [])],
        html,
        bodyBytes: html ? 2048 + Math.floor(random() * (50 * 1024 - 2048)) : 160 + Math.floor(random() * 1800),
        attachment: attachment ? { id: shortId(), filename: `report-${id}.txt`, bytes: 1024 + Math.floor(random() * 8192) } : null,
        subject: `Project correspondence ${ci}`,
        text: `${(ci === 1 || threads === 1) && j === 0 ? rareWord : commonWord} Project update ${ci}/${j}. `,
        from:
          (ci === 1 || threads === 1) && j === 0
            ? "needle@example.test"
            : conversation.folder === 1
              ? "perf@example.test"
              : `contact${ci % 127}@example.test`,
        to: conversation.folder === 1 ? `contact${ci % 127}@example.test` : "perf@example.test",
      };
    });
  });
  const totals = Object.fromEntries(folders.map((f) => [f.id, { total: 0, unread: 0, conversations: 0 }]));
  for (const m of messages) {
    totals[m.folder]!.total++;
    if (!m.flags.includes("\\Seen")) totals[m.folder]!.unread++;
  }
  for (const c of conversations) totals[folders[c.folder]!.id]!.conversations++;
  const histogram: Record<string, number> = { "1-3": 0, "4-9": 0, "10-49": 0, "50-100": 0, ">100": 0 };
  for (const c of conversations) {
    const key = c.size <= 3 ? "1-3" : c.size <= 9 ? "4-9" : c.size <= 49 ? "10-49" : c.size <= 100 ? "50-100" : ">100";
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  const shape = {
    messages: count,
    conversations: threads,
    folders: folderCount,
    totals,
    unread: messages.filter((m) => !m.flags.includes("\\Seen")).length,
    unreadConversations: new Set(messages.filter((m) => !m.flags.includes("\\Seen")).map((m) => m.conversation)).size,
    flagged: messages.filter((m) => m.flags.includes("\\Flagged")).length,
    html: messages.filter((m) => m.html).length,
    attachments: messages.filter((m) => m.attachment).length,
    threadSizeHistogram: histogram,
    largestThreadId: conversations[0]!.id,
    smallThreadId: conversations[1]?.id ?? conversations[0]!.id,
    mediumThreadId: conversations[2]?.id ?? conversations[0]!.id,
    htmlThreadId: conversations[3]?.id ?? conversations[0]!.id,
    largeFolderId: folders[0]!.id,
    mediumFolderId: folders[folderCount > 7 ? 6 : 1]!.id,
    sparseOldFolderId: folders[sparseFolder]!.id,
    rareWord,
    commonWord,
    structuredTarget: {
      from: "needle@example.test",
      word: rareWord,
      messageId: messages.find((m) => m.from === "needle@example.test")?.id ?? null,
    },
  };
  // Draw body data last so the existing mailbox shape and planned sizes stay stable.
  const senderIdentityShortId = shortId();
  const bodyCorpus = createBodyCorpus(random);
  return {
    parameters,
    folders,
    conversations,
    messages: messages.map((message) => ({ ...message, bodyOffset: Math.floor(random() * bodyCorpus.length) })),
    bodyCorpus,
    shape,
    senderIdentityShortId,
  };
}
export type LargeMailboxPlan = ReturnType<typeof planLargeMailbox>;
export function fixtureShortIds(plan: LargeMailboxPlan): string[] {
  return [
    ...plan.folders.map((row) => row.id),
    ...plan.conversations.map((row) => row.id),
    ...plan.messages.flatMap((row) => [row.id, ...(row.attachment ? [row.attachment.id] : [])]),
    plan.senderIdentityShortId,
  ];
}
export function digestPlan(plan: LargeMailboxPlan) {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(canonical(plan)))
    .digest("hex");
}

export const fixtureTables = [
  "provider_connections",
  "remote_resources",
  "provider_bindings",
  "folders",
  "binding_folder_refs",
  "sender_identities",
  "sender_identity_bindings",
  "message_contents",
  "message_addresses",
  "message_part_blobs",
  "message_part_chunks",
  "message_parts",
  "attachments",
  "attachment_extractions",
  "message_search_chunks",
  "remote_message_refs",
  "message_placements",
  "conversations",
  "conversation_messages",
  "conversation_assignees",
];

/** Bulk persistence boundary, not a provider connection. HTML expansion stays in Postgres. */
export async function seedLargeMailbox(db: SQL, plan: LargeMailboxPlan, options: { mailboxId: string; userIds: string[] }) {
  const { mailboxId, userIds } = options;
  if (!userIds[0]) throw new Error("Fixture needs an assignee user");
  return db.begin(async (tx) => {
    await tx`UPDATE mail.mailboxes SET sync_enabled = false, health = 'paused', health_reason = 'Synchronization paused by a mailbox administrator' WHERE id = ${mailboxId}::uuid`;
    const [connection] = await tx<{ id: string }[]>`INSERT INTO mail.provider_connections
      (owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret, authenticated_principal, capabilities, server_identity, last_verified_at)
      VALUES (${mailboxId}::uuid, 'Performance fixture', 'perf@example.test', 'perf@example.test', 'imap.example.test', 993, 'implicit', 'smtp.example.test', 587, 'starttls', 'password', 'not-a-provider-credential', 'perf@example.test', '{}', '{}', ${plan.parameters.anchor}::timestamptz) RETURNING id`;
    const [resource] = await tx<{ id: string }[]>`INSERT INTO mail.remote_resources
      (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}', '{}', ${"f".repeat(64)}, 'active') RETURNING id`;
    const [binding] = await tx<{ id: string }[]>`INSERT INTO mail.provider_bindings
      (remote_resource_id, connection_id, state, remote_locator, capabilities, rights, verification_evidence, verified_scope_fingerprint, verified_secret_revision, last_verified_at)
      VALUES (${resource!.id}::uuid, ${connection!.id}::uuid, 'active', '{}', '{}', '{}', '{}', ${"f".repeat(64)}, 1, ${plan.parameters.anchor}::timestamptz) RETURNING id`;
    // Folders must be inserted parent-first; only 6–1000 small rows cross this seam.
    const folderIds: string[] = [];
    for (const f of plan.folders) {
      const [folder] = await tx<{ id: string }[]>`INSERT INTO mail.folders
        (short_id, remote_resource_id, parent_id, stable_key, name, role, selected_for_sync, sync_status, last_reconciled_at)
        VALUES (${f.id}, ${resource!.id}::uuid, ${f.parent === null ? null : folderIds[f.parent]}::uuid, ${f.stableKey}, ${f.name}, ${f.role}, false, 'current', ${plan.parameters.anchor}::timestamptz) RETURNING id`;
      folderIds.push(folder!.id);
    }
    await tx`INSERT INTO mail.binding_folder_refs (binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at)
      SELECT ${binding!.id}::uuid, f.id, f.stable_key, 1, ${plan.messages.length + 1000}, ARRAY['read','write_flags','insert','move','delete_messages'], ${plan.parameters.anchor}::timestamptz
      FROM mail.folders f WHERE f.remote_resource_id = ${resource!.id}::uuid`;
    const [identity] = await tx<{ id: string; short_id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, display_name, from_address, automation_policy, is_default, status)
      VALUES (${plan.senderIdentityShortId}, ${mailboxId}::uuid, 'Performance', 'Performance', 'perf@example.test', 'disabled', true, 'verified') RETURNING id, short_id`;
    await tx`INSERT INTO mail.sender_identity_bindings (sender_identity_id, binding_id, provider_principal, verified_at, saves_sent_automatically)
      VALUES (${identity!.id}::uuid, ${binding!.id}::uuid, 'perf@example.test', ${plan.parameters.anchor}::timestamptz, true)`;
    await tx`CREATE TEMP TABLE perf_messages (data jsonb) ON COMMIT DROP`;
    for (let i = 0; i < plan.messages.length; i += 1000) {
      await tx`INSERT INTO perf_messages SELECT value FROM jsonb_array_elements(${plan.messages.slice(i, i + 1000)}::jsonb)`;
    }
    // Transfer once; doubling once in PostgreSQL covers wraparound for bodies <= 50 KiB.
    // The ASCII corpus is stored as uncompressed bytea, so substring() fetches only the slice it
    // needs; compressed text would be decompressed in full once per message.
    await tx`CREATE TEMP TABLE perf_corpus (body bytea) ON COMMIT DROP`;
    await tx`ALTER TABLE perf_corpus ALTER COLUMN body SET STORAGE EXTERNAL`;
    await tx`INSERT INTO perf_corpus SELECT convert_to(repeat(${plan.bodyCorpus}::text, 2), 'UTF8')`;
    await tx`CREATE TEMP TABLE perf_bodies ON COMMIT DROP AS WITH bodies AS MATERIALIZED (SELECT data,
      (data->>'text') || convert_from(substring(body FROM (data->>'bodyOffset')::int + 1 FOR
        (data->>'bodyBytes')::int - length(data->>'text') - CASE WHEN (data->>'html')::boolean THEN 7 ELSE 0 END), 'UTF8') AS plain
      FROM perf_messages CROSS JOIN perf_corpus)
      SELECT data, plain, CASE WHEN (data->>'html')::boolean THEN '<p>' || plain || '</p>' ELSE NULL END AS html FROM bodies`;
    await tx`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, in_reply_to, reference_ids, subject, normalized_subject, internal_date, sent_at, size_bytes, plain_text, sanitized_html, source_hash, content_hash, hydration_status, hydrated_at, created_at, selected_headers)
      SELECT data->>'id', ${mailboxId}::uuid, '<' || (data->>'id') || '@example.test>',
        '<thread-' || (data->>'conversation') || '@example.test>', ARRAY['<thread-' || (data->>'conversation') || '@example.test>'],
        data->>'subject', lower(data->>'subject'), (data->>'date')::timestamptz, (data->>'date')::timestamptz,
        (data->>'bodyBytes')::int + 512 + coalesce((data->'attachment'->>'bytes')::int, 0), plain, html,
        encode(sha256(convert_to((data->>'id') || plain, 'UTF8')), 'hex'), encode(sha256(convert_to(data::text, 'UTF8')), 'hex'),
        'complete', ${plan.parameters.anchor}::timestamptz - interval '1 millisecond', (data->>'date')::timestamptz, jsonb_build_object('subject', data->>'subject') FROM perf_bodies`;
    await tx`UPDATE mail.message_contents m SET
      protocol_facts = jsonb_set(m.protocol_facts, '{contentType}', to_jsonb(CASE
        WHEN b.data->'attachment' <> 'null'::jsonb THEN 'multipart/mixed; boundary="perf-' || m.short_id || '"'
        WHEN b.html IS NOT NULL THEN 'text/html; charset=utf-8' ELSE 'text/plain; charset=utf-8' END)),
      selected_headers = jsonb_build_object('message-id', m.message_id, 'subject', m.subject,
        'in-reply-to', m.in_reply_to, 'references', array_to_string(m.reference_ids, ' '),
        'date', to_char(m.internal_date AT TIME ZONE 'UTC', 'Dy, DD Mon YYYY HH24:MI:SS') || ' +0000',
        'from', b.data->>'from', 'to', b.data->>'to',
        'content-type', CASE WHEN b.data->'attachment' <> 'null'::jsonb THEN 'multipart/mixed; boundary="perf-' || m.short_id || '"'
          WHEN b.html IS NOT NULL THEN 'text/html; charset=utf-8' ELSE 'text/plain; charset=utf-8' END)
      FROM perf_bodies b WHERE m.short_id = b.data->>'id'`;
    await tx`INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      SELECT m.id, a.role, 0, CASE a.email WHEN 'perf@example.test' THEN 'Performance' ELSE 'Contact' END, a.email, lower(a.email)
      FROM perf_messages p JOIN mail.message_contents m ON m.short_id = p.data->>'id'
      CROSS JOIN LATERAL (VALUES ('from', p.data->>'from'), ('to', p.data->>'to')) a(role, email)`;
    // Store complete body, source and attachment blobs/chunks, as hydration does.
    await tx`CREATE TEMP TABLE perf_parts ON COMMIT DROP AS
      SELECT parts.*, encode(sha256(convert_to(body, 'UTF8')), 'hex') AS content_hash FROM (
      SELECT m.id AS message_id, CASE WHEN b.html IS NULL THEN 'normalized-plain' ELSE 'original-html' END AS path, CASE WHEN b.html IS NULL THEN 'text/plain' ELSE 'text/html' END AS content_type,
        coalesce(b.html, b.plain) AS body, false AS attachment, NULL::text AS short_id, NULL::text AS filename
      FROM perf_bodies b JOIN mail.message_contents m ON m.short_id = b.data->>'id'
      UNION ALL SELECT m.id, 'normalized-plain', 'text/plain', b.plain, false, NULL, NULL
      FROM perf_bodies b JOIN mail.message_contents m ON m.short_id = b.data->>'id' WHERE b.html IS NOT NULL
      UNION ALL SELECT m.id, 'attachment-1', 'text/plain', repeat('a', (p.data->'attachment'->>'bytes')::int), true, p.data->'attachment'->>'id', p.data->'attachment'->>'filename'
      FROM perf_messages p JOIN mail.message_contents m ON m.short_id = p.data->>'id' WHERE p.data->'attachment' <> 'null'::jsonb
      UNION ALL SELECT m.id, 'source', 'message/rfc822', concat_ws(chr(13) || chr(10),
        'Message-ID: <' || m.short_id || '@example.test>', 'Subject: ' || m.subject,
        'In-Reply-To: ' || m.in_reply_to, 'References: ' || array_to_string(m.reference_ids, ' '),
        'Date: ' || to_char(m.internal_date AT TIME ZONE 'UTC', 'Dy, DD Mon YYYY HH24:MI:SS') || ' +0000',
        'From: ' || (b.data->>'from'), 'To: ' || (b.data->>'to'), 'MIME-Version: 1.0',
        CASE WHEN b.data->'attachment' <> 'null'::jsonb THEN 'Content-Type: multipart/mixed; boundary="perf-' || m.short_id || '"' || chr(13) || chr(10) || chr(13) || chr(10) || '--perf-' || m.short_id ELSE NULL END,
        'Content-Type: ' || CASE WHEN b.html IS NULL THEN 'text/plain' ELSE 'text/html' END || '; charset=utf-8',
        'Content-Transfer-Encoding: 7bit', '', coalesce(b.html, b.plain),
        CASE WHEN b.data->'attachment' <> 'null'::jsonb THEN concat_ws(chr(13) || chr(10),
          '--perf-' || m.short_id, 'Content-Type: text/plain',
          'Content-Disposition: attachment; filename="' || (b.data->'attachment'->>'filename') || '"',
          'Content-Transfer-Encoding: 7bit', '', repeat('a', (b.data->'attachment'->>'bytes')::int), '--perf-' || m.short_id || '--') ELSE NULL END), false, NULL, NULL
      FROM perf_bodies b JOIN mail.message_contents m ON m.short_id = b.data->>'id') parts`;
    await tx`INSERT INTO mail.message_part_blobs (content_hash, byte_length, chunk_count, complete, completed_at)
      SELECT DISTINCT content_hash, octet_length(body), 1, true, ${plan.parameters.anchor}::timestamptz FROM perf_parts
      ON CONFLICT (content_hash) DO NOTHING`;
    await tx`INSERT INTO mail.message_part_chunks (blob_id, position, bytes)
      SELECT DISTINCT b.id, 0, convert_to(p.body, 'UTF8') FROM perf_parts p JOIN mail.message_part_blobs b ON b.content_hash = p.content_hash
      ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO mail.message_parts (message_id, part_path, content_type, charset, transfer_encoding, disposition, filename, size_bytes, blob_id, hydration_status)
      SELECT p.message_id, p.path, p.content_type, CASE WHEN p.attachment THEN NULL ELSE 'utf-8' END, NULL, CASE WHEN p.attachment THEN 'attachment' ELSE 'inline' END, p.filename, octet_length(p.body), b.id, 'complete'
      FROM perf_parts p JOIN mail.message_part_blobs b ON b.content_hash = p.content_hash WHERE p.path <> 'source'`;
    await tx`UPDATE mail.message_contents m SET source_blob_id = b.id, source_hash = b.content_hash, size_bytes = b.byte_length
      FROM perf_parts p JOIN mail.message_part_blobs b ON b.content_hash = p.content_hash WHERE p.path = 'source' AND m.id = p.message_id`;
    await tx`INSERT INTO mail.attachments (short_id, message_id, part_id, filename, content_type, disposition, checksum, size_bytes, blob_id)
      SELECT p.short_id, p.message_id, part.id, p.filename, p.content_type, 'attachment', b.content_hash, b.byte_length, b.id
      FROM perf_parts p JOIN mail.message_parts part ON part.message_id = p.message_id AND part.part_path = p.path
      JOIN mail.message_part_blobs b ON b.id = part.blob_id WHERE p.attachment`;
    // anydoc does not support .txt. Persist its real terminal state so the
    // recovery scheduler cannot turn fixture attachments into background jobs.
    await tx`INSERT INTO mail.attachment_extractions (blob_id, extractor_version, status, error_code, attempt_count, updated_at, completed_at)
      SELECT DISTINCT a.blob_id, ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}, 'unsupported', 'unsupported', 1,
        ${plan.parameters.anchor}::timestamptz, ${plan.parameters.anchor}::timestamptz
      FROM mail.attachments a JOIN mail.message_contents m ON m.id = a.message_id WHERE m.mailbox_id = ${mailboxId}::uuid
      ON CONFLICT (blob_id, extractor_version) DO NOTHING`;
    await tx`INSERT INTO mail.message_search_chunks (message_id, mailbox_id, position, search_document)
      SELECT m.id, m.mailbox_id, 0, to_tsvector('simple'::regconfig, m.plain_text) FROM mail.message_contents m WHERE m.mailbox_id = ${mailboxId}::uuid`;
    await tx`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid, modseq, connector_ref)
      SELECT f.id, m.id, 1, row_number() OVER (ORDER BY m.short_id), 1, jsonb_build_object('providerMessageId', m.message_id)
      FROM perf_messages p JOIN mail.message_contents m ON m.short_id = p.data->>'id'
      JOIN mail.folders f ON f.short_id = p.data->>'folder'`;
    await tx`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      SELECT r.id, r.folder_id, r.message_id, ARRAY(SELECT jsonb_array_elements_text(p.data->'flags')), ARRAY[]::text[]
      FROM perf_messages p JOIN mail.message_contents m ON m.short_id = p.data->>'id'
      JOIN mail.remote_message_refs r ON r.message_id = m.id`;
    await tx`INSERT INTO mail.conversations
      (short_id, mailbox_id, subject, participant_summary, latest_inbound_at, latest_outbound_at, latest_message_at, assignee_user_id, work_status, snoozed_until, revision, created_at, updated_at)
      SELECT c.id, ${mailboxId}::uuid, max(m.subject), 'Contact', max(m.internal_date) FILTER (WHERE p.data->>'from' <> 'perf@example.test'), max(m.internal_date) FILTER (WHERE p.data->>'from' = 'perf@example.test'), max(m.internal_date),
        CASE WHEN c.assigned THEN ${userIds[0]}::uuid END, c.status, c."snoozedUntil"::timestamptz, c.size + 1, min(m.internal_date), max(m.internal_date)
      FROM jsonb_to_recordset(${plan.conversations}::jsonb) c(id text, assigned boolean, status text, "snoozedUntil" text, size int)
      JOIN perf_messages p ON p.data->>'conversation' = c.id JOIN mail.message_contents m ON m.short_id = p.data->>'id'
      GROUP BY c.id, c.assigned, c.status, c."snoozedUntil", c.size`;
    await tx`INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by, hydrated_revision)
      SELECT c.id, m.id, greatest(0, (extract(epoch FROM m.internal_date) * 1000)::bigint), 'headers', c.revision
      FROM perf_messages p JOIN mail.message_contents m ON m.short_id = p.data->>'id' JOIN mail.conversations c ON c.short_id = p.data->>'conversation'`;
    await tx`INSERT INTO mail.conversation_assignees (conversation_id, user_id, assigned_at)
      SELECT id, assignee_user_id, ${plan.parameters.anchor}::timestamptz FROM mail.conversations WHERE mailbox_id = ${mailboxId}::uuid AND assignee_user_id IS NOT NULL`;
    for (const table of fixtureTables) await tx.unsafe(`ANALYZE mail.${table}`);
    return { remoteResourceId: resource!.id, bindingId: binding!.id, inboxId: folderIds[0]!, senderIdentityId: identity!.short_id };
  });
}
