import { ulid } from 'ulid';
import { assertFound, buildUpdateExpression, getItem, pickDefined, query, transactWriteWithOutbox } from '../dynamo.js';
import { gopherKey, gopherStatusKey, GSI1, GSI2, GOPHER_COLLECTION, LINK_PREFIX, locationKey } from '../keys.js';
import { DetailType, domainEvent } from '../events.js';

// Attributes a caller is allowed to set on a gopher. Anything else in the
// request body is ignored, which keeps the write path safe from unexpected input.
const GOPHER_FIELDS = ['name', 'type', 'sex', 'picture', 'status', 'color', 'location', 'comment'];

export const toGopher = (item) => {
  if (!item) return undefined;
  return {
    id: item.id,
    name: item.name,
    location: item.location,
    status: item.status ?? 'unknown',
    timesSeen: item.timesSeen ?? 0,
    ...pickDefined(item, ['type', 'sex', 'picture', 'color', 'comment']),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
};

export const createGopher = async (input) => {
  const id = ulid();
  const now = new Date().toISOString();
  const item = {
    ...gopherKey(id),
    entityType: 'gopher',
    id,
    timesSeen: 0,
    ...pickDefined(input, GOPHER_FIELDS),
    status: input.status ?? 'unknown',
    createdAt: now,
    updatedAt: now,
    GSI1PK: GOPHER_COLLECTION,
    GSI1SK: now,
    // Index the gopher by location (GSI2) so a hole reported at the same spot can
    // find it — the symmetric half of gopher.created finding holes by location.
    GSI2PK: locationKey(input.location),
    GSI2SK: `GOPHER#${id}`
  };

  await transactWriteWithOutbox({
    writes: [{ Put: { Item: item, ConditionExpression: 'attribute_not_exists(pk)' } }],
    events: [domainEvent(DetailType.GopherCreated, id, { id, name: item.name, location: item.location })]
  });

  return toGopher(item);
};

export const getGopher = async (id) => toGopher(await getItem(gopherKey(id)));

export const listGophers = async () => {
  const items = await query({
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :collection',
    ExpressionAttributeValues: { ':collection': GOPHER_COLLECTION }
  });
  return items.map(toGopher);
};

export const updateGopher = (id, patch) => {
  const changedFields = pickDefined(patch, GOPHER_FIELDS);
  const set = { ...changedFields, updatedAt: new Date().toISOString() };
  // Keep the location index in sync whenever the gopher moves.
  if (changedFields.location) set.GSI2PK = locationKey(changedFields.location);

  return assertFound('gopher', id, () =>
    transactWriteWithOutbox({
      writes: [
        {
          Update: {
            Key: gopherKey(id),
            ConditionExpression: 'attribute_exists(pk)',
            ...buildUpdateExpression({ set })
          }
        }
      ],
      events: [domainEvent(DetailType.GopherUpdated, id, { id, changes: Object.keys(changedFields) })]
    })
  );
};

export const deleteGopher = (id) =>
  assertFound('gopher', id, () =>
    transactWriteWithOutbox({
      writes: [{ Delete: { Key: gopherKey(id), ConditionExpression: 'attribute_exists(pk)' } }],
      events: [domainEvent(DetailType.GopherDeleted, id, { id })]
    })
  );

export const addGopherStatus = (id, status) => {
  const statusId = ulid();
  const now = new Date().toISOString();

  return assertFound('gopher', id, () =>
    transactWriteWithOutbox({
      writes: [
        {
          Update: {
            Key: gopherKey(id),
            ConditionExpression: 'attribute_exists(pk)',
            ...buildUpdateExpression({ set: { status, updatedAt: now } })
          }
        },
        {
          Put: {
            Item: { ...gopherStatusKey(id, statusId), entityType: 'gopherStatus', gopherId: id, status, createdAt: now }
          }
        }
      ],
      events: [domainEvent(DetailType.GopherStatusChanged, id, { id, status })]
    })
  );
};

// A gopher's linked holes are stored under its own partition, so this is a
// simple begins_with query with no index needed.
export const getGopherHoles = async (id) => {
  const links = await query({
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :link)',
    ExpressionAttributeValues: { ':pk': gopherKey(id).pk, ':link': LINK_PREFIX }
  });
  return links.map((link) => ({ id: link.holeId, description: link.description, status: link.status }));
};

// Gophers seen at a physical location (GSI2). Used by the choreography consumer
// so a newly reported hole can link the gophers already known at its spot.
export const findGophersAtLocation = async (location) => {
  const locationPk = locationKey(location);
  if (!locationPk) return [];
  const items = await query({
    IndexName: GSI2,
    KeyConditionExpression: 'GSI2PK = :location AND begins_with(GSI2SK, :prefix)',
    ExpressionAttributeValues: { ':location': locationPk, ':prefix': 'GOPHER#' }
  });
  return items.map(toGopher);
};
