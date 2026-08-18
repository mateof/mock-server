# Dynamic responses

A mock that always returns the same id is obvious from the outside, and it breaks any test that chains one call into the next. Turn on **Dynamic response** on a route and `{{...}}` in the body and headers is replaced with request data or generated values.

## It is off by default, on purpose

A response can contain `{{...}}` legitimately: a Handlebars template being served as a fixture, a documentation example, a mock of something that itself uses that syntax. Substituting it by surprise would break routes that have worked for years, so it is a checkbox per route.

## Request data

| Placeholder | What it reads |
|-------------|---------------|
| `{{body.user.id}}` | The request body, at any depth |
| `{{query.page}}` | A query parameter |
| `{{params.id}}` | A capture group from a regex route: named, or `{{params.$1}}` |
| `{{headers.x-request-id}}` | A request header, case-insensitive |
| `{{method}}` `{{path}}` `{{url}}` | About the request itself |

Names with dashes or dots also work in brackets: `{{headers['x-request-id']}}`.

Anything missing resolves to empty rather than to the word `undefined`.

## Generators

| Generator | Gives |
|-----------|-------|
| `{{uuid()}}` | A fresh UUID |
| `{{now()}}` | The current time, ISO |
| `{{now('+1d')}}` | Shifted: `ms`, `s`, `m`, `h`, `d`, `w`. No suffix means days |
| `{{date()}}` | Only the date, `YYYY-MM-DD`, and also shiftable |
| `{{timestamp()}}` | Epoch milliseconds |
| `{{randomInt(1,100)}}` | A whole number in range, both ends included |
| `{{randomFloat(0,10,2)}}` | A decimal, with the number of places you ask for |
| `{{randomString(8)}}` | Hex characters |
| `{{randomBool()}}` | `true` or `false` |
| `{{pick('alta','media','baja')}}` | One of the values |

The parentheses are optional when there are no arguments: `{{uuid}}` works.

## Conversions

Query parameters and path captures always arrive as text. In a JSON body that matters, so there are casts:

| Cast | Does |
|------|------|
| `{{number(query.page)}}` | Text to number. Not a number gives `null`, never `NaN` |
| `{{string(body.id)}}` | Anything to text |
| `{{bool(query.flag)}}` | `true`, `1`, `yes`, `si` and `sí` are true |
| `{{length(body.items)}}` | Elements of an array, keys of an object, characters of a string |

Arguments without quotes are read as paths, and arguments in quotes as literals. That is what lets them nest: `{{pick(body.a, 'por defecto')}}`.

## Fallbacks

`{{body.name ?? 'anonymous'}}` uses the fallback when the value is missing **or empty**. An empty query parameter (`?page=`) counts as missing, because otherwise it would leave a hole where a JSON value should be.

The fallback can be a literal, a number, or another generator: `{{body.id ?? uuid()}}`.

## Quoting, in JSON

The rule is JSON's own: **if you want text, put the quotes in.**

```jsonc
{
  "name": "{{body.name}}",     // "Ana"      -> text
  "id": {{body.id}},           // 42         -> number
  "tags": {{body.tags}},       // ["a","b"]  -> array
  "page": {{number(query.page)}}
}
```

Inside quotes the value is escaped as JSON text, so a name containing quotes or newlines cannot break the response. Outside quotes the value's JSON is inserted, which is what makes a number arrive as a number. A missing value outside quotes becomes `null`, never an empty gap that would leave the body unparseable.

For text responses (HTML, XML, plain text) there is no quoting to worry about: the value is inserted as it is.

## Headers

Response headers are templated too, so `X-Request-Id: {{uuid()}}` works. They are rendered in JSON mode, so a value with quotes cannot corrupt the header list.

## Order

Templating runs **after** conditional responses, so what gets rendered is the body that won, not the default one. It runs **before** the response is sent and after latency and faults are evaluated. The trace records a `template` step when it applies.

## Over MCP

`templating: true` on `create_route` or `update_route`. `get_route` reports it only when it is on.

## Notes

- The rendered output is capped at 1 MB. Past that the template is returned untouched rather than serving something enormous built from a large input.
- Templating applies to `json`, `text`, `html`, `xml`, `soap` and `page` responses. Files and empty responses have no body to render.
- For anything beyond substitution (loops, conditionals, computation) use an `ms.*` script instead.
