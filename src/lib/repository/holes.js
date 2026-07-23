import { ulid } from 'ulid';
import { assertFound, buildUpdateExpression, getItem, pickDefined, query, transactWriteWithOutbox } from '../dynamo.js';
import { holeKey, linkKey, GSI1, HOLE_COLLECTION, HOLE_MEMBER_PREFIX, locationKey } from '../keys.js';
import { memberMoveWrites, memberPut } from './members.js';
import { DetailType, domainEvent } from '../events.js';

const HOLE_FIELDS = ['description', 'location', 'status', 'gopherId', 'comment'];
const OPTIONAL_FIELDS = ['gopherId', 'comment'];

const memberSk = (id) => `${HOLE_MEMBER_PREFIX}${id}`;

export const toHole = (item) => {
  if (!item) return undefined;
  return {
    id: item.id,
    description: item.description,
    location: item.location,
    status: item.status ?? 'visible',
    ...pickDefined(item, ['gopherId', 'comment']),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
};

export const createHole = async (input) => {
  const id = ulid();
  const now = new Date().toISOString();
  const item = {
    ...holeKey(id),
    entityType: 'hole',
    id,
    ...pickDefined(input, HOLE_FIELDS),
    status: input.status ?? 'visible',
    createdAt: now,
    updatedAt: now,
    GSI1PK: HOLE_COLLECTION,
    GSI1SK: now
  };

  await transactWriteWithOutbox({
    // Entity + location rendezvous member, committed atomically.
    writes: [
      { Put: { Item: item, ConditionExpression: 'attribute_not_exists(pk)' } },
      memberPut(input.location, memberSk(id), { holeId: id })
    ].filter(Boolean),
    events: [
      domainEvent(DetailType.HoleCreated, id, {
        id,
        description: item.description,
        location: item.location,
        status: item.status,
        gopherId: item.gopherId
      })
    ]
  });

  return toHole(item);
};

export const getHole = async (id, options) => toHole(await getItem(holeKey(id), options));

export const listHoles = async (status) => {
  const items = await query({
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :collection',
    ...(status && {
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' }
    }),
    ExpressionAttributeValues: { ':collection': HOLE_COLLECTION, ...(status && { ':status': status }) }
  });
  return items.map(toHole);
};

export const updateHole = async (id, input, { replace = false } = {}) => {
  const changedFields = pickDefined(input, HOLE_FIELDS);
  const set = { ...changedFields, updatedAt: new Date().toISOString() };

  // A full replace (PUT) clears the optional attributes the caller omitted.
  const remove = replace ? OPTIONAL_FIELDS.filter((field) => changedFields[field] === undefined) : [];

  const events = [domainEvent(DetailType.HoleUpdated, id, { id, changes: Object.keys(changedFields) })];
  if (changedFields.status !== undefined) {
    events.push(domainEvent(DetailType.HoleStatusChanged, id, { id, status: changedFields.status }));
  }

  const writes = [
    { Update: { Key: holeKey(id), ConditionExpression: 'attribute_exists(pk)', ...buildUpdateExpression({ set, remove }) } }
  ];

  // A location change moves the hole's rendezvous membership.
  if (changedFields.location) {
    const current = await getHole(id);
    if (current) writes.push(...memberMoveWrites(current.location, changedFields.location, memberSk(id), { holeId: id }));
  }

  return assertFound('hole', id, () => transactWriteWithOutbox({ writes, events }));
};

export const updateHoleStatus = (id, status) =>
  assertFound('hole', id, () =>
    transactWriteWithOutbox({
      writes: [
        {
          Update: {
            Key: holeKey(id),
            ConditionExpression: 'attribute_exists(pk)',
            ...buildUpdateExpression({ set: { status, updatedAt: new Date().toISOString() } })
          }
        }
      ],
      events: [domainEvent(DetailType.HoleStatusChanged, id, { id, status })]
    })
  );

// ---- Linking (used by the choreography consumer, not the API directly) ----

// Holes at a physical location, via a strongly-consistent read of the location
// partition, then a strongly-consistent read of each hole for its current
// details. A newly reported gopher uses this to link the holes already there.
export const findHolesAtLocation = async (location) => {
  const locationPk = locationKey(location);
  if (!locationPk) return [];
  const members = await query({
    ConsistentRead: true,
    KeyConditionExpression: 'pk = :location AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':location': locationPk, ':prefix': HOLE_MEMBER_PREFIX }
  });
  const holes = await Promise.all(members.map((member) => getHole(member.holeId, { consistentRead: true })));
  return holes.filter(Boolean);
};

export const linkGopherToHole = async ({ gopherId, holeId, description, status }) => {
  const now = new Date().toISOString();
  await transactWriteWithOutbox({
    writes: [
      {
        Put: {
          Item: {
            ...linkKey(gopherId, holeId),
            entityType: 'link',
            gopherId,
            holeId,
            description,
            status: status ?? 'visible',
            createdAt: now,
            GSI1PK: `HOLE#${holeId}`,
            GSI1SK: `GOPHER#${gopherId}`
          },
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      }
    ],
    events: [domainEvent(DetailType.GopherHoleLinked, gopherId, { gopherId, holeId })]
  });
};

// Reverse lookup: every gopher currently linked to a given hole.
export const findLinksForHole = async (holeId) =>
  query({
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `HOLE#${holeId}` }
  });

// Propagate a hole's new status onto the denormalized copies held on each link.
export const syncLinkStatus = async (holeId, status) => {
  const links = await findLinksForHole(holeId);
  await Promise.all(
    links.map((link) =>
      transactWriteWithOutbox({
        writes: [{ Update: { Key: linkKey(link.gopherId, holeId), ...buildUpdateExpression({ set: { status } }) } }]
      })
    )
  );
  return links.length;
};
