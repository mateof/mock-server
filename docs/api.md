# HTTP API

Mock Server has a versioned HTTP API under `/api/v1` so another application can
drive it: create routes, switch one set of mocks on and another off before each
test case, and then ask what was actually called.

It is the same set of operations the panel and the MCP server use, so anything
you can do by hand you can do from a script, and the other way round.

Open the **API** screen in the top bar (or go to `/api-docs`) for the whole
contract with a "Try it out" button on every operation. The page reads the
contract from the server itself, so it always describes the instance you are
looking at.

## Why it exists

A mock server earns its keep when the mocks change between test cases: the happy
path for one, a 503 for the next, a slow backend for the third. Doing that by
hand means a human in the middle of every run.

The loop this API is built for:

1. Create both variants of the endpoint, once, and tag them.
2. Before each case, activate the tag you want with `exclusive: true`. The chosen
   mocks come up and the ones competing for the same request go down.
3. Run the test.
4. Ask `POST /verify/calls` what arrived and assert on the answer.
5. Reset the stateful routes with `POST /scenarios/reset`.

## Quick start

```bash
# Create the two variants of the same endpoint
curl -X POST http://localhost:3880/api/v1/routes \
  -H 'Content-Type: application/json' \
  -d '{
    "method": "get",
    "path": "/fake-api/orders",
    "status_code": "200",
    "response_type": "json",
    "response": "{\"state\":\"paid\"}",
    "tags": [{ "name": "checkout-ok" }]
  }'

curl -X POST http://localhost:3880/api/v1/routes \
  -H 'Content-Type: application/json' \
  -d '{
    "method": "get",
    "path": "/fake-api/orders",
    "status_code": "503",
    "response_type": "json",
    "response": "{\"state\":\"down\"}",
    "active": false,
    "tags": [{ "name": "checkout-down" }]
  }'

# Switch to the failure variant: the other one goes down on its own
curl -X POST http://localhost:3880/api/v1/routes/activate \
  -H 'Content-Type: application/json' \
  -d '{ "tag": "checkout-down", "exclusive": true }'

curl -i http://localhost:3880/fake-api/orders        # 503

# And back
curl -X POST http://localhost:3880/api/v1/routes/activate \
  -H 'Content-Type: application/json' \
  -d '{ "tag": "checkout-ok", "exclusive": true }'
```

## Selectors: addressing routes without knowing ids

Every bulk operation (`activate`, `deactivate`, `delete`, `tags`) takes the same
selector. Filters combine with AND, and at least one is required: an operation
with no selector would hit every route, which is never what a script means.

| Field | Matches |
|-------|---------|
| `ids` | These route ids |
| `tag` | Routes carrying this tag (by name or id) |
| `method` | Routes with this HTTP method |
| `path` | Routes with exactly this path |
| `path_contains` | Routes whose path contains this text |
| `response_type` | Routes of this type (`json`, `proxy`, `graphql`...) |
| `search` | Free text over path, summary, operationId and documentation |

A script that created its mocks with a tag never needs to learn the numeric ids
the database assigned:

```bash
# Everything tagged payments goes down; traffic falls through to the proxy again
curl -X POST http://localhost:3880/api/v1/routes/deactivate \
  -H 'Content-Type: application/json' \
  -d '{ "tag": "payments" }'
```

### What `exclusive` does

Without it, activating a mock leaves any other mock for the same request active
too, and the one with the lowest order wins. That is fine when you know the
order and confusing when you do not.

With `exclusive: true`, activating a set also **disables the active routes that
would compete for the same request**: same path, overlapping method (`any`
overlaps with everything). Routes that answer something else are never touched,
and the response lists both what went up and what went down.

## Authentication

Open by default. A mock server usually runs next to the thing it is mocking, and
demanding a token out of the box would break every script that already talks to
it.

| Variable | Effect |
|----------|--------|
| `MOCK_SERVER_API_AUTH` | Set to `required` to demand a token on every `/api/v1` call |
| `MOCK_SERVER_API_TOKEN` | A fixed token, for a CI that has no panel to click on |

Panel tokens work too: the ones created under **Tools → MCP Connection** are
accepted by both the MCP endpoint and this API, so there is one list of
credentials to revoke, not two.

```bash
curl http://localhost:3880/api/v1/routes \
  -H 'Authorization: Bearer <token>'
```

A wrong token is always rejected, even with the API open: accepting it silently
would make a broken credential look good until the day the server is closed.

`GET /api/v1/health` reports which mode the server is in, and needs no token.

## Endpoints

The full contract, with every field and example, is at `/api-docs`, and the raw
document at `/api/v1/openapi.json` and `/api/v1/openapi.yaml`.

### Server

