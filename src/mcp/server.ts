import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const baseUrl = process.env.CONFERENCE_API_URL?.replace(/\/$/, '');
const token = process.env.CONFERENCE_ACCESS_TOKEN;
if (!baseUrl || !token) throw new Error('CONFERENCE_API_URL and CONFERENCE_ACCESS_TOKEN are required');

async function request(method: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const body: unknown = await response.json();
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    isError: !response.ok,
  };
}

const server = new McpServer({ name: 'conference-tools', version: '1.0.0' });
server.tool('listSessions', 'List the conference sessions.', {}, async () => request('GET', '/sessions'));
server.tool('getSession', 'Get details for one conference session.', { sessionId: z.string() }, async ({ sessionId }) => request('GET', `/sessions/${encodeURIComponent(sessionId)}`));
server.tool('registerForSession', 'Register the signed-in user for one session.', { sessionId: z.string() }, async ({ sessionId }) => request('POST', `/registrations/${encodeURIComponent(sessionId)}`));
server.tool('myRegistrations', 'List the signed-in user’s registrations.', {}, async () => request('GET', '/registrations'));
server.tool('cancelRegistration', 'Cancel the signed-in user’s registration for one session.', { sessionId: z.string() }, async ({ sessionId }) => request('DELETE', `/registrations/${encodeURIComponent(sessionId)}`));

await server.connect(new StdioServerTransport());
