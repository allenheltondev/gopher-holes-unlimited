// Domain-level errors, free of any HTTP or persistence detail. The API layer
// decides how to represent these to callers (see the Router error handler in
// src/handlers/api.js); the repositories decide when to raise them.
export class EntityNotFoundError extends Error {
  constructor(entity, id) {
    super(`A ${entity} with the provided id could not be found.`);
    this.name = 'EntityNotFoundError';
    this.entity = entity;
    this.id = id;
  }
}
