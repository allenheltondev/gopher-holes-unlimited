// Single-table key helpers. Every access pattern in the service goes through
// these functions so the key design stays consistent and greppable.
//
// Access patterns:
//   Gopher item            pk=GOPHER#<id>  sk=GOPHER#<id>   (GSI1PK=GOPHER,        GSI1SK=<createdAt>)
//   Gopher status history   pk=GOPHER#<id>  sk=STATUS#<ulid>
//   Hole item               pk=HOLE#<id>    sk=HOLE#<id>     (GSI1PK=HOLE,          GSI1SK=<createdAt>)
//                                                            (GSI2PK=LOCATION#<key> GSI2SK=HOLE#<id>)
//   Gopher -> Hole link     pk=GOPHER#<id>  sk=LINK#HOLE#<holeId>

export const gopherKey = (id) => ({ pk: `GOPHER#${id}`, sk: `GOPHER#${id}` });
export const gopherStatusKey = (id, statusId) => ({ pk: `GOPHER#${id}`, sk: `STATUS#${statusId}` });
export const holeKey = (id) => ({ pk: `HOLE#${id}`, sk: `HOLE#${id}` });
export const linkKey = (gopherId, holeId) => ({ pk: `GOPHER#${gopherId}`, sk: `LINK#HOLE#${holeId}` });

export const GSI1 = 'GSI1';
export const GSI2 = 'GSI2';

export const GOPHER_COLLECTION = 'GOPHER';
export const HOLE_COLLECTION = 'HOLE';

export const LINK_PREFIX = 'LINK#HOLE#';

// Holes are indexed by physical location so a newly created gopher can discover
// the holes that already exist where it was spotted. Coordinates win when
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
