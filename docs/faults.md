# Latency and fault injection

A mock that always answers instantly and correctly only tests the happy path. Half of what a mock server is for is the other half: making the route slow, making it fail, and seeing what the caller does about it.

Open a route, expand **Latency and faults**, and set them per route. It works on every route type, mocks and proxies alike.

## Latency

| Mode | What it does |
|------|--------------|
| No latency | Answers as fast as it can. The default |
| Fixed delay | Always waits the same number of milliseconds |
| Random delay | Waits a random time between two bounds, redrawn on every request |

Delays are capped at 60 seconds. A route that hangs longer than that is not simulating anything, it is just holding connections open and draining the caller's pool.

If a random range is entered backwards, the bounds are sorted rather than producing a range that can never be satisfied.

## Faults

**Failure rate** is a percentage from 0 to 100, drawn per request. At 0 the route never fails; at 100 it always does.

| Type | What the caller sees |
|------|----------------------|
| Answer an error code | The configured status with a JSON body and an `X-Mock-Fault: injected` header |
| Drop the connection | `ECONNRESET`. No status code, no body: what a server that actually fell over looks like |
| Answer the code with no body | The status arrives, the body never does. Catches clients that assume a body is always there |

Dropping the connection has no status code to configure, so that field disappears when you pick it.

## On proxy routes

The delay is applied **before** calling the backend, so it adds to the backend's own time rather than overlapping it. An injected fault short-circuits the request entirely: the backend is never called, which is what you want when simulating your own gateway failing rather than the service behind it.

## In the trace

Both show up as steps in the request trace, so a slow or failed request explains itself:

| Step | Recorded |
|------|----------|
| `latency` | The mode and how many ms this particular request waited |
| `fault` | The type, the configured rate and the status |

A trace with a `fault` step and no `proxy-request` step is the proof that the backend was never reached.

## Over MCP

`set_route_faults` sets all of it:

```
set_route_faults(id: 12, latency_mode: "random", latency_ms: 200, latency_max_ms: 900, fault_rate: 10, fault_type: "reset")
```

Only the fields you pass change; the rest are kept. `get_route` reports the current setup, and leaves both blocks out entirely when nothing is configured, which is the case for almost every route.

## Notes

- Latency and faults are evaluated **after** conditional responses, so the trace still shows which condition won before the request was slowed down or broken.
- Duplicating a route copies its latency and faults: they are configuration, unlike recording mode, which is an operating mode and is deliberately not copied.
- The failure draw is independent per request. Ten percent means roughly one in ten over many calls, not exactly one in every ten.
