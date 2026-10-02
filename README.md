# Conference agent demo

A small TypeScript demo for an AWS conference talk. The OpenAI Agents SDK runs one agent. Its five local MCP tools call an HTTPS API; only Lambda reads or writes DynamoDB.

```text
CLI + OpenAI Agents SDK
         ↓ MCP over stdio
Local MCP server
         ↓ HTTPS + attendee JWT
Amazon API Gateway (JWT authorizer)
         ↓
AWS Lambda (validation, user scoping, JSON logs)
         ↓
DynamoDB
```

## Project layout

```text
src/agent/cli.ts       Agent, four demo prompts, visible tool trace
src/agent/get-token.ts Local Cognito sign-in with authorization code + PKCE
src/mcp/server.ts      Five MCP tools backed by HTTP requests
src/api/handler.ts     Lambda routes, validation, DynamoDB writes, JSON logs
src/api/handler.test.ts Focused retry and identity tests
src/seed.ts            Four sample sessions
template.yaml          API Gateway, Lambda, DynamoDB, JWT authorizer
.env.example          Values to fill in for deployment, seeding, and the CLI
```

## Get the demo values with Amazon Cognito

Start with `cp .env.example .env`. The real `.env` is ignored by Git.

1. In one AWS Region, create a Cognito **user pool** and a **single-page application** app client. Use a public client without a client secret. Enable managed login, the authorization code grant, and the callback URL `http://localhost:8765/callback`.
2. Under the user pool's **Branding → Domain → Resource servers**, create a resource server with identifier `conference` and a custom scope named `attend`. The full scope is `conference/attend`. Under **Applications → App clients → Login pages**, enable that custom scope for the app client.
3. Create a demo attendee in the user pool and set a permanent password so the first sign-in does not require a password-change challenge.
4. In `.env`, set `AWS_REGION` to the pool's Region, `COGNITO_DOMAIN` to the full managed-login domain URL, and `COGNITO_CLIENT_ID` to the app client ID. The issuer and managed-login domain are different URLs.
5. Load `.env` into your shell and run `npm run token`. Open the printed URL and sign in as the demo attendee. Copy the printed `CONFERENCE_ACCESS_TOKEN`, `JWT_ISSUER`, and `JWT_AUDIENCE` values into `.env`. The helper reads issuer and audience from the returned access token. Tokens expire; repeat this step if the API starts returning 401.

```bash
npm install
set -a
source .env
set +a
npm run token
```

The token helper uses an authorization code with PKCE and listens only on `localhost:8765` for the callback. It prints the access token in your terminal and does not write it to disk. Cognito access tokens obtained this way contain the requested custom scope. See [Cognito resource servers](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html) and [PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html).

## Deploy

You need Node.js 22+, AWS credentials with deployment rights, AWS SAM CLI, and an OIDC issuer that supplies attendee JWT **access tokens** with audience matching `JwtAudience` and scope `conference/attend`. The JWT's `sub` is the attendee identity. The API does not accept a user ID from the model or request body.

```bash
npm test
npm run build
sam build
sam deploy --guided
```

Provide the `.env` values `JWT_ISSUER` and `JWT_AUDIENCE` as `JwtIssuer` and `JwtAudience` when SAM prompts you; SAM does not load `.env` automatically. Get `ApiUrl` and `TableName` from the stack outputs, place them in `.env` as `CONFERENCE_API_URL` and `TABLE_NAME`, then reload the file and seed the sessions:

```bash
set -a
source .env
set +a
npm run seed
```

The seed includes **Serverless + AI**, **Building Agents on AWS** (the AI agent workshop), **AWS Lambda Deep Dive**, and **Observability for Serverless**.

## Run the talk demo

```bash
npm run demo
```

The CLI runs READ, ACT, RETRY, and OVERREACH in one conversation. It prints user input, tool choice, arguments, result, and final model response for each turn. You can run one custom request with `npm run demo -- "What am I registered for?"`. `OPENAI_MODEL` optionally selects another Agents SDK model.

The ACT turn registers the JWT's `sub` for `building-agents-aws`. RETRY returns exactly `{ "status": "already_registered" }` from Lambda after DynamoDB rejects the duplicate conditional write. The OVERREACH request has no bulk registration tool. Even a direct HTTP request with a `userId` field is rejected; all writes derive the user from the verified JWT claim.

The local MCP server owns the bearer token and calls API Gateway. The OpenAI model sees tool names, arguments, and results, but it cannot send a user ID to the API. Use a dedicated demo attendee token and avoid sharing it in slides or logs.

## Trace in CloudWatch

Lambda emits one JSON line per API request with `requestId`, `principalId`, `tool`, `sessionId`, `result`, and `latencyMs`. In CloudWatch Logs Insights, select the `ConferenceFunction` log group and run:

```sql
fields @timestamp, requestId, principalId, tool, sessionId, result, latencyMs
| sort @timestamp desc
| limit 50
```

Filter to one attendee with `| filter principalId = "<JWT sub>"`. The registration and retry should show `registered` followed by `already_registered` for the same session. The overreach request should produce no registration log unless the model chooses a valid single-session tool; Lambda still scopes that write to the JWT principal.

## Backend rules

- All five API routes require API Gateway JWT authorization and the `conference/attend` scope.
- Lambda validates session IDs, requires an existing session for registration, and rejects unexpected request bodies on write routes.
- The registration primary key is a SHA-256 hash of the JWT user plus session ID. `PutCommand` uses `attribute_not_exists(pk)` so concurrent repeats cannot create duplicates.
- A `ByUser` DynamoDB index serves `myRegistrations`; cancellation deletes only the signed-in user's deterministic registration key.
- Session scanning is intentionally simple for this four-session demo.
