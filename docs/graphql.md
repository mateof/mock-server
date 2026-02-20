# GraphQL Support

Mock Server provides full GraphQL mocking capabilities, including schema import from remote endpoints, automatic mock generation, per-operation proxy/mock hybrid mode, and an integrated GraphiQL IDE for testing.

## Overview

GraphQL routes work differently from regular REST routes. Instead of a single response body, a GraphQL route contains **operations** — individual query and mutation handlers that are matched against incoming GraphQL requests. Each operation can independently return mock data or proxy to a real GraphQL server.

Key features:
- **Schema Import** — Fetch a schema from any GraphQL endpoint via introspection and auto-generate mock operations
- **Per-Operation Proxy/Mock** — Choose individually which operations return mock data and which forward to a real server
- **Selection Set Filtering** — Responses are automatically filtered to return only the fields requested in the query
- **Multi-Root-Field Queries** — Queries with multiple root fields are resolved individually, combining mock and proxy results
- **GraphiQL IDE** — Built-in GraphiQL editor with autocomplete, documentation, and schema explorer
- **Full Introspection** — Stored schemas provide complete introspection responses for tooling support

## Creating a GraphQL Route

1. Click **New Route**
2. Select HTTP method: **POST** (standard for GraphQL)
3. Enter the route path (e.g., `/graphql`)
4. Select response type: **GraphQL**
5. The GraphQL operations panel will appear
6. Add operations manually or import a schema
7. Save the route

## Operations

Each operation has the following fields:

| Field | Description |
|-------|-------------|
| **Type** | `query` or `mutation` |
| **Name** | The operation/field name (e.g., `characters`, `createUser`) |
| **Mode** | `Mock` (return stored response) or `Proxy` (forward to remote server) |
| **Response** | JSON response body (only for Mock mode) |
| **Active** | Enable/disable the operation |

### Operation Matching

When a GraphQL request arrives, the server matches it against stored operations:

1. **By operation name** — If the query has a named operation (e.g., `query GetUsers { ... }`), it matches against `operationName`
2. **By root field name** — For anonymous queries (e.g., `{ users { id name } }`), it matches the root field name against `operationName`
3. **Multi-root-field** — Queries with multiple root fields (e.g., `{ users { ... } posts { ... } }`) are resolved field-by-field, each matched independently

### Response Filtering

Mock responses are automatically filtered by the query's selection set. If your stored response contains more fields than requested, only the requested fields are returned.

**Stored mock response:**
```json
{
  "characters": {
    "info": { "count": 826, "pages": 42 },
    "results": [
      { "id": "1", "name": "Rick Sanchez", "status": "Alive", "species": "Human", "gender": "Male" }
    ]
  }
}
```

**Query requesting only `id` and `name`:**
```graphql
{ characters { results { id name } } }
```

**Returned response:**
```json
{
  "data": {
    "characters": {
      "results": [
        { "id": "1", "name": "Rick Sanchez" }
      ]
    }
  }
}
```

## Schema Import

You can import a complete GraphQL schema from any endpoint that supports introspection. This will:
1. Send a standard introspection query to the remote endpoint
2. Parse the schema (types, queries, mutations, enums, etc.)
3. Auto-generate mock operations with placeholder values for every query and mutation
4. Store the full schema for introspection support (enabling autocomplete in GraphiQL)
5. Set the endpoint URL as the proxy URL for hybrid mode

### How to Import

1. Create or edit a GraphQL route
2. Click **Import Schema**
3. Enter the URL of the GraphQL endpoint (e.g., `https://rickandmortyapi.com/graphql`)
4. Click **Import**
5. Operations will be generated and populated in the operations list
6. Edit responses as needed, then save

### Import API

```
POST /api/graphql-schema/import
Content-Type: application/json
```

