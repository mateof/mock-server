# Server-sent events

`text/event-stream` responses: the connection stays open and events arrive one after another. It is what notifications and language-model streaming use, and it is the one streaming shape the server was missing next to its WebSocket support.

Pick **SSE** as the response type. The body is the event list, in JSON.

## The event list

```json
[
  { "data": { "status": "pending" } },
  { "event": "progress", "data": { "pct": 50 }, "delay": 1000 },
  { "event": "progress", "data": { "pct": 100 }, "delay": 1000 },
  { "event": "done", "data": "finished", "delay": 500 }
]
```

| Field | Meaning |
|-------|---------|
| `data` | The payload. An object is sent as JSON; a string is sent as it is |
| `event` | Event name. Without it the client sees the default `message` |
| `delay` | Milliseconds to wait **before** sending this event, so the first with `delay: 0` goes out at once |
| `id` | Event id, which the client echoes back as `Last-Event-ID` on reconnect |
| `retry` | Tells the client how long to wait before reconnecting |

A single event does not need wrapping in an array, and a plain list of strings is the shortest way to write a simple stream:

```json
["first", "second", "third"]
```

Those get a second between them, with the first going out immediately.

## When the list runs out

The connection closes. Turn on **Loop the events** to start over instead, which is how you build a heartbeat:

```json
[{ "event": "ping", "data": "alive", "delay": 5000 }]
```

Looping is capped at 10000 events per connection, so a heartbeat left running does not write forever against a client that stopped reading.

## Closing and cleanup

If the client goes away, the pending timers stop. Without that they would keep firing against a dead response until the list ran out, which for a looping stream means never.

Delays are capped at five minutes: past that most clients treat the connection as dead anyway.

## Details that bite

- **Newlines in data.** A raw newline would cut the event in half, so multi-line text is split across several `data:` lines, which is what the specification says to do. The client reassembles it.
- **Buffering proxies.** The response carries `X-Accel-Buffering: no`. Without it, nginx and friends hold the stream in a buffer and nothing reaches the client until it closes, which is the exact opposite of the point.
- **A broken event list** answers `500` with the parse error rather than opening an empty stream, so a typo is visible instead of looking like a silent backend.

## Over MCP

`create_route` with `response_type: "sse"`, the event list as `response`, and `sse_loop` when you want it to cycle.

## Testing it by hand

```bash
curl -N http://localhost:3880/events
```

`-N` disables curl's own buffering. Without it the events pile up and arrive together.
