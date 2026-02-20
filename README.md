# MockServer

A powerful HTTP mocking and proxying application built with Express.js and Node.js. It provides a web-based interface for configuring dynamic mock routes, managing HTTP requests, and proxying traffic to backend servers.

## Features

### Route Management
- Create, read, update, delete mock routes
- Support for multiple HTTP methods (GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD, ANY)
- Regex pattern matching for advanced route matching
- Route prioritization with automatic order management
- Enable/disable routes without deletion

### Response Types
| Type | Description |
|------|-------------|
| **JSON** | JSON object responses |
| **XML** | XML document responses |
| **SOAP** | SOAP envelope responses |
| **Text** | Plain text responses |
| **HTML** | HTML document responses |
| **Page** | EJS template rendering |
| **File** | Upload and serve files (up to 50MB) |
| **Empty** | Empty 204 responses |
| **GraphQL** | GraphQL endpoint with per-operation mock/proxy support |
| **Proxy** | Forward requests to backend servers |
| **Redirect** | HTTP 301 redirects |

### Advanced Features

- **Active Wait Mode** - Block requests until manually triggered from UI
  - Allows testing timeout scenarios
  - Supports custom response overrides before release

- **Regex Route Matching** - Test routes with regex patterns in UI
  - Validation with test URL
  - Separate path extraction for proxies

- **Custom Headers** - Add, modify, or remove response headers
  - Array-based configuration: `{action: "set"|"remove", name, value}`
  - Applied to both mock and proxy responses

- **Request/Response Logging** - Real-time terminal-style console
  - Color-coded by type
  - Detailed proxy logs with collapsible request/response bodies
  - Export logs to file

- **GraphQL Mocking** - Full GraphQL endpoint simulation
  - Import schema from any GraphQL endpoint via introspection
  - Auto-generate mock operations with placeholder values
  - Per-operation proxy/mock hybrid mode
  - Selection set filtering (return only requested fields)
  - Multi-root-field query support with combined mock/proxy results
  - Built-in GraphiQL IDE with autocomplete and documentation
  - See [GraphQL Documentation](docs/graphql.md) for details

- **Proxy Configuration** - Forward requests to backend services
  - Prefix or regex-based route matching
  - Request/response header modification
  - Automatic decompression of gzipped responses

## Technology Stack

- **Backend:** Express.js, Node.js 20
- **Database:** SQLite3
- **Real-time:** Socket.IO
- **Frontend:** EJS templates, Bootstrap 5, jQuery, DataTables
- **File Handling:** Multer
- **Container:** Docker, Docker Compose

## Installation

### Prerequisites
- Node.js 20+
- npm or yarn

### Local Development

```bash
# Clone the repository
git clone <repository-url>
cd mockserver/code

# Install dependencies
npm install

# Start in development mode (with auto-reload)
npm run start:local

# Start in production mode
npm start
```

The application will be available at `http://localhost:3880`

## Docker Deployment

### Docker Compose

```bacd code
version: '3.4'

services:
  mockserver:
    image: ghcr.io/mateof/mock-server:latest
    container_name: mockserver
    restart: unless-stopped
    environment:
      - GENERIC_TIMEZONE=Europe/Madrid
      - TZ=Europe/Madrid
    #   NODE_ENV: production
    #   WS_PORT: 3880
    volumes:
      - /your/folder/data:/app/data
    ports:
      - 3880:3880

```

## Using Docker Compose

```bash
cd code

# Build and start
docker compose up -d --build

# Force rebuild without cache
docker compose build --no-cache
docker compose up -d

# Or in a single command
docker compose up -d --build --force-recreate

# Remove old image and rebuild
docker compose down --rmi local
docker compose up -d --build
```

### Using Podman Compose

```bash
# Force rebuild without cache
podman compose build --no-cache
podman compose up -d

# Or in a single command
podman compose up -d --build --force-recreate

# Remove old image and rebuild
podman compose down --rmi local
podman compose up -d --build
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3880 | Server port |
| `TZ` | Europe/Madrid | Timezone |

### Data Persistence

The application stores data in the `data/` directory:
- `database.db` - SQLite database with route configurations
- `uploads/` - Uploaded files for file-type responses

When using Docker, mount a volume to persist data:
```yaml
volumes:
  - /path/to/your/data:/app/data
```

## API Reference

### Route Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/routes` | Get all configured routes |
| POST | `/api/create` | Create a new route |
| PUT | `/api/update/:id` | Update an existing route |
| DELETE | `/api/delete/:id` | Delete a route |
| PUT | `/api/toggle-active/:id` | Enable/disable a route |
| PUT | `/api/toggle-wait/:id` | Enable/disable wait mode |

### Order Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| PUT | `/api/update-order/:id` | Update route priority |
| PUT | `/api/move-up/:id` | Move route up in priority |
| PUT | `/api/move-down/:id` | Move route down in priority |
| PUT | `/api/reorder` | Batch reorder routes |
| POST | `/api/normalize-order` | Reset order to sequential values |

### GraphQL

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/graphql-operations/:routeId` | Get GraphQL operations for a route |
| PUT | `/api/graphql-operations/:routeId` | Save GraphQL operations |
| POST | `/api/graphql-schema/import` | Import schema from remote endpoint |
| GET | `/api/graphql-schema/:routeId` | Get stored introspection schema |
| PUT | `/api/graphql-schema/:routeId` | Save/update introspection schema |
| GET | `/api/graphql-proxy-url/:routeId` | Get proxy URL for a GraphQL route |
| PUT | `/api/graphql-proxy-url/:routeId` | Save/update proxy URL |

### Utilities

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/initTask` | Trigger a waiting request |
| POST | `/api/validateRegex` | Validate regex patterns |

