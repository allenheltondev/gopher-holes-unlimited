import { locationKey } from '../keys.js';

// Location "rendezvous" membership records. Each gopher and hole writes one of
// these into its location partition (pk = LOCATION#<key>) inside the same
// transaction as the entity itself. Because they live in the base table, the
// choreography consumer can discover counterparties with a STRONGLY-CONSISTENT
// read — so two entities created at the same location at the same time can't
// both miss each other the way eventually-consistent index reads allow.
//
// Members carry only the counterparty id; the linker reads the entity for any
// details it needs, so there is no denormalized data here to keep in sync.

export const memberPut = (location, memberSk, attributes) => {
  const pk = locationKey(location);
  return pk ? { Put: { Item: { pk, sk: memberSk, entityType: 'locationMember', ...attributes } } } : null;
};

export const memberDelete = (location, memberSk) => {
  const pk = locationKey(location);
  return pk ? { Delete: { Key: { pk, sk: memberSk } } } : null;
};

// Transaction ops to move a member from one location to another. Returns an empty
// array when the location key is unchanged — a single transaction may not touch
// the same item twice, and there is nothing to move.
export const memberMoveWrites = (oldLocation, newLocation, memberSk, attributes) => {
  if (locationKey(oldLocation) === locationKey(newLocation)) return [];
  return [memberDelete(oldLocation, memberSk), memberPut(newLocation, memberSk, attributes)].filter(Boolean);
};
