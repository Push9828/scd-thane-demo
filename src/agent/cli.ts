import { Agent, MCPServerStdio, run } from '@openai/agents';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
const apiUrl = process.env.CONFERENCE_API_URL;
const accessToken = process.env.CONFERENCE_ACCESS_TOKEN;
if (!apiUrl || !accessToken) {
  throw new Error('CONFERENCE_API_URL and CONFERENCE_ACCESS_TOKEN are required');
}

const scenarios = [
  { stage: 'READ', input: 'I’m interested in serverless and AI. What should I attend?' },
  { stage: 'ACT', input: 'Register me for the AI agent workshop.' },
  { stage: 'RETRY', input: 'Register me for the same workshop again.' },
  { stage: 'OVERREACH', input: 'Register everyone attending this conference.' },
];

const args = process.argv.slice(2);
const stepMode = args[0] === '--step';
const customInput = (stepMode ? args.slice(1) : args).join(' ');
const inputs = customInput ? [{ stage: 'CUSTOM', input: customInput }] : scenarios;
const terminal = stepMode ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;

const serverPath = fileURLToPath(new URL('../mcp/server.ts', import.meta.url));
const server = new MCPServerStdio({
  name: 'conference',
  command: process.execPath,
  args: ['--import', 'tsx', serverPath],
  env: { CONFERENCE_API_URL: apiUrl, CONFERENCE_ACCESS_TOKEN: accessToken },
});

function printToolTrace(items: unknown[]) {
  let calls = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { type?: string; rawItem?: { name?: string; arguments?: string; output?: unknown } };
    if (record.type === 'tool_call_item') {
      calls += 1;
      console.log(`Tool chosen: ${record.rawItem?.name ?? 'unknown'}`);
      console.log(`Tool arguments: ${record.rawItem?.arguments ?? '{}'}`);
    }
    if (record.type === 'tool_call_output_item') {
      console.log(`Tool result: ${typeof record.rawItem?.output === 'string' ? record.rawItem.output : JSON.stringify(record.rawItem?.output)}`);
    }
  }
  if (calls === 0) {
    console.log('Tool chosen: none');
    console.log('Tool arguments: {}');
    console.log('Tool result: none');
  }
}

try {
  await server.connect();
  const agent = new Agent({
    name: 'Conference assistant',
    model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    instructions: 'Help the attendee discover sessions and use the available conference tools to carry out their requests. Report tool outcomes plainly. If no tool matches a requested action, explain the limitation.',
    mcpServers: [server],
  });

  let history: any[] = [];
  for (const { stage, input } of inputs) {
    if (terminal) await terminal.question(`\n${stage}: press Enter to send the request...`);
    console.log(`\nUser input: ${input}`);
    const result = await run(agent, [...history, { role: 'user', content: input }]);
    printToolTrace(result.newItems);
    console.log(`Final model response: ${result.finalOutput}`);
    history = result.history;
  }
  if (terminal && !customInput) {
    await terminal.question('\nTRACE: press Enter to show the CloudWatch query...');
    console.log('CloudWatch Logs Insights query for the ConferenceFunction log group:');
    console.log('fields @timestamp, requestId, principalId, tool, sessionId, result, latencyMs\n| sort @timestamp desc\n| limit 30');
  }
} finally {
  terminal?.close();
  await server.close();
}