| Method | Endpoint | What it does |
|--------|----------|--------------|
| GET | `/api/v1/health` | Liveness, plus whether a token is needed |
| GET | `/api/v1/server` | Version, route counts, active environment, matching rules |
| GET | `/api/v1/version` | Running version and whether a newer one is published |
| GET | `/api/v1/openapi.json` | This contract |
| GET | `/api/v1/openapi.yaml` | This contract, as YAML |

### Routes

| Method | Endpoint | What it does |
|--------|----------|--------------|
| GET | `/api/v1/routes` | List, filtered by method, type, state, tag or text |
| POST | `/api/v1/routes` | Create a route (JSON, or multipart with a file) |
| GET | `/api/v1/routes/{id}` | Full detail |
| PATCH | `/api/v1/routes/{id}` | Change some fields, keeping the rest |
| DELETE | `/api/v1/routes/{id}` | Delete it and everything attached |
| POST | `/api/v1/routes/activate` | Turn on what the selector matches |
| POST | `/api/v1/routes/deactivate` | Turn off what the selector matches |
| POST | `/api/v1/routes/delete` | Delete what the selector matches |
| POST | `/api/v1/routes/tags` | Add or remove a tag in bulk |
| POST | `/api/v1/routes/reorder` | Set the priority order |
| POST | `/api/v1/routes/{id}/duplicate` | Copy it to another path, with its conditions |
| GET/PUT | `/api/v1/routes/{id}/docs` | Read or write the route's documentation |
| GET | `/api/v1/routes/usage` | Calls, last use and errors per route |

### Route behaviour

| Method | Endpoint | What it does |
|--------|----------|--------------|
| GET/PUT | `/api/v1/routes/{id}/conditions` | Conditional responses, first match wins |
| PUT | `/api/v1/routes/{id}/sequence` | Stateful scenario: answer by call number |
| POST | `/api/v1/routes/{id}/sequence/reset` | Back to the first step |
| PUT | `/api/v1/routes/{id}/faults` | Latency and fault injection |
| PUT | `/api/v1/routes/{id}/recording` | Record a proxy's answers as mocks |
| PUT | `/api/v1/routes/{id}/proxy-transform` | Header rules and `ms.*` scripts |
| PUT | `/api/v1/routes/{id}/proxy-fallbacks` | What to answer when the backend fails |
| PUT | `/api/v1/routes/{id}/graphql-operations` | Operations of a GraphQL route |
| POST | `/api/v1/routes/{id}/graphql-schema/import` | Generate them by introspection |
| PUT | `/api/v1/routes/{id}/websocket-messages` | Handlers of a WebSocket route |

### Tags and environments

| Method | Endpoint | What it does |
|--------|----------|--------------|
| GET/POST | `/api/v1/tags` | List or create tags |
| DELETE | `/api/v1/tags/{id}` | Delete a tag everywhere |
| GET | `/api/v1/environments` | Environments and their variables |
| GET/PUT/DELETE | `/api/v1/environments/{name}` | Read, create/update or delete one |
| POST | `/api/v1/environments/{name}/activate` | Switch the active environment |
| POST | `/api/v1/environments/{name}/rename` | Rename it, keeping its variables |
| PUT/DELETE | `/api/v1/environments/{name}/variables/{key}` | One variable, leaving the rest alone |
| GET | `/api/v1/environments/usage` | Which routes use `${NAME}` and which are missing |

### Logs and testing

| Method | Endpoint | What it does |
|--------|----------|--------------|
| GET | `/api/v1/logs` | Recorded traffic, with filters |
| DELETE | `/api/v1/logs` | Clear it, entirely or just what matches |
| GET | `/api/v1/logs/stats` | Totals, top status codes and histogram |
| GET | `/api/v1/logs/traces/{traceId}` | The full story of one request |
| POST | `/api/v1/logs/mocks` | Turn recorded traffic into mock routes |
| POST | `/api/v1/logs/{id}/mock` | Turn one log line into a mock |
| POST | `/api/v1/verify/calls` | Assert what was called, and how many times |
| GET | `/api/v1/scenarios` | Scenarios in progress |
| POST | `/api/v1/scenarios/reset` | Restart them |
| POST | `/api/v1/routes/try` | Call a route through this server and see the answer |
| GET | `/api/v1/waiting` | Requests held by active wait |
| POST | `/api/v1/waiting/release` | Let one (or all of them) continue |

### WebSocket clients and validation

| Method | Endpoint | What it does |
|--------|----------|--------------|
| GET | `/api/v1/ws/clients` | Connected clients |
| POST | `/api/v1/ws/clients/send` | Push a message to some of them |
| POST | `/api/v1/ws/clients/{clientId}/disconnect` | Drop a connection |
| POST | `/api/v1/validate/regex` | Check a regex path |
| POST | `/api/v1/validate/criteria` | Check (and optionally evaluate) a criteria |
| POST | `/api/v1/validate/script` | Check (and optionally run) an `ms.*` script |

