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


## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## Contributing

This is a private project. Please contact the maintainers for contribution guidelines.
