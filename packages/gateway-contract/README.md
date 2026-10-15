# @hawl/gateway-contract

How any orchestrator joins a Hawl site as a yard. The site never needs to know what runs inside. Three JSON Schemas, test vectors, and a reference gateway stub.

- `schemas/menu.schema.json`: what the yard offers.
- `schemas/heartbeat.schema.json`: status counts, about every 30 s or on change.
- `schemas/lifecycle.schema.json`: task events and the direct-line handshake.
- `vectors/{menu,heartbeat,lifecycle}.json`: named `valid: true/false` cases. `flows.json`: legal and illegal event orders.
- `src/reference-gateway.ts`: stub that round-trips every vector and enforces ordering.

All objects are strict: unknown fields are rejected. Timestamps are RFC 3339 date-times.

## Menu

| Field | Required | Meaning |
| --- | --- | --- |
| `yard` | yes | Yard slug, lowercase letters, digits, `-`. |
| `owner` | yes | Owning user id. |
| `display_name` | yes | Name shown on the site, up to 80 chars. |
| `visibility` | yes | `private` (gateway only), `summary` (counts and status), `full` (inner agents listed). |
| `capabilities[]` | yes | What the yard can do. May be empty. |
| `capabilities[].id` | yes | Capability slug. |
| `capabilities[].description` | yes | One line, up to 280 chars. |
| `capabilities[].inputs` / `outputs` | no | Names of inputs and outputs. |
| `capabilities[].quality_bar` | no | Levels the yard supports, e.g. `standard`, `critical`. |
| `capabilities[].typical_minutes` | no | Integer, 1 to 10080. |
| `capabilities[].accepts_files` | no | Media types; `image/*` allowed. |
| `routing_policy.accept_from` | no | Who may send tasks, e.g. `site`. |
| `routing_policy.auto_accept` | no | Accept without a human. |
| `routing_policy.daily_budget_usd` | no | Number, 0 or more. |

## Heartbeat

| Field | Required | Meaning |
| --- | --- | --- |
| `yard` | yes | Must equal the menu yard. |
| `state` | yes | `online`, `busy`, `degraded`, `paused`, `offline`. |
| `load.active_tasks`, `load.queued` | yes | Counts, 0 or more. |
| `workers.busy`, `workers.idle` | yes | Counts, 0 or more. |
| `needs_human` | yes | Count of tasks waiting on a person. |
| `as_of` | yes | Time of the snapshot. |
| `agents[]` | no | `{ id, status }` per inner agent. Kept only at visibility `full`; the reference gateway drops it otherwise. |

## Lifecycle

Every event has `yard`, `task_id`, `event`, `at`. States follow the handoff flow: asked, accepted, done, verified.

| Event | Extra fields | Effect |
| --- | --- | --- |
| `offer` | optional `capability`, `acceptance[]`, `quality_bar`, `deadline` | none to asked; reassigned to asked |
| `accept` | none | asked to accepted |
| `decline` | optional `reason` | asked to declined |
| `progress` | optional `note` | stays accepted |
| `done` | `revision_sha` (40 hex), `evidence[]` (at least 1 of `{ kind: sha, ci, pr, artifact; ref }`) | accepted to done |
| `verify` | `revision_sha`, `result` (`pass` or `reject`), optional `reason` | done to verified on pass; back to accepted on reject |
| `cancel` | optional `reason` | asked, accepted or done to cancelled |
| `expire` | none | asked, accepted or done to expired |
| `reassign` | `to` (yard slug) | asked to reassigned |
| `direct_line_open` | `from_inner`, `to_village`, `purpose`, `ttl_minutes` (1 to 1440) | needs an accepted task; one pending request per task |
| `direct_line_approve`, `direct_line_reject` | optional `reason` | answers the pending request |

Declined, verified, cancelled and expired are final. Proof must be machine-checkable, such as a CI link or artefact hash.

## Tests

```
cd packages/gateway-contract && node --test --test-concurrency=1 "src/**/*.test.ts"
```
