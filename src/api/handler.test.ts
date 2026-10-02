import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, Context } from 'aws-lambda';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

process.env.TABLE_NAME = 'test-table';
const { createHandler } = await import('./handler.js');

function event(routeKey: string, principalId = 'attendee-1', sessionId?: string, body?: string): APIGatewayProxyEventV2WithJWTAuthorizer {
  const [method, routePath] = routeKey.split(' ');
  const path = sessionId ? routePath.replace('{sessionId}', sessionId) : routePath;
  return {
    version: '2.0',
    routeKey,
    rawPath: path,
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    pathParameters: sessionId ? { sessionId } : undefined,
    body,
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      domainName: 'example.execute-api.test.amazonaws.com',
      domainPrefix: 'example',
      requestId: 'request-123',
      routeKey,
      stage: '$default',
      time: '02/Oct/2026:00:00:00 +0000',
      timeEpoch: 0,
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      authorizer: { jwt: { claims: { sub: principalId }, scopes: [] } },
    },
  };
}

const context = { awsRequestId: 'lambda-123' } as Context;

function fakeStore() {
  const records = new Map<string, Record<string, unknown>>([
    ['SESSION#building-agents-aws', { pk: 'SESSION#building-agents-aws', sk: 'META', sessionId: 'building-agents-aws', title: 'Building Agents on AWS' }],
  ]);
  const sent: unknown[] = [];
  return {
    sent,
    async send(command: unknown) {
      sent.push(command);
      if (command instanceof GetCommand) return { Item: records.get(String(command.input.Key?.pk)) };
      if (command instanceof PutCommand) {
        const item = command.input.Item as Record<string, unknown>;
        const key = String(item.pk);
        if (records.has(key)) throw Object.assign(new Error('duplicate'), { name: 'ConditionalCheckFailedException' });
        records.set(key, item);
        return {};
      }
      if (command instanceof DeleteCommand) {
        const key = String(command.input.Key?.pk);
        if (!records.has(key)) throw Object.assign(new Error('missing'), { name: 'ConditionalCheckFailedException' });
        records.delete(key);
        return {};
      }
      if (command instanceof QueryCommand) return { Items: [...records.values()].filter(item => item.gsi1pk === command.input.ExpressionAttributeValues?.[':user']) };
      if (command instanceof ScanCommand) return { Items: [...records.values()].filter(item => String(item.pk).startsWith('SESSION#')) };
      throw new Error('Unexpected command');
    },
  };
}

test('registration is scoped to the JWT principal and duplicate attempts are idempotent', async () => {
  const store = fakeStore();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = line => { logs.push(String(line)); };
  try {
    const handler = createHandler(store as never);
    const first = await handler(event('POST /registrations/{sessionId}', 'attendee-1', 'building-agents-aws'), context);
    const second = await handler(event('POST /registrations/{sessionId}', 'attendee-1', 'building-agents-aws'), context);
    assert.deepEqual(JSON.parse(String(first.body)), { status: 'registered' });
    assert.deepEqual(JSON.parse(String(second.body)), { status: 'already_registered' });
    const write = store.sent.find(command => command instanceof PutCommand) as PutCommand;
    assert.equal(write.input.ConditionExpression, 'attribute_not_exists(pk)');
    assert.match(String(write.input.Item?.pk), /^REG#[a-f0-9]{64}$/);
    assert.equal(write.input.Item?.gsi1pk, 'USER#attendee-1');
    assert.deepEqual(JSON.parse(logs.at(-1)!), {
      requestId: 'request-123', principalId: 'attendee-1', tool: 'registerForSession',
      sessionId: 'building-agents-aws', result: 'already_registered',
      latencyMs: JSON.parse(logs.at(-1)!).latencyMs,
    });
  } finally {
    console.log = originalLog;
  }
});

test('another user gets a different registration key', async () => {
  const store = fakeStore();
  const handler = createHandler(store as never);
  const first = await handler(event('POST /registrations/{sessionId}', 'attendee-1', 'building-agents-aws'), context);
  const other = await handler(event('POST /registrations/{sessionId}', 'attendee-2', 'building-agents-aws'), context);
  assert.equal(JSON.parse(String(first.body)).status, 'registered');
  assert.equal(JSON.parse(String(other.body)).status, 'registered');
  const keys = store.sent.filter(command => command instanceof PutCommand).map(command => (command as PutCommand).input.Item?.pk);
  assert.notEqual(keys[0], keys[1]);
});

test('a caller cannot select another principal in the request body', async () => {
  const store = fakeStore();
  const response = await createHandler(store as never)(event('POST /registrations/{sessionId}', 'attendee-1', 'building-agents-aws', '{"userId":"attendee-2"}'), context);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(String(response.body)), { error: 'unexpected_body' });
  assert.equal(store.sent.length, 0);
});
