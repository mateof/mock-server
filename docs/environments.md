# Environments

The same set of routes, pointed at a different backend, without editing a single one. Write `${BACKEND_URL}` where the value changes, define it per environment, and switch.

## The syntax, and why it is not `{{...}}`

Variables are written `${NAME}`. That is deliberately **not** the `{{...}}` of [dynamic responses](templating.md), because they are different things:

| | `{{body.id}}` | `${BACKEND_URL}` |
|---|---|---|
| Comes from | this request | the active environment |
| Changes | per call | per deployment |
| Needs enabling | yes, per route | no |

Sharing one syntax would have meant either hiding deployment config behind a checkbox that talks about response templating, or breaking the guarantee that a route without that checkbox is never touched. Two mechanisms, two markers.

## Where they are substituted

| Place | Example |
|-------|---------|
| Proxy target | `${BACKEND_URL}/api/v3` |
| Response body | `{"token": "${API_KEY}"}` |
| Response headers | `Authorization: Bearer ${TOKEN}` |
| Proxy request headers and params | the rules applied before calling the backend |

The proxy target is resolved **per request**, not when the configuration is loaded, so switching environment takes effect on the very next call with no reload.

## Only what is defined gets substituted

Same rule as dynamic responses: a variable the active environment does not define is **left exactly as written**, not blanked.

```
${API_KEY} defined     ->  abc123
${NOPE} not defined    ->  ${NOPE}
```

Two reasons. A response that legitimately contains `${...}` is not destroyed. And detecting an undefined variable and deciding not to substitute it are the same operation, which is what powers the warnings below for free.

A variable defined as an **empty string** is a value, and does get substituted. Not defined and defined-as-empty are different things.

## Warnings

Because undefined variables survive into the response, they would otherwise show up as `${NOPE}` in a body and leave you guessing. So they are surfaced:

- **A dot on the environment selector** when any route asks for something the active environment lacks, with the list in its tooltip.
- **A panel in the environments modal** naming the routes and the missing variables.
- **A warning in the live console** when it actually happens during a request.
- **A `env` step in the trace**, so the log screen shows it after the fact.
- **A proxy whose target has an undefined variable answers 500** with the reason, rather than letting `new URL()` fail with a message about nothing.

Over MCP, `check_environment_usage` reports the same thing.

## From a script

`ms.env` is available in route and proxy scripts:

```javascript
ms.env.get('API_KEY')        // value, or null
ms.env.has('API_KEY')        // is it defined
ms.env.set('TOKEN', value)   // writes it to the active environment, persisted
ms.env.name()                // active environment name
ms.env.all()                 // every variable
```

`set` persists, which is what makes this pattern work: one route simulates a login and stores the token, and every other route uses `${TOKEN}` in its headers without you copying anything.

```javascript
// on /login
const token = 'tok-' + Date.now();
ms.env.set('TOKEN', token);
ms.response.setBody({ access_token: token });
```

```jsonc
// on /profile, in the headers
{ "Authorization": "Bearer ${TOKEN}" }
```

## In the panel

The selector sits in the top bar next to the language and the server status, because it is global state: it decides what **every** route resolves against, not just the list you are looking at. Switching it from one tab changes what the server answers for everyone.

**Manage environments** opens the editor: environments on the left, key/value pairs on the right, and the warning panel underneath.

## Over MCP

| Tool | What it does |
|------|--------------|
| `list_environments` | Every environment, its variables, and which is active |
| `set_environment` | Creates one, or replaces its variables. Replacing is how a variable is deleted |
| `activate_environment` | Switches the active one |
| `delete_environment` | Removes one. The last remaining cannot be deleted |
| `check_environment_usage` | Which routes reference variables, and which names are missing |

## Notes

- One environment is always active. Deleting the active one moves the flag to another; the last one cannot be deleted.
- A `default` environment is created on first start so the selector is never empty.
- Names accept letters, digits, `_` and `-`, and must not start with a digit. `$NAME` without braces and `{{NAME}}` are not touched.
- The active environment is server state, not a browser preference.