## Usage Examples

### Creating a Simple JSON Mock

1. Click "Nueva Ruta" (New Route)
2. Select HTTP method (e.g., GET)
3. Enter route path (e.g., `/api/users`)
4. Select response type: JSON
5. Enter response body:
   ```json
   {
     "users": [
       {"id": 1, "name": "John"},
       {"id": 2, "name": "Jane"}
     ]
   }
   ```
6. Set status code (e.g., 200)
7. Save

### Creating a Proxy Route

1. Click "Nueva Ruta"
2. Select HTTP method: ANY
3. Enter route path (e.g., `/api/external`)
4. Select response type: Proxy
5. Enter target URL: `https://api.example.com`
6. Save

### Using Regex Routes

1. Enable "Regex" checkbox
2. Enter pattern: `/api/users/\d+`
3. This will match `/api/users/1`, `/api/users/123`, etc.

### Testing with Wait Mode

1. Enable "Espera Activa" (Active Wait) on a route
2. Send a request to that route
3. Request will be blocked and appear in pending list
4. Click "Pendientes" to see waiting requests
5. Click trigger button to release with default or custom response

### Creating a GraphQL Mock

1. Click "Nueva Ruta" (New Route)
2. Select HTTP method: POST
3. Enter route path: `/graphql`
4. Select response type: GraphQL
5. Click **Import Schema** and enter a GraphQL endpoint URL (e.g., `https://rickandmortyapi.com/graphql`)
6. Operations are auto-generated with mock values — edit responses as needed
7. Optionally set individual operations to **Proxy** mode to forward to the real API
8. Save
9. Click the test button (paper plane icon) to open GraphiQL IDE and test queries

For a detailed walkthrough, see [GraphQL Documentation](docs/graphql.md).

### Conditional Responses

Conditional responses allow you to return different responses based on request properties (headers, body, query params, etc.). Conditions are evaluated in order - the first matching condition wins.

#### Setting Up Conditional Responses

1. Create or edit a route
2. Expand the "Conditional Responses" section
3. Click "Add" to create a new condition
4. Enter a criteria expression (JavaScript)
5. Optionally override: status code, response type, and response body
6. Drag conditions to reorder priority
7. Save the route

#### Available Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `headers` | Request headers object | `headers['x-api-key']` |
| `body` | Parsed request body | `body.userId` |
| `query` | Query parameters | `query.debug` |
| `path` | URL path | `path` |
| `params` | Captured regex groups | `params['$1']` |
| `method` | HTTP method (lowercase) | `method === 'post'` |

#### Available Helper Functions

| Function | Description | Example |
|----------|-------------|---------|
| `includes(arr, val)` | Check if array/string contains value | `includes(headers['accept'], 'json')` |
| `startsWith(str, prefix)` | Check string prefix | `startsWith(path, '/api')` |
| `endsWith(str, suffix)` | Check string suffix | `endsWith(path, '/list')` |
| `match(str, regex)` | Test regex pattern | `match(path, '/users/\\d+')` |
| `hasKey(obj, key)` | Check if object has key | `hasKey(body, 'email')` |
| `isEmpty(val)` | Check if value is empty | `isEmpty(body.name)` |
| `isNotEmpty(val)` | Check if value is not empty | `isNotEmpty(query.filter)` |
| `equals(a, b)` | Strict equality | `equals(body.type, 'admin')` |
| `isNumber(val)` | Check if number | `isNumber(body.age)` |
| `isString(val)` | Check if string | `isString(body.name)` |
| `isArray(val)` | Check if array | `isArray(body.items)` |
| `length(val)` | Get length | `length(body.items) > 0` |
| `toNumber(val)` | Convert to number | `toNumber(query.page) > 1` |
| `toLowerCase(val)` | Convert to lowercase | `toLowerCase(headers['x-env']) === 'prod'` |

#### Criteria Expression Examples

```javascript
// Check header value
headers['x-api-key'] === 'premium'

// Check if header exists
hasKey(headers, 'authorization')

// Check body property
body.userId > 1000

// Check query parameter
query.debug === 'true'

// Check HTTP method
method === 'post'

// Combined conditions with AND
headers['x-api-key'] && body.type === 'admin'

// Combined conditions with OR
body.env === 'test' || query.mock === 'true'

// Using helper functions
hasKey(body, 'email') && isNotEmpty(body.email)

// Regex match on path
match(path, '/users/\\d+')

// Check if header contains value
includes(headers['content-type'], 'json')

// Check array length
isArray(body.items) && length(body.items) > 0

// Check numeric comparison
toNumber(body.amount) >= 100

// Complex condition
headers['x-env'] === 'staging' && hasKey(body, 'testMode') && body.testMode === true
```

#### Use Case Example

For an endpoint `/api/users`, you might want:

1. **Condition 1** - Premium users: `headers['x-subscription'] === 'premium'`
   - Return: Full user data with extra fields

2. **Condition 2** - Error simulation: `query.simulate === 'error'`
   - Return: 500 status with error message

3. **Condition 3** - Empty results: `query.filter === 'none'`
   - Return: Empty array `[]`

4. **Default** - Standard response for all other requests

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## Contributing

This is a private project. Please contact the maintainers for contribution guidelines.
