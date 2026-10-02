import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error('TABLE_NAME is required');

const sessions = [
  { sessionId: 'serverless-ai', title: 'Serverless + AI', description: 'Patterns for adding AI capabilities to serverless applications.', kind: 'talk' },
  { sessionId: 'building-agents-aws', title: 'Building Agents on AWS', description: 'An AI agent workshop using tools and AWS services.', kind: 'workshop' },
  { sessionId: 'lambda-deep-dive', title: 'AWS Lambda Deep Dive', description: 'A practical look at Lambda execution and performance.', kind: 'talk' },
  { sessionId: 'serverless-observability', title: 'Observability for Serverless', description: 'Tracing and logs for serverless workloads.', kind: 'talk' },
];

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
for (const session of sessions) {
  await db.send(new PutCommand({ TableName: tableName, Item: { pk: `SESSION#${session.sessionId}`, sk: 'META', ...session } }));
  console.log(`Seeded ${session.title}`);
}
