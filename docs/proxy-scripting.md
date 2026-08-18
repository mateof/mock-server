# Proxy Request and Response Transforms

Proxy routes can rewrite the request before it reaches the backend and the response before it goes back to the client, so a route can behave like a small BFF instead of a plain pass-through.

There are two layers, applied in this order:

1. **Declarative rules** — add or remove request headers and query parameters from the form, no code involved.
2. **Scripts** — JavaScript that runs in a sandbox with a `ms.*` API close to Postman's Scripts tab.

Rules run first and scripts run afterwards, so a script can always read and correct whatever the rules did.

Everything lives in the **Request and Response Transform** section of the route form, visible only when the response type is **Proxy**.

## Declarative rules

| Field | Applies to | Effect |
|-------|-----------|--------|
| **Request headers** | Request sent to the backend | `Set` adds or replaces, `Remove` deletes |
| **Query parameters** | Query string sent to the backend | `Set` adds or replaces, `Remove` deletes |
| **Custom Headers** | Response returned to the client | `Set` adds or replaces, `Remove` deletes |

Header names are case-insensitive: removing `Authorization` removes the header that arrived as `authorization`. Query parameter names are case-sensitive.

Query parameters are modelled as a plain object, so with repeated keys (`?tag=a&tag=b`) the last one wins.

## Request script

Runs before the request is sent to the backend.

```js
// Headers
ms.request.headers.add({ key: 'x-api-key', value: 'abc123' });
ms.request.headers.remove('authorization');
const trace = ms.request.headers.get('x-trace-id');

// Query parameters
ms.request.url.query.add({ key: 'limit', value: '10' });
ms.request.url.query.remove('debug');

// Body
const body = ms.request.body.json();
body.source = 'mock-server';
delete body.internalField;

// Path and method
ms.request.path = '/v2' + ms.request.path;
ms.request.method = 'POST';
```

### Responding without calling the backend

`ms.respond(code, body, headers)` stops the script and returns your own response. The backend is never called.

```js
if (!ms.request.headers.get('authorization')) {
  ms.respond(401, { error: 'missing token' });
}

if (ms.request.url.query.get('simulate') === 'ratelimit') {
  ms.respond(429, { error: 'slow down' }, { 'Retry-After': '30' });
}
```

The response carries an `X-Mock-Script: short-circuit` header so it is obvious from the outside that the script answered.

`respond(...)` without the `ms.` prefix works too.

> Do not wrap `ms.respond()` in a `try/catch`: it stops the script by throwing an internal marker, and catching it swallows the short-circuit.

## Response script

Runs after the backend replies and before the response reaches the client. The body arrives already decompressed, so gzip, deflate and brotli responses are handled transparently.

```js
const data = ms.response.json();
data.items = data.items.slice(0, 5);
data.total = data.items.length;
ms.response.setBody(data);

ms.response.code = 200;
ms.response.headers.add({ key: 'x-served-by', value: 'mock-server' });
ms.response.headers.remove('x-powered-by');
```

`ms.request` is available here too, read-only, holding the request that was actually sent (after the rules and the request script).

Transformed responses carry an `X-Mock-Script: response` header, and `Content-Length` is recalculated.

## Sharing data between the two scripts

`ms.variables` is scoped to a single request and shared by both scripts:

```js
// Request script
ms.variables.set('startedAt', String(new Date().getTime()));

// Response script
const started = Number(ms.variables.get('startedAt'));
ms.response.headers.add({ key: 'x-elapsed-ms', value: String(new Date().getTime() - started) });
```

## Console

`console.log(...)` and `ms.console.log(...)` write to the panel console, prefixed with `[request]` or `[response]`. Up to 100 entries per script are kept, so a runaway loop cannot flood the panel.

## The editor

The two script boxes are Monaco (the editor behind VS Code), with JavaScript syntax highlighting and real IntelliSense over the `ms.*` API: completions, documentation on hover and errors as you type.

The type definitions come from `GET /api/script-types`, served by the same module that implements the sandbox, so they cannot drift from the API they describe.

The editor is configured **without the DOM library**, matching what the sandbox actually provides. That means `document`, `fetch`, `setTimeout` and friends are reported as undefined while you type, instead of failing on the first request:

```js
ms.request.headr.add(...)     // Property 'headr' does not exist. Did you mean 'headers'?
setTimeout(() => {}, 100)     // Cannot find name 'setTimeout'
```

Monaco is loaded from a CDN, on demand, only when you open a proxy route: it is about 4 MB and there is no reason to pay for it otherwise. **If the CDN is unreachable, the plain text boxes stay in place and everything keeps working**, just without completions.

