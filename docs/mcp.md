# MCP Server

Mock Server exposes an MCP (Model Context Protocol) endpoint so an AI assistant can build mock flows for you: list, create, edit and delete routes, set conditional responses, configure proxy transforms and validate everything before saving.

## Setting up the connection

1. Open the panel and go to **Tools → MCP Connection**
2. Give the connection a name (for example, "Claude on my laptop") and click **Create**
3. Pick your client from the selector and copy what it shows:

```bash
claude mcp add --scope user --transport http mock-server http://localhost:3880/mcp --header "Authorization: Bearer <token>"
```

The URL is built from the address you used to open the panel, so it already points at the right host: open the panel on `http://192.168.1.50:3880` and the command carries that address, not `localhost`.

### Supported clients

| Client | What you get | Where it goes |
|--------|--------------|---------------|
| Claude Code | `claude mcp add` command | Your terminal |
| Gemini CLI | `gemini mcp add` command | Your terminal |
| Cursor | `mcpServers` entry with `url` and `headers` | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| VS Code | `servers` entry with `type: http` | `.vscode/mcp.json` |
| Claude Desktop | `mcpServers` entry going through `mcp-remote` | `claude_desktop_config.json` |
| Codex CLI | `[mcp_servers.mock-server]` block | `~/.codex/config.toml` |
| Any other | The raw URL and header | Wherever your client wants them |

Three of them carry a warning in the panel, because they are the ones that fail confusingly:

- **VS Code** drops the headers silently if the config sits in a `.mcp.json` at the project root instead of `.vscode/mcp.json`, and the connection then fails as unauthenticated.
- **Claude Desktop** does not speak MCP over HTTP directly, so the snippet bridges through `mcp-remote` and needs Node installed.
- **Codex** reads the token from an environment variable, not from the file.

Connections are listed in the same modal, with their last use, a button to show the command again and one to revoke them.

## Endpoint

| Item | Value |
|------|-------|
| URL | `<panel address>/mcp` |
| Transport | Streamable HTTP |
| Method | `POST` (`GET` and `DELETE` answer `405`) |
| Auth | `Authorization: Bearer <token>` |
| Session | None: every request is self-contained |

The server is stateless on purpose. A tool-only server needs nothing between calls, so there are no sessions to expire and nothing to clean up if a client disappears without warning.

## Tools

### Reading

| Tool | What it does |
|------|--------------|
| `server_info` | Version, route counts by type and the rules worth knowing before creating anything |
| `list_routes` | Routes in priority order, filterable by method, response type, state and free text |
| `get_route` | Full detail of one route, including conditions, fallbacks and transforms |
| `list_tags` | Tags available to classify routes |
| `query_logs` | The recorded traffic: what arrived, what was answered, how long it took |
| `log_stats` | Totals by level, type and status, durations and a histogram |
| `get_trace` | The full story of one request in order, from the route that matched to the answer |

### Writing

| Tool | What it does |
|------|--------------|
| `create_route` | Creates a route of any type |
| `update_route` | Changes only the fields passed; everything else is kept |
| `delete_route` | Deletes a route and everything attached to it |
| `duplicate_route` | Copies a route with its conditions, fallbacks, operations and messages |
| `set_route_conditions` | Replaces the conditional responses of a route |
| `set_proxy_transform` | Sets request header/parameter rules and the `ms.*` scripts |
| `set_proxy_fallbacks` | Sets the answers for when the backend times out, refuses or fails |
| `set_graphql_operations` | Sets the operations of a GraphQL route |
| `import_graphql_schema` | Introspects a real GraphQL endpoint and generates the operations |
| `set_websocket_messages` | Sets the on-connect, on-message and periodic handlers |
| `reorder_routes` | Sets which route wins when several match |
| `create_tag` / `delete_tag` | Manages tags |

### Recording

| Tool | What it does |
|------|--------------|
| `set_route_recording` | Puts a proxy route into recording mode: every backend response becomes a mock route |
| `create_mocks_from_logs` | Turns traffic already in the log into mocks: "everything that went through /orders in the last hour" |
| `create_mock_from_log_entry` | Turns one log line into a mock, by the id `query_logs` returns |

Recorded routes are created **inactive**, because a mock outranks the proxy and an active one would stop any further traffic reaching the backend. Activate them with `update_route` once the session is captured. See [Recording](recording.md) for the whole picture.

### Building a flow

Some route types are inert until their pieces are configured, so the order matters:

| Type | Sequence |
|------|----------|
| Mock | `create_route` → `set_route_conditions` |
| Proxy | `create_route` (response = target URL) → `set_proxy_transform` → `set_proxy_fallbacks` |
| GraphQL | `create_route` → `import_graphql_schema` or `set_graphql_operations` |
| WebSocket | `create_route` → `set_websocket_messages` |

`server_info` returns this same table, so the assistant does not have to guess.

### Validation

| Tool | What it does |
|------|--------------|
| `validate_script` | Checks an `ms.*` script and optionally runs it against a test context |
| `validate_criteria` | Checks a conditional-response expression |
| `validate_regex` | Checks a regex path and whether it matches a test URL |

## Example session

> Create a mock at `/api-test/orders` returning three orders, and make it return a 500 when the header `x-fail` is present.

The assistant would call `create_route` and then `set_route_conditions`, and can verify the result with `get_route` or by requesting the route itself.

> The `/legacy` proxy needs an API key added and the response trimmed to the fields the app uses.

`set_proxy_transform` with `request_headers` and a `post_script`. It can try the script with `validate_script` before saving it.

> Mock everything that went through `/orders` in the last hour.

`create_mocks_from_logs` with `url` and `from`. It keeps the newest response for each method and path, so repeated calls give one route each, and reports what it could not convert instead of writing a broken mock.

## What the assistant cannot do

The whole route configuration surface is covered. What is left out is either binary payloads or runtime operation, not configuration:

- No file uploads (the `file` response type keeps its file when edited through MCP)
- No export/import of bundles, and no OpenAPI import
- No releasing requests held by active wait, and no listing of them
- No sending messages to connected WebSocket clients or disconnecting them
- No reading or writing the MCP tokens themselves

## Security

The token grants full control over the route configuration: creating, modifying and deleting. Treat it like a password.

- Tokens are stored in the database in clear text. This is deliberate: the panel itself has no authentication, so anyone who can read the table can already create new tokens, and being able to copy an existing one again avoids having to redo the connection.
- Revoking a connection takes effect immediately: the next request with that token gets a `401`.
- The `/mcp` prefix is reserved, exactly like `/api`. Trying to create a mock route there is rejected, so a mock cannot shadow the endpoint and silently break the assistant's connection.

As with the rest of the application, do not expose this to an untrusted network.

## Implementation notes

- Built on the official `@modelcontextprotocol/sdk`, so protocol handling and future revisions come from upstream rather than from a hand-rolled JSON-RPC layer.
- Every write goes through `services/routes.service.js`, the same module the panel uses. Keeping one implementation is what stops the panel and the MCP surface from drifting apart in validation, ordering or proxy reloading.
- Tool activity is logged in the panel's live console with a 🤖 marker, so it is visible what the assistant changed and when.
