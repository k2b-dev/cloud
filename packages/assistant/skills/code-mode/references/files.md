# Explicit file references and transfers

Files belong to a chat, Project, or App shared store. A location is
`{scope:"chat"|"project"|"app",id,path}`. A reference adds an opaque string
`version`. The current chat ID is supplied as `Chat:` in the platform context;
use it for `scope:"chat"` rather than guessing an ID. Reuse returned locations and references exactly; access to a location
never grants access to its whole store or to another resource.

Load only `code_files`, `code_file_stat`, and `code_file_copy` as needed.

1. `code_files({scope,id,after?:string,limit?:number})` returns `container`,
   `items:[{location,path,size,mediaType}]`, and `nextAfter`. Limit defaults to
   100, maximum 1,000. Continue with `nextAfter` until null.
2. `code_file_stat({file:location})` returns `{exists:false}` or
   `{exists:true,reference,size,mediaType}`. It does not print file bytes.
3. `code_file_copy({source:reference,destination:location,expectedVersion})`
   copies bytes on the server. For a new destination use `expectedVersion:null`;
   replacing a file requires its exact current version from `code_file_stat`.
   The result contains the destination `reference,size,mediaType`.

Every copy receives fresh user review with the exact source, destination, and
overwrite scope. App and Project files may be readable by other authorized
users; copying a private chat attachment there is an explicit disclosure.
Rejection does not copy anything. Source versions, destination versions, current
permissions, and the destination's byte limits are checked again during execution.
After a conflict, inspect current state and prepare a new review before retrying.

App file reads and writes require Use, not Manage. Project files require Read
for sources and Write for destinations. Chat files require ownership. Transfers
work without a running UI and do not mount other chat attachments implicitly.

For example, inspect an invoice attachment, copy its reference into the target
App's shared file store, then call the App's published `importFiles` action with
the destination key expected by its discovered input schema. Do not pass a chat
path to an App and assume it can read it. Action handlers see only their explicit
input and authorized App data. Use [App actions](app-actions.md) for discovery.

For small UTF-8 files that should become App source, use
`code_write({id,expectedRevision,files:[{path:"data.json",fromFile:reference}]})`.
This is a reviewed import with the same source references, not a chat-only
special case. Source file/bundle limits still apply; keep larger or private
runtime data in shared files or the database instead of embedding it in source.

Known rejections return `CONFLICT` for an occupied or changed destination and
`STORAGE_FULL` for a destination byte limit. No destination bytes were written.
Choose another path or reduce the file size, then prepare a new review.


## List Filesv2 files beside Grids documents

Discover the installed contracts first. Call `filesv2.bases.list`, then
`filesv2.entry.list` for a folder or `filesv2.entry.search-in-base` for names
below a known path. Keep the filters unchanged and follow `data.next` as
`after` until null, even after an empty page. Each `data.items` entry includes
its own `{type:"filesv2.entry",id}` ref and file metadata. Keep that ref in the
Studio list, alongside the `grids.document` refs from `grids.document.list`.
Use both `type` and `id` as the identity; dispatch each type to its own
operations. Grids uses its own `page` cursor, not Filesv2's `data.next`.

Filesv2 refs identify a base and path, including long paths; they do not grant
access or pin a content version. Moving or renaming changes the ref, and
replacing bytes at the same path keeps it. Refresh metadata when needed.
Never construct storage URLs or turn files into public shares for this flow.

Only on a user's download request, call `filesv2.content.download` with the
selected Filesv2 ref's exact `id`. Its `data` is `{url,method:"GET",expires}`.
Offer that returned URL unchanged to the requesting user; it is a private
bearer credential, not a stable resource link. It expires after 60 seconds;
use the returned `expires` timestamp and request a fresh lease when needed.
Do not prefetch leases for list rows, persist them in App/shared data, or
include them in logs. Do not send Cloud cookies or authorization headers to
the storage host. Grids documents keep their authenticated download path from
their canonical reader; never send a `grids.document` ID to Filesv2.

Each lease request checks the current user's storage and Unix permissions.
A 403 means access is denied; a 404 means the ref or file is missing or the
base is no longer visible. Refresh the list and do not bypass the denial.
`not_file` (400) means a folder was selected. `identity_changed` (409) requires
refreshing access/identity state before trying again. Storage unavailability is an
error, not an empty list. If a lease expires or a transfer fails, discard the
URL and request a fresh lease through the same capability; if that is denied,
stop. Revoking Cloud access prevents new leases; an already issued bearer
lease can remain usable until expiry, subject to storage checks.

For analysis inside code, use `filesv2.content.read` and
`capabilities.streams.read` instead of fetching a bearer URL. See
[Capability calls](capabilities.md) for binary budgets and consent rules.
