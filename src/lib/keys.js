// Single-table key helpers. Every access pattern in the service goes through
// these functions so the key design stays consistent and greppable.
//
// Access patterns:
//   Gopher item            pk=GOPHER#<id>     sk=GOPHER#<id>       (GSI1PK=GOPHER, GSI1SK=<createdAt>)
//   Gopher status history   pk=GOPHER#<id>     sk=STATUS#<ulid>
//   Hole item               pk=HOLE#<id>       sk=HOLE#<id>         (GSI1PK=HOLE,   GSI1SK=<createdAt>)
//   Gopher -> Hole link     pk=GOPHER#<id>     sk=LINK#HOLE#<holeId> (GSI1PK=HOLE#<holeId>, GSI1SK=GOPHER#<id>)
//   Location rendezvous     pk=LOCATION#<key>  sk=GOPHER#<id> | HOLE#<id>
//
// The location rendezvous items let a gopher and a hole at the same place find
// each other with a STRONGLY-CONSISTENT base-table read, instead of an
// eventually-consistent secondary index — closing the window where two entities
// created at once could each miss the other.

export const gopherKey = (id) => ({ pk: `GOPHER#${id}`, sk: `GOPHER#${id}` });
export const gopherStatusKey = (id, statusId) => ({ pk: `GOPHER#${id}`, sk: `STATUS#${statusId}` });
export const holeKey = (id) => ({ pk: `HOLE#${id}`, sk: `HOLE#${id}` });
export const linkKey = (gopherId, holeId) => ({ pk: `GOPHER#${gopherId}`, sk: `LINK#HOLE#${holeId}` });

export const GSI1 = 'GSI1';

export const GOPHER_COLLECTION = 'GOPHER';
export const HOLE_COLLECTION = 'HOLE';

export const LINK_PREFIX = 'LINK#HOLE#';
export const GOPHER_MEMBER_PREFIX = 'GOPHER#';
export const HOLE_MEMBER_PREFIX = 'HOLE#';

// A gopher/hole's membership record in its location partition. `memberSk` is
// `GOPHER#<id>` or `HOLE#<id>`. Returns undefined when the location has no
// resolvable key, so callers can skip writing an unindexable member.
export const locationMemberKey = (location, memberSk) => {
  const pk = locationKey(location);
  return pk ? { pk, sk: memberSk } : undefined;
};

// Physical location, normalized into a partition key. Coordinates win when
// present; otherwise we fall back to a normalized street address.
export const locationKey = (location = {}) => {
  if (location.latitude && location.longitude) {
    return `LOCATION#${location.latitude}#${location.longitude}`;
  }
  const parts = [location.addressLine1, location.city, location.state]
    .filter(Boolean)
    .map((part) => part.trim().toLowerCase());
  return parts.length ? `LOCATION#${parts.join('#')}` : undefined;
};
