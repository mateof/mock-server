# MCP Server

Mock Server exposes an MCP (Model Context Protocol) endpoint so an AI assistant can build mock flows for you: list, create, edit and delete routes, set conditional responses, configure proxy transforms and validate everything before saving.

## Setting up the connection

1. Open the panel and go to **Tools → MCP Connection**
2. Give the connection a name (for example, "Claude on my laptop") and click **Create**
3. Copy the command shown and paste it into your terminal:

```bash
claude mcp add --scope user --transport http mock-server http://localhost:3880/mcp --header "Authorization: Bearer <token>"
```

The URL is built from the address you used to open the panel, so it already points at the right host: open the panel on `http://192.168.1.50:3880` and the command carries that address, not `localhost`.

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

### Writing

| Tool | What it does |
|------|--------------|
| `create_route` | Creates a mock or proxy route |
| `update_route` | Changes only the fields passed; everything else is kept |
| `delete_route` | Deletes a route and everything attached to it |
| `set_route_conditions` | Replaces the conditional responses of a route |
| `set_proxy_transform` | Sets request header/parameter rules and the `ms.*` scripts |

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

## What the assistant cannot do

The tool surface is deliberately limited to route configuration:

- No file uploads (the `file` response type keeps its file when edited through MCP)
- No import/export, no OpenAPI import
- No releasing requests held by active wait
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