**Request Body:**
```json
{
  "url": "https://rickandmortyapi.com/graphql",
  "routeId": 5
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | GraphQL endpoint URL |
| `routeId` | integer | No | If provided, saves operations and schema directly to this route |

**Response:**
```json
{
  "success": true,
  "schema": { "data": { "__schema": { "..." } } },
  "operations": [
    { "operationType": "query", "operationName": "characters", "respuesta": "...", "activo": 1 }
  ],
  "operationCount": 15
}
```

### Auto-Generated Mock Values

The mock generator produces placeholder values based on the schema types:

| GraphQL Type | Mock Value |
|-------------|------------|
| `String` | `"mock_string"` |
| `Int` | `42` |
| `Float` | `3.14` |
| `Boolean` | `true` |
| `ID` | `"mock-id-1"` |
| `Enum` | First enum value |
| `List` | Array with one mock element |
| `Object` | Recursively generated (max depth: 5) |
| Circular references | `null` |

## Hybrid Proxy/Mock Mode

Each operation can independently be set to **Mock** or **Proxy** mode:

- **Mock** — Returns the stored JSON response, filtered by selection set
- **Proxy** — Forwards the entire query to the configured remote GraphQL endpoint

This allows you to mock some operations while proxying others to a real server — useful for development when only part of the API is ready.

### Configuring Proxy Mode

1. Import a schema (this automatically sets the proxy URL)
2. Or manually enter the **Proxy URL** in the GraphQL section
3. For each operation, select **Mock** or **Proxy** from the mode dropdown
4. Save the route

### How Multi-Root-Field Proxy Works

When a query contains multiple root fields with mixed modes:

```graphql
query MultiEntityTest {
  characters(page: 1, filter: { name: "Rick" }) {  # Mock
    results { id name }
  }
  location(id: 1) {  # Proxy
    id name type
  }
}
```

The server:
1. Resolves `characters` from the stored mock response
2. Forwards the **entire original query** to the proxy endpoint
3. Extracts only the `location` field from the proxy response
4. Combines both results into a single response

### Proxy URL API

```
GET /api/graphql-proxy-url/:routeId
```

**Response:**
```json
{
  "success": true,
  "proxyUrl": "https://rickandmortyapi.com/graphql"
}
```

```
PUT /api/graphql-proxy-url/:routeId
Content-Type: application/json
```

**Request Body:**
```json
{
  "proxyUrl": "https://rickandmortyapi.com/graphql"
}
```

### Proxy Error Handling

If the proxy endpoint is unreachable or returns an error, the response includes GraphQL-standard errors:

```json
{
  "errors": [{ "message": "Proxy error: Proxy connection error: ECONNREFUSED" }],
  "data": null
}
```

For mixed proxy/mock queries, mock fields are still returned successfully while proxy errors are reported in the `errors` array.

## GraphiQL IDE

When you click the **Test Request** button (paper plane icon) on a GraphQL route, a full-featured GraphiQL IDE opens instead of the regular request tester.

GraphiQL provides:
- **Autocomplete** — Field and argument suggestions based on the stored schema
- **Documentation Explorer** — Browse types, queries, and mutations from the sidebar
- **Query Editor** — Syntax highlighting, formatting, and error detection
- **Variables Panel** — Define query variables as JSON
- **Response Viewer** — Formatted JSON response display

GraphiQL sends requests directly to the mock server's GraphQL endpoint, so you can test queries in real-time against your mock configuration.

> **Note:** Autocomplete and documentation require a stored schema. Import a schema or manually save one via the API to enable these features.

## Schema Storage API

### Get Stored Schema

```
GET /api/graphql-schema/:routeId
```

**Response:**
```json
{
  "success": true,
  "schema": { "data": { "__schema": { "..." } } }
}
```

### Save/Update Schema

```
PUT /api/graphql-schema/:routeId
Content-Type: application/json
```

**Request Body:**
```json
{
  "schema": { "data": { "__schema": { "..." } } }
}
```

## Operations API

### Get Operations

```
GET /api/graphql-operations/:routeId
```

**Response:**
```json
{
  "success": true,
  "operations": [
    {
      "id": 1,
      "route_id": 5,
      "orden": 0,
      "operationType": "query",
      "operationName": "characters",
      "respuesta": "{\"characters\": {\"results\": [{\"id\": \"1\", \"name\": \"Rick\"}]}}",
      "activo": 1,
      "useProxy": 0
    }
  ]
}
```

### Save Operations

```
PUT /api/graphql-operations/:routeId
Content-Type: application/json
```

**Request Body:**
```json
{
  "operations": [
    {
      "operationType": "query",
      "operationName": "characters",
      "respuesta": "{\"characters\": {\"results\": [{\"id\": \"1\", \"name\": \"Rick\"}]}}",
      "activo": true,
      "useProxy": false
    }
  ]
}
```

## Example: Rick and Morty API

This example demonstrates importing a schema from the Rick and Morty GraphQL API, customizing mock responses, and using hybrid proxy/mock mode.

### Step 1: Create the Route

1. Click **New Route**
2. Method: **POST**
3. Path: `/graphql`
4. Response type: **GraphQL**

### Step 2: Import the Schema

1. Click **Import Schema**
2. Enter URL: `https://rickandmortyapi.com/graphql`
3. Click **Import**
4. All queries and mutations will be populated with auto-generated mocks

