# Approval Inbox API

The hosted runtime stores tool and learned-skill promotion approvals in
`.sofia/approvals.sqlite`. The queue is private to the Sofia workspace and
uses SQLite transactions for one-time decisions.

## Scopes

The default hosted API scopes include `approval:read` and
`approval:decide`. If `SOFIA_API_SCOPES` is explicitly configured, add both
scopes to the API key that owns the run. Approval ownership is derived from the
authenticated API key ID; callers cannot choose an owner in the request body.

## List pending approvals

```http
GET /v1/approvals
Authorization: Bearer <API_KEY>
```

Returns only pending requests belonging to the authenticated API key. Each
record includes the exact `actionHash` required for a decision and a redacted
copy of the action input.

## Approve or reject

```http
POST /v1/approvals/<APPROVAL_ID>/decision
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "actionHash": "<ACTION_HASH_FROM_THE_PENDING_RECORD>",
  "approved": true
}
```

Set `approved` to `false` to reject. The request is accepted only when the
authenticated API key owns the pending record, the action hash matches, and
the request has not expired or already been decided. A successful decision
returns the updated approval record. A stale, mismatched, or already-decided
request returns HTTP 409.

## Safety boundaries

- Missing approval infrastructure or missing owner identity fails closed.
- A decision applies only to the exact action hash shown in the inbox.
- Each request can transition from pending only once.
- Requests expire after 10 minutes by default.
- Approval decisions and system expiry transitions are written to the
  `approval_audit` table.
- Approval does not bypass the existing security policy, tool validation,
  or host cancellation checks.
- This API currently exposes approvals for authenticated API-key principals.
  Discord principals use a separate identity namespace; interactive Discord
  approval controls are not wired by this change and must not be represented
  as available until separately implemented and tested.
