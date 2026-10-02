import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Response = APIGatewayProxyStructuredResultV2;
type Db = Pick<DynamoDBDocumentClient, 'send'>;

const tableName = process.env.TABLE_NAME ?? '';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const json = (statusCode: number, body: unknown): Response => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function registrationKey(principalId: string, sessionId: string): string {
  const input = `${principalId.length}:${principalId}:${sessionId}`;
  return `REG#${createHash('sha256').update(input).digest('hex')}`;
}

function sessionIdFrom(event: Event): string | undefined {
  const id = event.pathParameters?.sessionId;
  return typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id) ? id : undefined;
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

export function createHandler(store: Db = db) {
  return async (event: Event, context: Context): Promise<Response> => {
    const started = performance.now();
    const principalId = event.requestContext.authorizer?.jwt?.claims?.sub;
    const requestId = event.requestContext.requestId || context.awsRequestId;
    const method = event.requestContext.http.method;
    const route = event.routeKey;
    const sessionId = sessionIdFrom(event);
    let tool = 'unknown';
    let result = 'error';

    try {
      if (typeof principalId !== 'string' || !principalId) {
        result = 'unauthorized';
        return json(401, { error: result });
      }
      if (!tableName) throw new Error('TABLE_NAME is required');

      if (method === 'GET' && route === 'GET /sessions') {
        tool = 'listSessions';
        const items = await store.send(new ScanCommand({
          TableName: tableName,
          FilterExpression: 'begins_with(pk, :prefix)',
          ExpressionAttributeValues: { ':prefix': 'SESSION#' },
        }));
        result = 'ok';
        return json(200, { sessions: (items.Items ?? []).map(({ sessionId, title, description, kind }) => ({ sessionId, title, description, kind })) });
      }

      if (method === 'GET' && route === 'GET /sessions/{sessionId}') {
        tool = 'getSession';
        if (!sessionId) return json(400, { error: result = 'invalid_session_id' });
        const item = await store.send(new GetCommand({ TableName: tableName, Key: { pk: `SESSION#${sessionId}`, sk: 'META' } }));
        if (!item.Item) return json(404, { error: result = 'session_not_found' });
        const { title, description, kind } = item.Item;
        result = 'ok';
        return json(200, { session: { sessionId, title, description, kind } });
      }

      if (method === 'GET' && route === 'GET /registrations') {
        tool = 'myRegistrations';
        const items = await store.send(new QueryCommand({
          TableName: tableName,
          IndexName: 'ByUser',
          KeyConditionExpression: 'gsi1pk = :user',
          ExpressionAttributeValues: { ':user': `USER#${principalId}` },
        }));
        result = 'ok';
        return json(200, { registrations: (items.Items ?? []).map(({ sessionId, registeredAt }) => ({ sessionId, registeredAt })) });
      }

      if (method === 'POST' && route === 'POST /registrations/{sessionId}') {
        tool = 'registerForSession';
        if (!sessionId) return json(400, { error: result = 'invalid_session_id' });
        if (event.body && event.body.trim() !== '{}' ) return json(400, { error: result = 'unexpected_body' });
        const session = await store.send(new GetCommand({ TableName: tableName, Key: { pk: `SESSION#${sessionId}`, sk: 'META' } }));
        if (!session.Item) return json(404, { error: result = 'session_not_found' });
        try {
          await store.send(new PutCommand({
            TableName: tableName,
            Item: {
              pk: registrationKey(principalId, sessionId),
              sk: 'META',
              gsi1pk: `USER#${principalId}`,
              gsi1sk: `SESSION#${sessionId}`,
              sessionId,
              registeredAt: new Date().toISOString(),
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          }));
          result = 'registered';
          return json(201, { status: result });
        } catch (error) {
          if (!isConditionalFailure(error)) throw error;
          result = 'already_registered';
          return json(200, { status: result });
        }
      }

      if (method === 'DELETE' && route === 'DELETE /registrations/{sessionId}') {
        tool = 'cancelRegistration';
        if (!sessionId) return json(400, { error: result = 'invalid_session_id' });
        if (event.body && event.body.trim() !== '{}' ) return json(400, { error: result = 'unexpected_body' });
        try {
          await store.send(new DeleteCommand({
            TableName: tableName,
            Key: { pk: registrationKey(principalId, sessionId), sk: 'META' },
            ConditionExpression: 'attribute_exists(pk)',
          }));
          result = 'cancelled';
          return json(200, { status: result });
        } catch (error) {
          if (!isConditionalFailure(error)) throw error;
          result = 'not_registered';
          return json(200, { status: result });
        }
      }

      result = 'not_found';
      return json(404, { error: result });
    } catch (error) {
      console.error(JSON.stringify({ requestId, error: error instanceof Error ? error.message : String(error) }));
      result = 'internal_error';
      return json(500, { error: result });
    } finally {
      console.log(JSON.stringify({ requestId, principalId: typeof principalId === 'string' ? principalId : null, tool, sessionId: sessionId ?? null, result, latencyMs: Math.round(performance.now() - started) }));
    }
  };
}

export const handler = createHandler();
