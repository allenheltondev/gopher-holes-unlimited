import { ulid } from 'ulid';
import { assertFound, buildUpdateExpression, getItem, pickDefined, query, transactWriteWithOutbox } from '../dynamo.js';
import {
  gopherKey,
  gopherStatusKey,
  GSI1,
  GOPHER_COLLECTION,
  GOPHER_MEMBER_PREFIX,
  LINK_PREFIX,
  locationKey
} from '../keys.js';
import { memberDelete, memberMoveWrites, memberPut } from './members.js';
import { DetailType, domainEvent } from '../events.js';

// Attributes a caller is allowed to set on a gopher. Anything else in the
// request body is ignored, which keeps the write path safe from unexpected input.
const GOPHER_FIELDS = ['name', 'type', 'sex', 'picture', 'status', 'color', 'location', 'comment'];

const memberSk = (id) => `${GOPHER_MEMBER_PREFIX}${id}`;

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
    GSI1SK: now
  };

  await transactWriteWithOutbox({
    // Entity + location rendezvous member, committed atomically.
    writes: [
      { Put: { Item: item, ConditionExpression: 'attribute_not_exists(pk)' } },
      memberPut(input.location, memberSk(id), { gopherId: id })
    ].filter(Boolean),
    events: [domainEvent(DetailType.GopherCreated, id, { id, name: item.name, location: item.location })]
  });

  return toGopher(item);
};

export const getGopher = async (id, options) => toGopher(await getItem(gopherKey(id), options));

export const listGophers = async () => {
  const items = await query({
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :collection',
    ExpressionAttributeValues: { ':collection': GOPHER_COLLECTION }
  });
  return items.map(toGopher);
};

export const updateGopher = async (id, patch) => {
  const changedFields = pickDefined(patch, GOPHER_FIELDS);
  const writes = [
    {
      Update: {
        Key: gopherKey(id),
        ConditionExpression: 'attribute_exists(pk)',
        ...buildUpdateExpression({ set: { ...changedFields, updatedAt: new Date().toISOString() } })
      }
    }
  ];

  // A location change moves the gopher's rendezvous membership. Read the current
  // location so we know which member to remove.
  if (changedFields.location) {
    const current = await getGopher(id);
    if (current) writes.push(...memberMoveWrites(current.location, changedFields.location, memberSk(id), { gopherId: id }));
  }

  return assertFound('gopher', id, () =>
    transactWriteWithOutbox({
      writes,
      events: [domainEvent(DetailType.GopherUpdated, id, { id, changes: Object.keys(changedFields) })]
    })
  );
};

export const deleteGopher = async (id) => {
  const current = await getGopher(id);
  const writes = [{ Delete: { Key: gopherKey(id), ConditionExpression: 'attribute_exists(pk)' } }];
  if (current) {
    const member = memberDelete(current.location, memberSk(id));
    if (member) writes.push(member);
  }

  return assertFound('gopher', id, () =>
    transactWriteWithOutbox({ writes, events: [domainEvent(DetailType.GopherDeleted, id, { id })] })
  );
};

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

// Gophers seen at a physical location, via a strongly-consistent read of the
// location partition. Used by the choreography consumer so a newly reported hole
// can link the gophers already known at its spot.
export const findGophersAtLocation = async (location) => {
  const locationPk = locationKey(location);
  if (!locationPk) return [];
  const members = await query({
    ConsistentRead: true,
    KeyConditionExpression: 'pk = :location AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':location': locationPk, ':prefix': GOPHER_MEMBER_PREFIX }
  });
  return members.map((member) => ({ id: member.gopherId }));
};
