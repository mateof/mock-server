# Stateful scenarios

Conditional responses only look at the request. In a polling flow every request is identical, so no criterion can tell the first call from the fifth, and polling is exactly where not having mocks hurts most.

A scenario makes a route answer differently depending on **how many times it has been called**. First `pending`, then `processing`, then `done`.

## Setting one up

Open a route, expand **Stateful scenario**, and add steps in order. Each step overrides the status code, the response type and the body; anything you leave blank falls back to the route's own values.

**Calls** on a step is how many consecutive calls it covers. A `processing` that lasts three polls is one step with `repeat: 3`, not three copies of the same step. The number badge on each step shows the range of calls it answers, so `2-4` means the second through fourth call land there.

**Response type** on a step can be `json`, `xml`, `soap`, `text`, `html`, `page`, `empty` or `sse`: everything that is built from the body you type. Leave it blank to keep the route's own type.

The other four route types are rejected when you save, with the reason:

| Type | Why not |
|------|---------|
| `proxy`, `websocket` | Another middleware handles those, and it looks at the type of the **route**, not the one the step resolves to. A step claiming `proxy` used to be served as plain text, silently |
| `file` | Needs an uploaded file, and a step only carries text |
| `graphql` | Needs the operations that hang off the route, not off the step |

An `sse` step is worth knowing about: a scenario can answer JSON twice and open a stream on the third call.

**When the sequence ends** decides what happens after the last step:

| Mode | Behaviour |
|------|-----------|
| Repeat the last step | The flow stays finished. The default |
| Start over | Back to the first step, cycling forever |

Sticking is the default because a finished flow should stay finished: a job that reports `done` and then goes back to `pending` on its own is not something a real backend does.

## The counter

It lives in memory, per route. That is deliberate: a scenario is a test-session concept, not configuration. Restarting the server starts the flow over, which is what you expect, and it avoids a disk write on every request.

Two things reset it:

- The **Restart** button on the route, or `reset_route_sequence` over MCP. Both leave the steps alone.
- **Saving the sequence.** Changing the steps and leaving the counter mid-flight would make the first call after editing start at step three.

Because it is in-process, several instances would each keep their own count. With a single process, which is how this deploys, there is no observable difference.

## Precedence

A scenario step wins over conditional responses. "On the third call, whatever else, return done" is a rule about the whole flow, and sits outside any criterion about a single request.

If you want the opposite, `callCount` is available inside criteria, so you can express it as a condition instead:

```javascript
callCount === 1                       // only the first call
callCount > 3                         // from the fourth on
callCount === 1 && body.retry !== true
```

That composes the two ideas without the scenario overriding you.

## In templates

`{{callCount}}` is available when [dynamic responses](templating.md) are on, so a body can report which call it is:

```json
{"attempt": {{callCount}}, "status": "processing"}
```

## Over MCP

| Tool | What it does |
|------|--------------|
| `set_route_sequence` | Sets the steps and the end-of-sequence mode. An empty array removes the scenario |
| `reset_route_sequence` | Back to the first step. Without an id, every scenario resets |

`get_route` reports the steps and how many calls have landed so far.

## A polling flow, end to end

```
set_route_sequence(id: 3, mode: "stick", sequence: [
  {name: "pending",    status_code: "202", response: "{\"status\":\"pending\"}"},
  {name: "processing", status_code: "202", response: "{\"status\":\"processing\"}", repeat: 3},
  {name: "done",       status_code: "200", response: "{\"status\":\"done\"}"}
])
```

Five calls walk the whole flow, and everything after stays on `done`. The trace records a `sequence` step on each call saying which step answered and whether the sequence had already run out.

## Notes

- Scenarios are for mock routes. A proxy route forwards to a backend, which has its own state.
- Duplicating a route copies its steps.
- Steps can be switched off individually without deleting them, the same as conditions.
