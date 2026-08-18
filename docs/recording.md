# Recording real traffic

Writing mocks by hand is the slow way. Point a proxy route at the real backend, let traffic through, and keep what it answered.

## The two ways in

| Way | Where | What it captures |
|-----|-------|------------------|
| Recording mode | Toggle on a proxy route | Every response, live, with the full body |
| Save as mock | Button on a line of the log | That one exchange, from what the log stored |
| Bulk conversion | Button on the log screen, or MCP | Everything matching the current filters |

They are not interchangeable. Recording mode converts with the response buffer still in memory, so the body is complete. The log truncates bodies at 10 KB, so converting from a log line can hit a body that was cut; when that happens the entry is rejected rather than turned into a broken mock.

## Recording mode

Open a proxy route, turn on **Recording mode**, and pick what to do when a mock for that method and path already exists:

| Mode | Behaviour |
|------|-----------|
| Update the route if it already exists | The mock keeps up with the backend |
| Leave existing routes alone | Only genuinely new paths are captured |

Then drive traffic through the proxy. Each response becomes a mock route, tagged `recorded`.

### Why recorded routes start inactive

Mocks outrank proxies. A recorded route created **active** would answer the very next request itself, the proxy would never be reached again, and the recording would end after one call per path.

So they are created inactive: you record the whole session, review what came out, and activate what you want. Filter the route list by the `recorded` tag to find them.

Saving a single line from the log is the exception, and is created active: picking one specific entry is an explicit choice about one route.

## What cannot be recorded

Both paths report these instead of writing a broken route:

| Reason | Meaning |
|--------|---------|
| `binary` | The response is an image, a PDF or similar. It does not fit in a text route |
| `truncated` | The log cut the body, so the mock would be incomplete |
| `reserved` | The path starts with `/api` or `/mcp` |
| `exists` | A mock is already there and the mode says not to touch it |

## What ends up in the route

| Route field | Taken from |
|-------------|-----------|
| Method and path | The request, without the query string |
| Status code | Exactly what the backend answered, errors included |
| Response type | The `content-type`: JSON, HTML, XML, SOAP, text, or empty |
| Body | The response, with JSON reindented so it can be read and edited |
| Headers | The backend's, minus the ones about that particular connection |
| Tags | `recorded` |

Dropped headers are `content-length`, `content-encoding`, `transfer-encoding`, `connection`, `keep-alive`, `date`, `server` and the `x-mock-*` this server adds. Express recalculates the first ones when answering, and copying them would describe a connection that no longer exists. Everything else the backend sent is kept, `etag` and `set-cookie` included.

The query string is dropped because exact routes do not look at it when matching, so keeping it would produce a route that never matches. If the response depends on the query, record it and then add conditional responses.

## Over MCP

| Tool | What it does |
|------|--------------|
| `set_route_recording` | Turns recording on or off for a proxy route |
| `create_mocks_from_logs` | Bulk conversion from log filters |
| `create_mock_from_log_entry` | One entry, by the id `query_logs` returns |

> Mock everything that went through `/orders` in the last hour.

`create_mocks_from_logs` with `url: "/orders"` and `from` set to an hour ago. It keeps the newest response for each method and path, so three hundred calls to the same place give one route, not three hundred writes. The summary reports what was created, updated and skipped, and why.

## A full session

1. Create a proxy route at `/orders` pointing at the real backend
2. Turn on recording mode
3. Run the app against the mock server so the traffic goes through the proxy
4. Filter the route list by the `recorded` tag
5. Activate the routes you want, delete the ones you do not
6. Turn recording off, or disable the proxy

From there the mocks answer on their own and the backend is no longer needed.
