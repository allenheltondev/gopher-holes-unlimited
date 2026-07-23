import { test } from 'node:test';
import assert from 'node:assert/strict';

// Configure the environment the handler modules read at import time.
process.env.TABLE_NAME = 'test-table';
process.env.IDEMPOTENCY_TABLE_NAME = 'test-idempotency';
process.env.EVENT_BUS_NAME = 'test-bus';
process.env.POWERTOOLS_SERVICE_NAME = 'ghu-test';
process.env.POWERTOOLS_METRICS_NAMESPACE = 'ghu-test';
process.env.AWS_REGION = 'us-east-1';

const { handler } = await import('../src/handlers/api.js');

const context = {
  awsRequestId: 'test-request',
  functionName: 'api',
  getRemainingTimeInMillis: () => 1000
};

const proxyEvent = ({ method, path, body }) => ({
  httpMethod: method,
  path,
  resource: path,
  headers: { 'Content-Type': 'application/json' },
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  stageVariables: null,
  pathParameters: null,
  body: body ? JSON.stringify(body) : null,
  isBase64Encoded: false,
  requestContext: {
    requestId: 'test-request',
    httpMethod: method,
    path,
    stage: 'test',
    identity: { sourceIp: '127.0.0.1', userAgent: 'node-test' }
  }
});

test('POST /gophers returns 400 when the body is invalid', async () => {
  const response = await handler(proxyEvent({ method: 'POST', path: '/gophers', body: { color: 'brown' } }), context);
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).message ?? JSON.parse(response.body).error ?? '', /name|required/i);
});

test('unknown routes resolve to 404', async () => {
  const response = await handler(proxyEvent({ method: 'GET', path: '/unicorns' }), context);
  assert.equal(response.statusCode, 404);
});
