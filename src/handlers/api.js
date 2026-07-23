import middy from '@middy/core';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { Router, HttpStatusCodes, NotFoundError } from '@aws-lambda-powertools/event-handler/http';
import { cors } from '@aws-lambda-powertools/event-handler/http/middleware';
import { metrics as metricsMiddleware } from '@aws-lambda-powertools/event-handler/http/middleware/metrics';
import { tracer as tracerMiddleware } from '@aws-lambda-powertools/event-handler/http/middleware/tracer';
import { MetricUnit } from '@aws-lambda-powertools/metrics';

import { logger, metrics, tracer } from '../lib/powertools.js';
import { withIdempotency } from '../lib/idempotency.js';
import {
  parseBody,
  validateNewGopher,
  validateGopherPatch,
  validateGopherStatus,
  validateNewHole,
  validateHolePatch,
  validateHoleStatus
} from '../lib/validation.js';
import * as gophers from '../lib/repository/gophers.js';
import * as holes from '../lib/repository/holes.js';

const app = new Router({ logger });
app.use(cors({ origin: '*', allowHeaders: ['Content-Type', 'x-api-key', 'Idempotency-Key'] }));
app.use(metricsMiddleware(metrics));
app.use(tracerMiddleware(tracer));

// Idempotent variants of the create paths. See src/lib/idempotency.js.
const createGopherIdempotent = withIdempotency(gophers.createGopher);
const createHoleIdempotent = withIdempotency(holes.createHole);

const json = (statusCode, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' }
  });

const idempotencyKey = (reqCtx) => reqCtx.event.headers?.['Idempotency-Key'] ?? reqCtx.event.headers?.['idempotency-key'];
const queryParam = (reqCtx, name) => reqCtx.event.queryStringParameters?.[name];

// ------------------------------- Gophers -----------------------------------

app.post('/gophers', async (reqCtx) => {
  const gopher = parseBody(reqCtx.event.body);
  validateNewGopher(gopher);
  const created = await createGopherIdempotent({ idempotencyKey: idempotencyKey(reqCtx), payload: gopher });
  metrics.addMetric('GopherCreated', MetricUnit.Count, 1);
  return json(HttpStatusCodes.CREATED, { id: created.id });
});

app.get('/gophers', async () => gophers.listGophers());

app.get('/gophers/:gopherId', async (reqCtx) => {
  const { gopherId } = reqCtx.params;
  const gopher = await gophers.getGopher(gopherId);
  if (!gopher) throw new NotFoundError('A gopher with the provided id could not be found.');
  if (queryParam(reqCtx, 'include')?.toLowerCase() === 'holes') {
    gopher.holes = await gophers.getGopherHoles(gopherId);
  }
  return gopher;
});

app.patch('/gophers/:gopherId', async (reqCtx) => {
  const patch = parseBody(reqCtx.event.body);
  validateGopherPatch(patch);
  await guardNotFound(() => gophers.updateGopher(reqCtx.params.gopherId, patch), 'gopher');
  return json(HttpStatusCodes.NO_CONTENT);
});

app.delete('/gophers/:gopherId', async (reqCtx) => {
  await guardNotFound(() => gophers.deleteGopher(reqCtx.params.gopherId), 'gopher');
  return json(HttpStatusCodes.NO_CONTENT);
});

app.post('/gophers/:gopherId/statuses', async (reqCtx) => {
  const body = parseBody(reqCtx.event.body);
  validateGopherStatus(body);
  await guardNotFound(() => gophers.addGopherStatus(reqCtx.params.gopherId, body.status), 'gopher');
  return json(HttpStatusCodes.NO_CONTENT);
});

// -------------------------------- Holes ------------------------------------

app.post('/holes', async (reqCtx) => {
  const hole = parseBody(reqCtx.event.body);
  validateNewHole(hole);
  const created = await createHoleIdempotent({ idempotencyKey: idempotencyKey(reqCtx), payload: hole });
  metrics.addMetric('HoleCreated', MetricUnit.Count, 1);
  return json(HttpStatusCodes.CREATED, { id: created.id });
});

app.get('/holes', async (reqCtx) => holes.listHoles(queryParam(reqCtx, 'status')));

app.get('/holes/:holeId', async (reqCtx) => {
  const hole = await holes.getHole(reqCtx.params.holeId);
  if (!hole) throw new NotFoundError('A hole with the provided id could not be found.');
  if (queryParam(reqCtx, 'include')?.toLowerCase() === 'gopher' && hole.gopherId) {
    const gopher = await gophers.getGopher(hole.gopherId);
    if (gopher) hole.gopher = { id: gopher.id, name: gopher.name };
  }
  return hole;
});

app.put('/holes/:holeId', async (reqCtx) => {
  const hole = parseBody(reqCtx.event.body);
  validateNewHole(hole);
  await guardNotFound(() => holes.updateHole(reqCtx.params.holeId, hole, { replace: true }), 'hole');
  return json(HttpStatusCodes.NO_CONTENT);
});

app.patch('/holes/:holeId', async (reqCtx) => {
  const patch = parseBody(reqCtx.event.body);
  validateHolePatch(patch);
  await guardNotFound(() => holes.updateHole(reqCtx.params.holeId, patch), 'hole');
  return json(HttpStatusCodes.NO_CONTENT);
});

app.post('/holes/:holeId/statuses', async (reqCtx) => {
  const body = parseBody(reqCtx.event.body);
  validateHoleStatus(body);
  await guardNotFound(() => holes.updateHoleStatus(reqCtx.params.holeId, body.status), 'hole');
  return json(HttpStatusCodes.NO_CONTENT);
});

// A conditional write against a missing item surfaces as a transaction
// cancellation; translate that into a clean 404 for the caller.
const guardNotFound = async (operation, entity) => {
  try {
    return await operation();
  } catch (err) {
    if (isConditionalCheckFailure(err)) {
      throw new NotFoundError(`A ${entity} with the provided id could not be found.`);
    }
    throw err;
  }
};

const isConditionalCheckFailure = (err) =>
  err?.name === 'ConditionalCheckFailedException' ||
  err?.name === 'TransactionCanceledException' ||
  err?.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed');

export const handler = middy(async (event, context) => app.resolve(event, context)).use(
  injectLambdaContext(logger, { clearState: true })
);