## Full API

| Call | Description |
|------|-------------|
| `ms.request.method` | HTTP method, read and write |
| `ms.request.path` | Path sent to the backend |
| `ms.request.headers.get(k)` / `.has(k)` | Read a header |
| `ms.request.headers.add({key, value})` / `.set(k, v)` | Add or replace |
| `ms.request.headers.remove(k)` | Remove |
| `ms.request.headers.all()` / `.toObject()` | List every header |
| `ms.request.url.query.*` | Same API for query parameters |
| `ms.request.body.json()` | Parsed body, editable in place |
| `ms.request.body.text()` | Body as text |
| `ms.request.body.set(v)` | Replace the whole body |
| `ms.respond(code, body, headers)` | Answer without calling the backend |
| `ms.response.code` | Status code, read and write |
| `ms.response.json()` / `.text()` / `.setBody(v)` | Response body |
| `ms.response.headers.*` | Same API as request headers |
| `ms.variables.set/get/has/unset` | Data shared between both scripts |
| `console.log/info/warn/error` | Panel console |
| `atob()` / `btoa()` | Base64 |

## Body handling

The body is only re-serialized **if the script touches it**. Reading it with `json()` or `text()` and leaving it alone forwards the original bytes untouched, which matters for XML, signed payloads and anything where formatting is significant.

If the script creates a body where there was none and no `content-type` is set, the server labels it `application/json` when it parses as JSON and `text/plain` otherwise. Set the header explicitly if you need something else:

```js
ms.request.headers.add({ key: 'content-type', value: 'application/xml' });
ms.request.body.set('<order><id>7</id></order>');
```

## Limits and safety

- **1 second** per script. Going over it makes the request return `500`.
- **20000 characters** per script.
- No `require`, `process`, `fs`, `eval`, `Function`, `constructor`, `prototype`, `__proto__` or `Buffer`. Scripts are rejected **when saved**, not when the first request arrives, and the error names the construct that was blocked.
- A script error returns `500` with the message instead of silently forwarding the untransformed request. Failing loudly beats debugging a proxy that quietly ignores your code.

The sandbox uses Node's `vm`, which is isolation for convenience, not a security boundary. It is the same posture as conditional-response criteria: whoever can reach the panel can already configure everything else. Do not expose this application to untrusted networks.

## Interaction with other features

- **Fallbacks** are evaluated before the response script. If the backend fails and a fallback matches, the fallback answers and the response script does not run.
- **Export/import** includes rules and scripts, so a configured BFF-style route travels between instances.
- Fallback path patterns match the path **after** the rules and the request script, which is the path actually requested.

## Example: turning a raw API into a BFF

Request script, to authenticate and narrow the query:

```js
ms.request.headers.add({ key: 'x-api-key', value: 'internal-key' });
ms.request.headers.remove('cookie');
ms.request.url.query.add({ key: 'expand', value: 'customer' });
ms.variables.set('tenant', ms.request.headers.get('x-tenant') || 'default');
```

Response script, to reshape the payload for the client:

```js
const data = ms.response.json();

ms.response.setBody({
  tenant: ms.variables.get('tenant'),
  count: data.items.length,
  items: data.items.map(i => ({ id: i.id, name: i.displayName }))
});

ms.response.headers.add({ key: 'cache-control', value: 'no-store' });
```

## The same engine on mock routes

Mock routes have a **Response script** of their own. It is the same `ms.*` API and the same editor, with one difference: there is no request phase to short-circuit, because the mock is already producing the response.

It runs **last**, after conditional responses, the scenario step and templating, so it sees the body that is actually about to be sent. That makes it the escape hatch for anything the declarative features cannot express: loops, computed fields, conditional shapes.

```javascript
const incoming = ms.request.json();
const body = ms.response.json();

body.total = (incoming.items || []).length;
body.receivedFrom = ms.request.headers.get('x-client');

if (body.total > 100) ms.response.code = 206;
ms.response.headers.set('x-generated-by', 'script');
ms.response.setBody(body);
```

`ms.request.json()` and `ms.request.text()` read the request body. They are also available in a proxy's response script, where they were missing before: the request has already gone out at that point, so they are read-only and there is no `ms.request.body` API to write into a body that no longer goes anywhere.

If the script throws, the route answers `500` with the error message rather than the mock body, so a broken script is loud instead of silently returning the wrong thing. Its `ms.console` output goes to the panel console with a 📜 marker, and the trace records a `script` step saying whether the body changed.

File, empty and GraphQL responses skip the script: there is no text body to transform.
