[![Twitter][1.1]][1] [![GitHub][2.1]][2] [![LinkedIn][3.1]][3] [![Ready, Set, Cloud!][4.1]][4]
# Gopher Holes Unlimited

![Gopher Holes Unlimited Logo](https://readysetcloud.s3.amazonaws.com/GHU.png)

A reference serverless application for teaching the patterns we actually build
with today. *Gopher Holes Unlimited* is a fictional service for tracking gophers,
the holes they dig, and our never-ending quest to keep them out of the garden.

> **v2 rewrite.** Earlier versions of this repo taught API-first development with
> direct API Gateway → DynamoDB/VTL integrations and a Step Functions job. This
> version has been rebuilt around a mono-Lambda API, AWS Lambda Powertools, and
> the transactional outbox pattern. See [What changed](#what-changed-from-v1).

## What you'll learn

- **Mono-Lambda API with an event-handler controller.** A single Lambda function
  handles every route using the [AWS Lambda Powertools event-handler
  `Router`](https://docs.powertools.aws.dev/lambda/typescript/latest/). No more
  one-Lambda-per-endpoint sprawl.
- **Lambda Powertools everywhere.** Structured **logging**, EMF **metrics**,
  X-Ray **tracing**, and **idempotency** for safe create retries.
- **The transactional outbox pattern.** Every write is a DynamoDB
  `TransactWriteItems` that commits the domain change *and* an outbox record
  atomically. A stream relay forwards outbox records to EventBridge as domain
  events — so you can never lose an event or emit one for a write that rolled back.
- **Event-driven choreography.** Domain events on an EventBridge bus drive
  side effects (like linking a new gopher to the holes already known at its
  location) without an orchestrator.
- **Node.js 24** on `arm64`, bundled with esbuild via `sam build`.

## Architecture

```
                 ┌─────────────────────────────┐
   HTTP  ─────▶  │  API Gateway (REST, proxy)  │
                 └──────────────┬──────────────┘
                                │  ANY /{proxy+}
                 ┌──────────────▼──────────────┐   idempotency
                 │   ApiFunction (mono-Lambda) │◀───────────────▶  IdempotencyTable
                 │   Powertools Router         │
                 └──────────────┬──────────────┘
                                │ TransactWriteItems (entity + outbox record)
                 ┌──────────────▼──────────────┐
                 │   GopherHolesTable (single) │  ── DynamoDB Stream ──┐
                 └─────────────────────────────┘                       │ filter: entityType = outbox
                                                                        ▼
                                                        ┌──────────────────────────┐
                                                        │  OutboxRelayFunction       │
                                                        │  sequential, fail-stop,    │
                                                        │  checks FailedEntryCount   │
                                                        └──────────────┬───────────┘
                                                                       │ PutEvents
                                                        ┌──────────────▼───────────┐
                                                        │   DomainEventBus (EB)     │
                                                        └──────────────┬───────────┘
                                                                       │ rules on detail-type
                                                        ┌──────────────▼───────────┐
                                                        │  ChoreographyFunction     │
                                                        │  link holes, sync status  │
                                                        └───────────────────────────┘
```

### Why the outbox?

Dual-writing to a database and a message broker is a classic distributed-systems
trap: the second write can fail, leaving your data and your events out of sync.
The outbox pattern removes the second write. We commit the domain change and the
event to the *same* DynamoDB table in one transaction, then let a relay
asynchronously publish the committed outbox records.

The core helper lives in [`src/lib/dynamo.js`](./src/lib/dynamo.js):

```js
await transactWriteWithOutbox({
  writes: [{ Put: { Item: gopherItem, ConditionExpression: 'attribute_not_exists(pk)' } }],
  events: [domainEvent(DetailType.GopherCreated, id, { id, name, location })]
});
```

### Reliability model — the guarantees, stated plainly

This repo is meant for teams with real durability requirements, so it's worth
being explicit about what holds and what doesn't:

- **Atomicity.** The entity change and its events commit in one
  `TransactWriteItems`. There is no state where the data changed but the event
  was lost, or vice versa.
- **No lost events on publish.** `PutEvents` can return HTTP 200 while individual
  entries fail. The relay checks `FailedEntryCount` and treats any failed entry as
  a record failure, so the DynamoDB stream re-delivers it. (Missing this check is a
  common silent-data-loss bug.)
- **At-least-once delivery.** The relay's "ack" is the DynamoDB stream checkpoint,
  not a delete. We deliberately do **not** delete outbox records on publish —
  that would reintroduce a dual-write (publish succeeds, delete fails). A TTL
  reclaims them after a replay/audit window instead.
- **In-shard, no-gap relay.** Outbox records are partitioned by `aggregateId` so
  an entity's events *tend* to share a stream shard, and the relay processes each
  shard's batch **sequentially and stops at the first failure**, reporting it via
  `batchItemFailures` — it never publishes a later record before an earlier one
  succeeds, and never advances past a gap.
- **What we do *not* promise: exactly-once, or a per-aggregate ordering sequence.**
  Exactly-once delivery is impossible; consumers must be **idempotent** (dedupe on
  `eventId`). And `eventId` is a *unique* id, **not** a reliable ordering sequence:
  DynamoDB Streams only orders records for the *same item*, and the ULID is
  process-local, so ids from different containers needn't match commit order.
  EventBridge doesn't guarantee end-to-end ordering either, so consumers that need
  strict order must enforce it themselves (or use a FIFO transport) rather than
  sorting by `eventId`.

### Consumer side: idempotency and poison messages

Because delivery is at-least-once, the choreography consumer wraps its handler in
**Powertools idempotency** keyed on `detail.eventId` — a re-delivered event is
recognized and skipped. Its reactions are independently idempotent too (links use
`attribute_not_exists` conditions; status sync is set-to-value), giving defense in
depth.

Two ordering/consistency hazards are handled explicitly, since the stream is
at-least-once and EventBridge delivery is only best-effort ordered:

- **Out-of-order status events.** `hole.status-changed` handling ignores the
  status in the event payload and instead re-reads the hole (strongly consistent)
  and propagates *that* onto the links. The hole item is the single source of
  truth for its latest status, so an older event arriving after a newer one still
  converges the links correctly.
- **Concurrent creates at the same location.** Location auto-linking is symmetric
  — `gopher.created` links holes at its location *and* `hole.created` links gophers
  at its location — and discovery reads the **strongly-consistent** location
  rendezvous rows in the base table rather than an eventually-consistent GSI. Each
  entity writes its rendezvous member in the same transaction as itself, so the
  entity that commits second is guaranteed to see the first; a link can't be lost
  even when both are created at the same instant. Duplicate attempts from the two
  directions no-op via the `attribute_not_exists` condition.

Retrying a partially-failed reaction is the **invocation's** job, not a loop
inside the handler. When a gopher is linked to the holes at its location, the
consumer writes them with `Promise.allSettled` (so every write finishes before the
handler returns — a fail-fast reject would let Lambda freeze with writes still in
flight), then throws if any link genuinely failed. The event is re-delivered and
the already-written links no-op. That keeps retry at the durable boundary instead
of burning Lambda duration on an in-handler loop that could hit the timeout.
Execution failures are retried by Lambda's async policy and then routed to a DLQ
via `EventInvokeConfig` — which is distinct from the rule's `DeadLetterConfig`
(that one only catches EventBridge *delivery* failures, not a throwing handler).

Stopping the relay on the first failure preserves order but means a persistently
failing ("poison") record would block its shard. That's bounded on purpose: the
event-source mapping caps retries (`MaximumRetryAttempts`) and routes exhausted
records to a **DLQ** (`OnFailure` destination), letting the shard advance. Monitor
the relay and choreography DLQs — a non-empty DLQ is your signal that events need
a manual redrive.

### Envelope

Every published event's `detail` includes:

| field         | purpose                                                            |
|---------------|--------------------------------------------------------------------|
| `eventId`     | Unique ULID of the outbox record — use as the **dedupe key** (not a sequence). |
| `aggregateId` | Entity id; the outbox partition key (shard locality).             |
| `occurredAt`  | ISO-8601 time of the committing transaction.                       |
| …             | event-specific fields (`id`, `status`, `holeId`, …)                |

## Project layout

```
src/
  handlers/
    api.js            # Mono-Lambda REST controller (Powertools Router)
    outbox-relay.js   # DynamoDB stream -> EventBridge (the outbox message relay)
    choreography.js   # EventBridge consumer for cross-aggregate reactions
  lib/
    dynamo.js         # Doc client + transactWriteWithOutbox (outbox core)
    idempotency.js    # Powertools idempotency wiring
    powertools.js     # Shared Logger / Metrics / Tracer singletons
    events.js         # Domain event names + factory
    keys.js           # Single-table key design
    validation.js     # Lightweight request validation
    repository/
      gophers.js      # Gopher access patterns
      holes.js        # Hole + link access patterns
      members.js      # Location rendezvous membership writes
test/                 # node:test unit + handler tests
template.yaml         # SAM infrastructure
openapi.yaml          # REST API documentation
asyncapi.yaml         # Domain event documentation
```

## Data model (single table)

| Entity           | pk                | sk                   | Indexes                                          |
|------------------|-------------------|----------------------|--------------------------------------------------|
| Gopher           | `GOPHER#<id>`     | `GOPHER#<id>`        | GSI1: `GOPHER` / `<createdAt>`                    |
| Gopher status    | `GOPHER#<id>`     | `STATUS#<ulid>`      | –                                                |
| Hole             | `HOLE#<id>`       | `HOLE#<id>`          | GSI1: `HOLE` / `<createdAt>`                      |
| Gopher⇄Hole link | `GOPHER#<gopher>` | `LINK#HOLE#<hole>`   | GSI1: `HOLE#<hole>` / `GOPHER#<gopher>` (reverse) |
| Location member  | `LOCATION#<key>`  | `GOPHER#<id>` / `HOLE#<id>` | – (strongly-consistent rendezvous)         |
| Outbox record    | `OUTBOX#<ulid>`   | `OUTBOX#<ulid>`      | – (TTL-reaped after publish)                     |

Location auto-linking discovers counterparties through the **location member**
rows with a strongly-consistent base-table read — never an eventually-consistent
GSI — so two entities created at the same place at the same time can't miss each
other.

## API

The full contract is in [`openapi.yaml`](./openapi.yaml). In short:

| Method & path                     | Description                                  |
|-----------------------------------|----------------------------------------------|
| `POST /gophers`                   | Track a new gopher (idempotent)              |
| `GET /gophers`                    | List gophers                                 |
| `GET /gophers/{id}`               | Get a gopher (`?include=holes`)              |
| `PATCH /gophers/{id}`             | Update a gopher                              |
| `DELETE /gophers/{id}`            | Delete a gopher                              |
| `POST /gophers/{id}/statuses`     | Record a gopher status                       |
| `POST /holes`                     | Track a new hole (idempotent)                |
| `GET /holes`                      | List holes (`?status=`)                      |
| `GET /holes/{id}`                 | Get a hole (`?include=gopher`)               |
| `PUT /holes/{id}`                 | Replace a hole                               |
| `PATCH /holes/{id}`               | Update a hole                                |
| `POST /holes/{id}/statuses`       | Update a hole's status                       |

Send an `Idempotency-Key` header on the two create endpoints to make retries
safe — Powertools stores the result and replays it for the same key.

## Getting started

Requires **Node.js 24**, the **AWS SAM CLI**, and AWS credentials.

```bash
npm install        # install dependencies
npm run lint       # eslint
npm test           # node:test unit + handler tests
npm run build      # sam build (esbuild bundling)
npm run deploy     # sam deploy --guided the first time
```

After deploying, the stack outputs the API base URL, table name, and event bus
name.

## What changed from v1

- One **mono-Lambda** replaces the per-endpoint functions and the VTL direct
  integrations.
- Creating a gopher is now **synchronous** (`201`) instead of an async Step
  Functions job, so the `/jobs/...` polling endpoint is gone. The
  "link holes at the same location" logic moved from the state machine into the
  **choreography consumer**, triggered by the `gopher.created` domain event.
- SNS topics and the WebSocket integration are replaced by a single
  **EventBridge** bus fed by the **outbox relay**.
- Runtime upgraded from Node.js 16 to **Node.js 24**; AWS SDK v3 is used from the
  managed runtime, and Powertools is bundled with esbuild.

## Like this?

If you like this repo, follow along on [Twitter][1] or [LinkedIn][3]. Ideas and
questions are always welcome on the [blog][4].

[1.1]: http://i.imgur.com/tXSoThF.png
[2.1]: http://i.imgur.com/0o48UoR.png
[3.1]: http://i.imgur.com/lGwB1Hk.png
[4.1]: https://readysetcloud.s3.amazonaws.com/logo.png

[1]: http://www.twitter.com/allenheltondev
[2]: http://www.github.com/allenheltondev
[3]: https://www.linkedin.com/in/allen-helton-85aa9650/
[4]: https://readysetcloud.io