### Step 3: Customize a Mock Response

Edit the `characters` operation response:

```json
{
  "characters": {
    "info": {
      "count": 826,
      "pages": 42
    },
    "results": [
      {
        "id": "1",
        "name": "Rick Sanchez",
        "status": "Alive",
        "species": "Human",
        "gender": "Male",
        "image": "https://rickandmortyapi.com/api/character/avatar/1.jpeg",
        "origin": {
          "id": "1",
          "name": "Earth (C-137)",
          "dimension": "Dimension C-137"
        },
        "location": {
          "id": "3",
          "name": "Citadel of Ricks",
          "type": "Space station",
          "dimension": "unknown"
        },
        "episode": [
          { "id": "1", "name": "Pilot", "air_date": "December 2, 2013", "episode": "S01E01" },
          { "id": "2", "name": "Lawnmower Dog", "air_date": "December 9, 2013", "episode": "S01E02" }
        ]
      }
    ]
  }
}
```

### Step 4: Configure Hybrid Mode

Set some operations to **Proxy** mode to forward real data:
- `location` → **Proxy** (get real location data from the API)
- `episodesByIds` → **Proxy** (get real episode data)
- `characters` → **Mock** (use customized response above)

### Step 5: Test with a Multi-Entity Query

Open GraphiQL (click the test button) and run:

```graphql
query MultiEntityTest {
  characters(page: 1, filter: { name: "Rick" }) {
    info {
      count
      pages
    }
    results {
      id
      name
      status
      species
      gender
      image
      origin {
        id
        name
        dimension
      }
      location {
        id
        name
        type
        dimension
      }
      episode {
        id
        name
        air_date
        episode
      }
    }
  }
  location(id: 1) {
    id
    name
    type
    dimension
    residents {
      id
      name
      status
      species
    }
  }
  episodesByIds(ids: [1, 2, 3]) {
    id
    name
    air_date
    episode
    characters {
      id
      name
      status
    }
  }
}
```

The response will combine:
- `characters` — From the custom mock response (filtered by selection set)
- `location` — Real data from the Rick and Morty API (proxied)
- `episodesByIds` — Real data from the Rick and Morty API (proxied)

## Introspection

Mock Server supports GraphQL introspection queries, which are used by tools like GraphiQL for autocomplete and documentation.

### With Stored Schema

If a schema has been imported, introspection returns the full stored schema. This provides complete type information for all fields, arguments, enums, interfaces, and unions.

### Without Stored Schema

If no schema is stored, introspection returns a minimal generated schema based on the configured operations. Each operation appears as a field with a generic `JSON` scalar return type. This provides basic autocomplete but without detailed type information.

## Duplicate and Export

### Duplicating a GraphQL Route

When you duplicate a GraphQL route, all GraphQL-specific data is copied:
- All operations (with their mock responses and proxy settings)
- The stored schema
- The proxy URL

### Export/Import

GraphQL routes are fully supported by the export/import system. See [Export/Import Documentation](export-import.md) for details on the data format.
