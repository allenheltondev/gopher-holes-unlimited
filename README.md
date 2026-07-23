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
                                                        │  OutboxRelayFunction      │
                                                        │  (batched, partial-fail)  │
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
asynchronously publish the committed outbox records. Because the relay reads from
the DynamoDB stream at-least-once, consumers should be idempotent — the `eventId`
on every event (the ULID of the outbox record) makes that easy.

The core helper lives in [`src/lib/dynamo.js`](./src/lib/dynamo.js):

```js
await transactWriteWithOutbox({
  writes: [{ Put: { Item: gopherItem, ConditionExpression: 'attribute_not_exists(pk)' } }],
  events: [domainEvent(DetailType.GopherCreated, { id, name, location })]
});
```

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
test/                 # node:test unit + handler tests
template.yaml         # SAM infrastructure
openapi.yaml          # REST API documentation
asyncapi.yaml         # Domain event documentation
```

## Data model (single table)

| Entity          | pk                | sk                  | Indexes                                            |
|-----------------|-------------------|---------------------|----------------------------------------------------|
| Gopher          | `GOPHER#<id>`     | `GOPHER#<id>`       | GSI1: `GOPHER` / `<createdAt>`                      |
| Gopher status   | `GOPHER#<id>`     | `STATUS#<ulid>`     | –                                                  |
| Hole            | `HOLE#<id>`       | `HOLE#<id>`         | GSI1: `HOLE` / `<createdAt>`, GSI2: `LOCATION#…`    |
| Gopher⇄Hole link| `GOPHER#<gopher>` | `LINK#HOLE#<hole>`  | GSI1: `HOLE#<hole>` / `GOPHER#<gopher>` (reverse)   |
| Outbox record   | `OUTBOX#<ulid>`   | `OUTBOX#<ulid>`     | – (TTL-reaped after publish)                       |

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
