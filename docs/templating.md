# Dynamic responses

A mock that always returns the same id is obvious from the outside, and it breaks any test that chains one call into the next: you create an order, get back id `1` forever, and the next request cannot tell one order from another.

**Dynamic response** fixes that. Turn it on for a route and any `{{...}}` in the body and headers is filled in when the request arrives.

## Where to turn it on

Open the route, find **Dynamic response**, and tick the switch. A cheat sheet of the syntax appears right underneath it once it is on, so you do not have to keep this page open while you write.

Over MCP it is the `templating` field on `create_route` and `update_route`.

## The idea in one line

**Your response stays exactly as you wrote it. Only the `{{...}}` parts change.**

That is the whole model. The response body is not a program and it is not a special format: it is the same JSON, HTML or XML you already had, with holes in the places you want filled.

## A first example

The response body saved on the route:

```json
{
  "id": {{body.id}},
  "customer": "{{body.name}}",
  "status": "pending",
  "currency": "EUR",
  "items": [
    { "sku": "ABC-1", "qty": 2 }
  ],
  "createdAt": "{{now()}}"
}
```

A request arrives:

```bash
curl -X POST http://localhost:3880/orders \
  -H 'Content-Type: application/json' \
  -d '{"id":42,"name":"Ana"}'
```

And this comes back:

```json
{
  "id": 42,
  "customer": "Ana",
  "status": "pending",
  "currency": "EUR",
  "items": [
    { "sku": "ABC-1", "qty": 2 }
  ],
  "createdAt": "2026-08-18T11:38:42.277Z"
}
```

Three fields changed, because three fields had `{{...}}`. `status`, `currency` and the whole `items` array came out byte for byte as they were saved. Nothing else was touched, reordered or reformatted.

## Yes, you can change only parts

That is the normal way to use this, and usually the best one. A realistic mock is mostly fixed content with two or three moving pieces:

- the id or reference that must be different every time,
- something echoed back from the request so the caller recognises its own data,
- a timestamp that has to look recent.

Everything else stays hardcoded. You do not have to make the whole body dynamic, and you should not: the more of it is fixed, the more the mock reads like a real example of what the endpoint returns.

## Why it is a switch, and not always on

Because a response can contain `{{...}}` for its own reasons, and substituting it by surprise would break it.

The clearest case is a route that serves a template as its content. Say you mock an endpoint that returns an email template:

```json
{"greeting":"Hola {{nombre}}, tienes {{n}} mensajes"}
```

With dynamic responses **off**, that is served exactly as written, which is what you want:

```json
{"greeting":"Hola {{nombre}}, tienes {{n}} mensajes"}
```

With it **on**, the engine treats those as holes to fill, finds nothing called `nombre` or `n` in the request, and empties them:

```json
{"greeting":"Hola , tienes  mensajes"}
```

The same applies to a mock of an endpoint that returns Handlebars or Mustache, or to documentation examples that show placeholder syntax. Turning this on globally would silently corrupt every one of those, and they would keep working right up until the upgrade.

So it is a checkbox on each route. Routes that do not tick it behave exactly as they always did.

## What you can put inside the braces

### Data from the request

| Placeholder | What it reads |
|-------------|---------------|
| `{{body.user.id}}` | The request body, at any depth |
| `{{query.page}}` | A query parameter |
| `{{params.id}}` | A capture group from a regex route: named, or `{{params.$1}}` |
| `{{headers.x-request-id}}` | A request header, case-insensitive |
| `{{method}}` `{{path}}` `{{url}}` | About the request itself |
| `{{callCount}}` | How many times this route has been called, starting at 1 |

Names with dashes or dots also work in brackets: `{{headers['x-request-id']}}`.

### Generated values

| Generator | Gives |
|-----------|-------|
| `{{uuid()}}` | A fresh UUID |
| `{{now()}}` | The current time, ISO |
| `{{now('+1d')}}` | Shifted: `ms`, `s`, `m`, `h`, `d`, `w`. No suffix means days |
| `{{date()}}` | Only the date, `YYYY-MM-DD`, also shiftable |
| `{{timestamp()}}` | Epoch milliseconds |
| `{{randomInt(1,100)}}` | A whole number in range, both ends included |
| `{{randomFloat(0,10,2)}}` | A decimal, with the number of places you ask for |
| `{{randomString(8)}}` | Hex characters |
| `{{randomBool()}}` | `true` or `false` |
| `{{pick('high','medium','low')}}` | One of the values, at random |

The parentheses are optional when there are no arguments: `{{uuid}}` works the same as `{{uuid()}}`.

### Fallbacks, for when the data may not be there

`{{body.name ?? 'anonymous'}}` uses the fallback when the value is missing **or empty**. An empty query parameter (`?page=`) counts as missing, because otherwise it would leave a hole where a value should be.

The fallback can be a literal, a number, or another generator: `{{body.id ?? uuid()}}`.