## Errors

Failures answer with a body you can branch on:

```json
{ "error": "Route 42 not found", "code": "not_found" }
```

| Status | `code` | When |
|--------|--------|------|
| 400 | `invalid` | Malformed request, or arguments that do not make sense together |
| 401 | `unauthorized` | Missing or invalid token, with the API closed |
| 404 | `not_found` | Nothing matches: the id, the name or the selector |
| 422 | `unprocessable` | It exists, but cannot do that: a scenario on a proxy route, a fallback on a mock |
| 500 | `internal_error` | A bug on this side. It is logged with its stack |

## A test run, end to end

```javascript
const API = 'http://localhost:3880/api/v1';

const api = async (path, options = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${data.error}`);
  return data;
};

// Before each case: pick the scenario and start counting from here
async function givenCheckoutIsDown() {
  await api('/routes/activate', { method: 'POST', body: { tag: 'checkout-down', exclusive: true } });
  await api('/scenarios/reset', { method: 'POST' });
  return Date.now();
}

// After: assert on what the system under test actually did
async function expectRetried(since) {
  const { matched, passed } = await api('/verify/calls', {
    method: 'POST',
    body: { path: '/fake-api/orders', method: 'get', since_ms: since, at_least: 3 }
  });
  if (!passed) throw new Error(`expected at least 3 calls, got ${matched}`);
}
```

`since_ms` is what makes this work per test case without clearing the log between
them: each case only counts what happened after its own starting point.

## Polling flows

Conditions only look at the request, and in a poll every request is identical. A
scenario answers by call number instead:

```bash
curl -X PUT http://localhost:3880/api/v1/routes/7/sequence \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "stick",
    "sequence": [
      { "name": "pending",    "status_code": "200", "response_type": "json", "response": "{\"state\":\"pending\"}", "repeat": 2 },
      { "name": "processing", "status_code": "200", "response_type": "json", "response": "{\"state\":\"processing\"}" },
      { "name": "done",       "status_code": "200", "response_type": "json", "response": "{\"state\":\"done\"}" }
    ]
  }'
```

The counter lives in memory: it resets when the server restarts, and when you
call `/scenarios/reset`. `mode: "stick"` repeats the last step forever, which
leaves a finished flow in its final state; `"loop"` starts over.

## Slow and unreliable backends

```bash
# Half a second on every answer
curl -X PUT http://localhost:3880/api/v1/routes/7/faults \
  -H 'Content-Type: application/json' \
  -d '{ "latency_mode": "fixed", "latency_ms": 500 }'

# And one in five calls drops the connection
curl -X PUT http://localhost:3880/api/v1/routes/7/faults \
  -H 'Content-Type: application/json' \
  -d '{ "fault_rate": 20, "fault_type": "reset" }'
```

Only the fields you send change, so the two calls above compose. On a proxy
route the delay happens before calling the backend, and an injected fault never
reaches it.

## Routes that answer with a file

Send the route as `multipart/form-data` with a `file` part instead of a JSON
body. The endpoints are the same ones:

```bash
curl -X POST http://localhost:3880/api/v1/routes \
  -F 'method=get' \
  -F 'path=/fake-api/tariffs.csv' \
  -F 'status_code=200' \
  -F 'response_type=file' \
  -F 'tags=[{"name":"fixtures"}]' \
  -F 'file=@tariffs.csv;type=text/csv'
```

A form carries only text, so booleans travel as `"true"`/`"false"` and `tags`,
`custom_headers` and `conditions` as JSON inside their own field. Everything
else works the same.

Updating follows the same rule, and **leaving the `file` part out keeps the one
already there**, so a patch that changes the path or the tags does not lose the
file:

```bash
# Replace the file, keep the rest of the route
curl -X PATCH http://localhost:3880/api/v1/routes/7 \
  -F 'file=@tariffs-2026.csv;type=text/csv'

# Change something else, keep the file
curl -X PATCH http://localhost:3880/api/v1/routes/7 \
  -H 'Content-Type: application/json' \
  -d '{ "summary": "current tariffs" }'
```

The route detail reports which file it serves under `file`, and the old one is
deleted from disk when it is replaced. Creating a `file` route without a file,
or turning an existing route into one without sending it, is a `400`: it would
save fine and then answer nothing.

## What is not here

`/api/*` without `/v1` is what the panel screen talks to; it changes with the
screen and is not part of this contract.

## Relationship with the MCP server

Same operations, two front doors. [MCP](mcp.md) is for an assistant holding a
conversation; this API is for a script that runs the same thing a thousand
times. Both go through the same layer, so a mock created by the assistant
behaves exactly like one created by a script, and a change made from either
shows up in the panel's terminal saying who made it.

See also: [Testing](testing.md), [Scenarios](scenarios.md),
[Faults and latency](faults.md), [Environments](environments.md).
