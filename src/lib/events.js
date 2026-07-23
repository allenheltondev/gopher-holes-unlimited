// Canonical list of domain events emitted by the service. Keeping the names in
// one place makes them easy to reference from the API, the choreography consumer,
// and the AsyncAPI spec without magic strings drifting apart.
export const DetailType = {
  GopherCreated: 'gopher.created',
  GopherUpdated: 'gopher.updated',
  GopherDeleted: 'gopher.deleted',
  GopherStatusChanged: 'gopher.status-changed',
  HoleCreated: 'hole.created',
  HoleUpdated: 'hole.updated',
  HoleStatusChanged: 'hole.status-changed',
  GopherHoleLinked: 'gopher-hole.linked',
  GopherHoleUnlinked: 'gopher-hole.unlinked'
};

export const EVENT_SOURCE = 'ghu.api';

// Small factory so every producer builds events with the same shape.
//
// `aggregateId` is required: it becomes the outbox record's partition key, which
// is what guarantees per-aggregate ordering through the DynamoDB stream. Pick the
// id of the entity whose change history the event belongs to.
export const domainEvent = (detailType, aggregateId, detail = {}, source = EVENT_SOURCE) => ({
  detailType,
  aggregateId,
  detail,
  source
});