### Conversions

Query parameters and path captures always arrive as **text**, even when they look like numbers. In a JSON body that matters:

| Cast | Does |
|------|------|
| `{{number(query.page)}}` | Text to number. Not a number gives `null`, never `NaN` |
| `{{string(body.id)}}` | Anything to text |
| `{{bool(query.flag)}}` | `true`, `1`, `yes`, `si` and `sí` are true |
| `{{length(body.items)}}` | Elements of an array, keys of an object, characters of a string |

Arguments **without** quotes are read as paths into the request; arguments **in** quotes are literal text. That is what lets them nest: `{{pick(body.optionA, body.optionB)}}` chooses at random between two values taken from the request.

> Careful with `pick` here. It always chooses **at random** among everything you give it, so `{{pick(body.preferred, 'default')}}` does **not** mean "use `preferred`, or `default` if it is missing": it returns one of the two by chance. For that, use the fallback: `{{body.preferred ?? 'default'}}`.

## Quoting, in JSON

This is the one rule worth reading twice, and it is JSON's own: **if you want text, put the quotes in.**

```jsonc
{
  "name": "{{body.name}}",          // "Ana"      -> text
  "id": {{body.id}},                // 42         -> number
  "tags": {{body.tags}},            // ["a","b"]  -> array
  "page": {{number(query.page)}}    // 5          -> number
}
```

Inside quotes the value is escaped as JSON text, so a name containing quotes or newlines cannot break the response. Outside quotes the value's own JSON is inserted, which is what makes a number arrive as a number and an array as an array.

## What happens when something is missing or wrong

Nothing blows up, and the response is always still valid JSON. Given this body:

```json
{
  "present": "{{body.name}}",
  "missingInQuotes": "{{body.nope}}",
  "missingUnquoted": {{body.nope}},
  "withFallback": "{{body.nope ?? 'anonymous'}}",
  "queryAsText": {{query.page}},
  "queryAsNumber": {{number(query.page)}},
  "misspelledGenerator": "{{uuidd()}}"
}
```

called with `?page=5` and `{"name":"Ana"}`, the answer is:

```json
{
  "present": "Ana",
  "missingInQuotes": "",
  "missingUnquoted": null,
  "withFallback": "anonymous",
  "queryAsText": "5",
  "queryAsNumber": 5,
  "misspelledGenerator": ""
}
```

Worth noting:

- A missing value **inside quotes** becomes an empty string; **outside quotes** it becomes `null`. Either way the body still parses.
- Nothing ever renders as the word `undefined`.
- `queryAsText` came out as the string `"5"`, not the number `5`. That is not a bug: query parameters are text. Wrap it in `number()` when you want a number.
- A **misspelled generator** is indistinguishable from a path that does not exist, so it renders empty rather than raising an error. If a value comes out empty and you expected something, check the spelling first.

## Beyond JSON

For HTML, XML, SOAP and plain text there is no quoting to think about: the value goes in as it is.

```html
<h1>Hola {{query.nombre ?? "invitado"}}</h1>
<p>Tu ticket: {{uuid()}}</p>
```

With `?nombre=Ana`:

```html
<h1>Hola Ana</h1>
<p>Tu ticket: 1af11f9b-f4b3-4048-864b-2d1b31bb0465</p>
```

And without it, the fallback fills in: `<h1>Hola invitado</h1>`.

## Response headers

Headers are templated too, so a per-request id costs one line:

| Header | Value |
|--------|-------|
| `X-Request-Id` | `{{uuid()}}` |
| `X-Served-At` | `{{now()}}` |

They come out filled in:

```
X-Request-Id: 14158669-7eb1-42df-a9dd-d9f351675ea1
X-Served-At: 2026-08-18T11:39:20.168Z
```

## Where it happens in the request

Templating is one step of several, and the order explains what it sees:

1. The matching route is found
2. **Conditional responses** run: the winning condition may replace the body
3. **The scenario step** runs, if the route has one, and may replace it again
4. **Templating** fills in the `{{...}}` of whatever body won
5. **The `ms.*` script** runs last, if there is one
6. The response is sent

So templating always renders the body that actually won, never the default one. And because the scenario step runs before it, a step body can carry placeholders too, `{{callCount}}` included.

The trace records a `template` step when it applies, so you can confirm from the log screen whether it ran.

## When to reach for a script instead

Templating substitutes values. It does not loop, branch or calculate. If you need a list whose length depends on the request, a field that only appears sometimes, or any arithmetic, use an `ms.*` script: it runs after templating, sees the final body, and can do all of that. See [Scripting](proxy-scripting.md).

## Notes

- The rendered output is capped at 1 MB. Past that the template is returned untouched rather than serving something enormous built from a large input.
- Applies to `json`, `text`, `html`, `xml`, `soap` and `page` responses. Files and empty responses have no body to render.
- Every example on this page was run against a real server; the outputs are copied from what it answered.
