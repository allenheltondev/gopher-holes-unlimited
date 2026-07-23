import { BadRequestError } from '@aws-lambda-powertools/event-handler/http';

// Deliberately tiny, dependency-free validation helpers. A production service
// would likely reach for a Standard Schema library (Zod, Valibot) and plug it
// into the Router's built-in `validation` option, but hand-rolled checks keep
// this teaching example easy to follow.

const GOPHER_TYPES = ['Western Pocket', 'Eastern Pocket', 'Geomys'];
const GOPHER_SEXES = ['male', 'female', 'no preference', 'unknown'];
const GOPHER_STATUSES = ['at large', 'trapped', 'deceased', 'unknown'];
const HOLE_STATUSES = ['filled', 'visible'];

const fail = (message) => {
  throw new BadRequestError(message);
};

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const validateLocation = (location) => {
  if (!location || typeof location !== 'object') fail('A location is required.');
  const hasCoordinates = isNonEmptyString(location.latitude) && isNonEmptyString(location.longitude);
  const hasAddress = isNonEmptyString(location.city) && isNonEmptyString(location.state);
  if (!hasCoordinates && !hasAddress) {
    fail('A location must include either latitude/longitude or city/state.');
  }
};

const validateEnum = (value, allowed, field) => {
  if (value !== undefined && !allowed.includes(value)) {
    fail(`'${field}' must be one of: ${allowed.join(', ')}.`);
  }
};

export const parseBody = (raw) => {
  if (!raw) fail('A request body is required.');
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    fail('The request body must be valid JSON.');
  }
};

export const validateNewGopher = (gopher) => {
  if (!isNonEmptyString(gopher.name)) fail("'name' is required.");
  validateLocation(gopher.location);
  validateEnum(gopher.type, GOPHER_TYPES, 'type');
  validateEnum(gopher.sex, GOPHER_SEXES, 'sex');
  validateEnum(gopher.status, GOPHER_STATUSES, 'status');
};

export const validateGopherPatch = (patch) => {
  if (Object.keys(patch).length === 0) fail('At least one field must be provided.');
  if (patch.name !== undefined && !isNonEmptyString(patch.name)) fail("'name' cannot be empty.");
  if (patch.location !== undefined) validateLocation(patch.location);
  validateEnum(patch.type, GOPHER_TYPES, 'type');
  validateEnum(patch.sex, GOPHER_SEXES, 'sex');
  validateEnum(patch.status, GOPHER_STATUSES, 'status');
};

export const validateGopherStatus = (body) => {
  if (!isNonEmptyString(body.status)) fail("'status' is required.");
  validateEnum(body.status, GOPHER_STATUSES, 'status');
};

export const validateNewHole = (hole) => {
  if (!isNonEmptyString(hole.description)) fail("'description' is required.");
  validateLocation(hole.location);
  validateEnum(hole.status, HOLE_STATUSES, 'status');
};

export const validateHolePatch = (patch) => {
  if (Object.keys(patch).length === 0) fail('At least one field must be provided.');
  if (patch.description !== undefined && !isNonEmptyString(patch.description)) fail("'description' cannot be empty.");
  if (patch.location !== undefined) validateLocation(patch.location);
  validateEnum(patch.status, HOLE_STATUSES, 'status');
};

export const validateHoleStatus = (body) => {
  if (!isNonEmptyString(body.status)) fail("'status' is required.");
  validateEnum(body.status, HOLE_STATUSES, 'status');
};
