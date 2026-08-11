# Proxy Request and Response Transforms

Proxy routes can rewrite the request before it reaches the backend and the response before it goes back to the client, so a route can behave like a small BFF instead of a plain pass-through.

There are two layers, applied in this order:

1. **Declarative rules** — add or remove request headers and query parameters from the form, no code involved.
2. **Scripts** — JavaScript that runs in a sandbox with a `pm.*` API close to Postman's Scripts tab.

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
pm.request.headers.add({ key: 'x-api-key', value: 'abc123' });
pm.request.headers.remove('authorization');
const trace = pm.request.headers.get('x-trace-id');

// Query parameters
pm.request.url.query.add({ key: 'limit', value: '10' });
pm.request.url.query.remove('debug');

// Body
const body = pm.request.body.json();
body.source = 'mock-server';
delete body.internalField;

// Path and method
pm.request.path = '/v2' + pm.request.path;
pm.request.method = 'POST';
```

### Responding without calling the backend

`pm.respond(code, body, headers)` stops the script and returns your own response. The backend is never called.

```js
if (!pm.request.headers.get('authorization')) {
  pm.respond(401, { error: 'missing token' });
}

if (pm.request.url.query.get('simulate') === 'ratelimit') {
  pm.respond(429, { error: 'slow down' }, { 'Retry-After': '30' });
}
```

The response carries an `X-Mock-Script: short-circuit` header so it is obvious from the outside that the script answered.

`respond(...)` without the `pm.` prefix works too.

> Do not wrap `pm.respond()` in a `try/catch`: it stops the script by throwing an internal marker, and catching it swallows the short-circuit.

## Response script

Runs after the backend replies and before the response reaches the client. The body arrives already decompressed, so gzip, deflate and brotli responses are handled transparently.

```js
const data = pm.response.json();
data.items = data.items.slice(0, 5);
data.total = data.items.length;
pm.response.setBody(data);

pm.response.code = 200;
pm.response.headers.add({ key: 'x-served-by', value: 'mock-server' });
pm.response.headers.remove('x-powered-by');
```

`pm.request` is available here too, read-only, holding the request that was actually sent (after the rules and the request script).

Transformed responses carry an `X-Mock-Script: response` header, and `Content-Length` is recalculated.

## Sharing data between the two scripts

`pm.variables` is scoped to a single request and shared by both scripts:

```js
// Request script
pm.variables.set('startedAt', String(new Date().getTime()));

// Response script
const started = Number(pm.variables.get('startedAt'));
pm.response.headers.add({ key: 'x-elapsed-ms', value: String(new Date().getTime() - started) });
```

## Console

`console.log(...)` and `pm.console.log(...)` write to the panel console, prefixed with `[request]` or `[response]`. Up to 100 entries per script are kept, so a runaway loop cannot flood the panel.

## Full API

| Call | Description |
|------|-------------|
| `pm.request.method` | HTTP method, read and write |
| `pm.request.path` | Path sent to the backend |
| `pm.request.headers.get(k)` / `.has(k)` | Read a header |
| `pm.request.headers.add({key, value})` / `.set(k, v)` | Add or replace |
| `pm.request.headers.remove(k)` | Remove |
| `pm.request.headers.all()` / `.toObject()` | List every header |
| `pm.request.url.query.*` | Same API for query parameters |
| `pm.request.body.json()` | Parsed body, editable in place |
| `pm.request.body.text()` | Body as text |
| `pm.request.body.set(v)` | Replace the whole body |
| `pm.respond(code, body, headers)` | Answer without calling the backend |
| `pm.response.code` | Status code, read and write |
| `pm.response.json()` / `.text()` / `.setBody(v)` | Response body |
| `pm.response.headers.*` | Same API as request headers |
| `pm.variables.set/get/has/unset` | Data shared between both scripts |
| `console.log/info/warn/error` | Panel console |
| `atob()` / `btoa()` | Base64 |

## Body handling

The body is only re-serialized **if the script touches it**. Reading it with `json()` or `text()` and leaving it alone forwards the original bytes untouched, which matters for XML, signed payloads and anything where formatting is significant.

If the script creates a body where there was none and no `content-type` is set, the server labels it `application/json` when it parses as JSON and `text/plain` otherwise. Set the header explicitly if you need something else:

```js
pm.request.headers.add({ key: 'content-type', value: 'application/xml' });
pm.request.body.set('<order><id>7</id></order>');
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
pm.request.headers.add({ key: 'x-api-key', value: 'internal-key' });
pm.request.headers.remove('cookie');
pm.request.url.query.add({ key: 'expand', value: 'customer' });
pm.variables.set('tenant', pm.request.headers.get('x-tenant') || 'default');
```

Response script, to reshape the payload for the client:

```js
const data = pm.response.json();

pm.response.setBody({
  tenant: pm.variables.get('tenant'),
  count: data.items.length,
  items: data.items.map(i => ({ id: i.id, name: i.displayName }))
});

pm.response.headers.add({ key: 'cache-control', value: 'no-store' });
```
