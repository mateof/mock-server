# Export/Import Documentation

This document describes the export and import functionality of Mock Server, including the file structure, data format, and usage instructions.

## Overview

The Export/Import feature allows you to:
- **Export** all configured routes, tags, conditions, and optionally uploaded files as a compressed ZIP archive
- **Import** previously exported data to restore or migrate configurations between Mock Server instances
- **Import from Git Repository** by cloning and importing files directly from a git repository
- **Auto-import on Startup** by placing files in the import directory or configuring environment variables

## Export

### How to Export

1. Open Mock Server in your browser
2. Click on **Tools** dropdown in the toolbar
3. Select **Export / Import**
4. In the Export tab, you'll see a preview of what will be exported:
   - Number of routes
   - Number of tags
   - Number of conditions
   - Number of uploaded files
5. Choose the export format:
   - **JSON** (default): Human-readable, recommended for most cases
   - **XML**: Alternative format for systems that prefer XML
6. Optionally check **Include uploaded files** to include files from the uploads folder
7. Click **Download Export** to download the ZIP archive

### Export API Endpoint

```
GET /api/export?format=json&includeFiles=true
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `format` | string | `json` | Export format: `json` or `xml` |
| `includeFiles` | boolean | `false` | Include uploaded files in the export |

**Response:** ZIP file download

### Export Preview API

```
GET /api/export/preview
```

**Response:**
```json
{
  "success": true,
  "stats": {
    "routes": 15,
    "tags": 5,
    "conditions": 8,
    "files": 3
  }
}
```

## Import

Mock Server supports three import methods:
1. **File Upload**: Upload a ZIP archive exported from Mock Server
2. **Git Repository**: Clone and import from a git repository
3. **Import Folder**: Import from files placed in the import directory

### Import from File Upload

1. Open Mock Server in your browser
2. Click on **Tools** dropdown in the toolbar
3. Select **Export / Import**
4. Switch to the **Import** tab
5. Select **Upload File** source
6. Click **Choose File** and select a previously exported ZIP file
7. Configure the conflict strategy:
   - **Skip**: Keep existing routes, don't overwrite
   - **Overwrite**: Update existing routes with imported data
   - **Duplicate**: Create new routes even if they already exist
8. Optionally check **Import uploaded files** to import files from the package
9. Click **Start Import** to begin the import process

### Import from Git Repository

You can import configurations directly from a git repository. The repository can contain uncompressed JSON or XML files (not ZIP archives).

1. Open Mock Server in your browser
2. Click on **Tools** > **Export / Import**
3. Switch to the **Import** tab
4. Select **Git Repository** source
5. Enter the repository URL (HTTPS or SSH)
6. Optionally specify:
   - **Branch**: Target branch (leave empty for default branch)
   - **Commit**: Specific commit hash
   - **SSH Private Key**: Required for private repositories using SSH
7. Configure the conflict strategy
8. Click **Start Import**

The import process will:
1. Clone the repository to a temporary directory
2. Checkout the specified branch/commit (if provided)
3. Scan for valid import files (ZIP, JSON, XML)
4. Import all found configurations
5. Delete the cloned repository

**Supported file formats in git repositories:**
- `data.json` or files with names containing "export" or "mock" (e.g., `mock-routes.json`, `api-export.json`)
- `data.xml` or files with names containing "export" or "mock" (e.g., `mock-routes.xml`, `api-export.xml`)
- ZIP archives exported from Mock Server

### Import from Folder

Files placed in the `data/import` directory will be available for import through the UI.

1. Place your export files (ZIP, JSON, or XML) in `data/import/` directory
2. Files can be organized in subdirectories
3. Open Mock Server and go to **Tools** > **Export / Import**
4. Select **Import Folder** source
5. You'll see a list of available files
6. Configure the conflict strategy
7. Click **Start Import**

## Import API Endpoints

### File Upload Import

```
POST /api/import
Content-Type: multipart/form-data
```

**Form Data:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | ZIP file to import |
| `conflictStrategy` | string | No | How to handle existing routes: `skip`, `overwrite`, or `duplicate` (default: `skip`) |
| `importFiles` | boolean | No | Whether to import uploaded files (default: `true`) |

### Git Repository Import

```
POST /api/import/git
Content-Type: application/json
```

**Request Body:**
```json
{
  "repoUrl": "https://github.com/user/repo.git",
  "branch": "main",
  "commit": "abc123",
  "sshKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
  "conflictStrategy": "skip"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repoUrl` | string | Yes | Git repository URL (HTTPS or SSH) |
| `branch` | string | No | Branch to checkout (default: repository default) |
| `commit` | string | No | Specific commit hash to checkout |
| `sshKey` | string | No | SSH private key for authentication |
| `conflictStrategy` | string | No | Conflict strategy: `skip`, `overwrite`, `duplicate` |

### Directory Import

**List available files:**
```
GET /api/import/directory
```

**Response:**
```json
{
  "success": true,
  "files": [
    {
      "name": "data.json",
      "path": "data.json",
      "type": "JSON",
      "size": 15360,
      "sizeFormatted": "15 KB",
      "modified": "2024-01-15T10:30:00.000Z"
    }
  ],
  "directory": "/app/data/import"
}
```

**Import all files from directory:**
```
POST /api/import/directory
Content-Type: application/json
```

**Request Body:**
```json
{
  "conflictStrategy": "skip"
}
```

## Auto-Import on Startup

Mock Server can automatically import configurations when it starts. This is useful for Docker deployments or CI/CD pipelines.

### Import Directory

On startup, Mock Server:
1. Creates the `data/import` directory if it doesn't exist
2. Scans the directory (including subdirectories) for valid import files
3. Imports all found files using the configured conflict strategy

### Environment Variables for Docker

Configure automatic import via environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `MOCK_SERVER_GIT_REPO` | Git repository URL to clone and import | `https://github.com/user/mock-configs.git` |
| `MOCK_SERVER_GIT_BRANCH` | Branch to checkout | `main` |
| `MOCK_SERVER_GIT_COMMIT` | Specific commit hash | `abc123def456` |
| `MOCK_SERVER_GIT_SSH_KEY` | SSH private key (for private repos) | Contents of private key file |
| `MOCK_SERVER_IMPORT_CONFLICT` | Conflict strategy | `skip`, `overwrite`, or `duplicate` |

**Docker Compose Example:**

```yaml
version: '3.8'
services:
  mock-server:
    image: mock-server:latest
    ports:
      - "3880:3880"
    environment:
      - MOCK_SERVER_GIT_REPO=https://github.com/myorg/mock-configs.git
      - MOCK_SERVER_GIT_BRANCH=main
      - MOCK_SERVER_IMPORT_CONFLICT=overwrite
    volumes:
      - mock-data:/app/data

volumes:
  mock-data:
```

**Docker Compose with SSH Key (for private repos):**

```yaml
version: '3.8'
services:
  mock-server:
    image: mock-server:latest
    ports:
      - "3880:3880"
    environment:
      - MOCK_SERVER_GIT_REPO=git@github.com:myorg/private-mock-configs.git
      - MOCK_SERVER_GIT_BRANCH=main
      - MOCK_SERVER_GIT_SSH_KEY=${GIT_SSH_KEY}
      - MOCK_SERVER_IMPORT_CONFLICT=skip
    volumes:
      - mock-data:/app/data

volumes:
  mock-data:
```

**Using with Docker run:**

```bash
docker run -d \
  -p 3880:3880 \
  -e MOCK_SERVER_GIT_REPO=https://github.com/myorg/mock-configs.git \
  -e MOCK_SERVER_GIT_BRANCH=main \
  -e MOCK_SERVER_IMPORT_CONFLICT=skip \
  mock-server:latest
```

### Startup Import Order

When Mock Server starts, imports are processed in this order:
1. **Git Repository** (if `MOCK_SERVER_GIT_REPO` is set): Clone, import, and delete
2. **Import Directory**: Scan and import all valid files from `data/import/`

## ZIP Archive Structure

The exported ZIP file has the following structure:

```
mock-server-export-YYYY-MM-DD.zip
├── manifest.json          # Metadata about the export
├── data.json              # (or data.xml) Main data file
└── uploads/               # (optional) Uploaded files
    ├── file1.pdf
    ├── image.png
    └── ...
```

### manifest.json

Contains metadata about the export:

```json
{
  "version": "1.0.0",
  "exportedAt": "2024-01-15T10:30:00.000Z",
  "format": "json",
  "stats": {
    "routes": 15,
    "tags": 5,
    "conditions": 8,
    "files": 3
  }
}
```

### data.json (JSON Format)

```json
{
  "routes": [
    {
      "id": 1,
      "orden": 1,
      "tipo": "get",
      "ruta": "/api/users",
      "codigo": "200",
      "tiporespuesta": "json",
      "respuesta": "{\"users\": []}",
      "isRegex": 0,
      "activo": 1,
      "esperaActiva": 0,
      "proxyDestination": null,
      "customHeaders": null,
      "fileToReturn": null,
      "tags": "[{\"id\":\"tag1\",\"name\":\"API\",\"color\":\"#6366f1\"}]",
      "operationId": "getUsers",
      "summary": "Get all users",
      "description": "Returns a list of all users",
      "requestBodyExample": null
    }
  ],
  "tags": [
    {
      "id": "tag1",
      "name": "API",
      "color": "#6366f1"
    }
  ],
  "conditions": [
    {
      "id": 1,
      "routeId": 1,
      "nombre": "Admin User",
      "orden": 1,
      "criterio": "headers['x-role'] === 'admin'",
      "codigo": "200",
      "tiporespuesta": "json",
      "respuesta": "{\"users\": [], \"isAdmin\": true}",
      "customHeaders": null
    }
  ]
}
```

### data.xml (XML Format)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<mockServerExport>
  <routes>
    <route>
      <id>1</id>
      <orden>1</orden>
      <tipo>get</tipo>
      <ruta>/api/users</ruta>
      <codigo>200</codigo>
      <tiporespuesta>json</tiporespuesta>
      <respuesta><![CDATA[{"users": []}]]></respuesta>
      <isRegex>0</isRegex>
      <activo>1</activo>
      <esperaActiva>0</esperaActiva>
      <proxyDestination></proxyDestination>
      <customHeaders></customHeaders>
      <fileToReturn></fileToReturn>
      <tags><![CDATA[[{"id":"tag1","name":"API","color":"#6366f1"}]]]></tags>
      <operationId>getUsers</operationId>
      <summary>Get all users</summary>
      <description>Returns a list of all users</description>
      <requestBodyExample></requestBodyExample>
    </route>
  </routes>
  <tags>
    <tag>
      <id>tag1</id>
      <name>API</name>
      <color>#6366f1</color>
    </tag>
  </tags>
  <conditions>
    <condition>
      <id>1</id>
      <routeId>1</routeId>
      <nombre>Admin User</nombre>
      <orden>1</orden>
      <criterio>headers['x-role'] === 'admin'</criterio>
      <codigo>200</codigo>
      <tiporespuesta>json</tiporespuesta>
      <respuesta><![CDATA[{"users": [], "isAdmin": true}]]></respuesta>
      <customHeaders></customHeaders>
    </condition>
  </conditions>
</mockServerExport>
```

## Uncompressed File Formats

For git repositories and the import directory, Mock Server can import uncompressed JSON and XML files directly (not just ZIP archives).

### Valid File Names

Files must have one of the following name patterns:
- `data.json` / `data.xml`
- Files containing "export" (e.g., `api-export.json`, `routes-export.xml`)
- Files containing "mock" (e.g., `mock-routes.json`, `mock-config.xml`)

### Example: Uncompressed JSON File

Create a `data.json` file with the same structure as inside the ZIP:

```json
{
  "routes": [
    {
      "tipo": "get",
      "ruta": "/api/users",
      "codigo": "200",
      "tiporespuesta": "json",
      "respuesta": "{\"users\": []}"
    }
  ],
  "tags": [],
  "conditions": []
}
```

## Data Fields Reference

### Routes

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Unique route identifier |
| `orden` | integer | Order/priority of the route |
| `tipo` | string | HTTP method (get, post, put, delete, patch, options, head, any) |
| `ruta` | string | Route path (e.g., `/api/users`) |
| `codigo` | string | HTTP response code |
| `tiporespuesta` | string | Response type (json, xml, soap, text, html, page, file, proxy, empty) |
| `respuesta` | string | Response body content |
| `isRegex` | integer | 1 if route uses regex, 0 otherwise |
| `activo` | integer | 1 if route is active, 0 otherwise |
| `esperaActiva` | integer | 1 if active wait mode is enabled, 0 otherwise |
| `proxyDestination` | string | Proxy destination URL (for proxy routes) |
| `customHeaders` | string | JSON string of custom headers |
| `fileToReturn` | string | Filename to return (for file routes) |
| `tags` | string | JSON array of tag objects |
| `operationId` | string | OpenAPI operation ID |
| `summary` | string | Route summary |
| `description` | string | Route description |
| `requestBodyExample` | string | Example request body JSON |

### Tags

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique tag identifier (UUID) |
| `name` | string | Tag name |
| `color` | string | Tag color (hex code) |

### Conditions

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Unique condition identifier |
| `routeId` | integer | Associated route ID |
| `nombre` | string | Condition name |
| `orden` | integer | Condition order/priority |
| `criterio` | string | JavaScript condition expression |
| `codigo` | string | HTTP response code |
| `tiporespuesta` | string | Response type |
| `respuesta` | string | Response body content |
| `customHeaders` | string | JSON string of custom headers |

## Use Cases

### Backup Configuration

Create periodic backups of your Mock Server configuration:

```bash
# Using curl to export
curl -o backup-$(date +%Y%m%d).zip "http://localhost:3880/api/export?format=json&includeFiles=true"
```

### Migration Between Environments

1. Export from development environment
2. Import to staging/production environment with appropriate conflict strategy

### Sharing Configurations

Share mock configurations with team members by exporting and distributing the ZIP file or committing to a shared git repository.

### Version Control

Export configurations in JSON format and commit to version control for tracking changes. Use uncompressed `data.json` files for better diff visibility.

### CI/CD Pipeline Integration

Use environment variables to automatically load configurations:

```yaml
# GitLab CI example
deploy:
  image: mock-server:latest
  variables:
    MOCK_SERVER_GIT_REPO: $MOCK_CONFIG_REPO
    MOCK_SERVER_GIT_BRANCH: $CI_COMMIT_REF_NAME
    MOCK_SERVER_IMPORT_CONFLICT: overwrite
```

### Docker Development Setup

Mount a local directory with your mock configurations:

```bash
docker run -d \
  -p 3880:3880 \
  -v $(pwd)/mocks:/app/data/import \
  mock-server:latest
```

## Notes

- Route IDs are regenerated during import to avoid conflicts
- Conditions are automatically linked to their corresponding imported routes
- Tags are matched by name (case-insensitive) to avoid duplicates
- Uploaded files maintain their original filenames; existing files are overwritten if `importFiles` is enabled
- The import process is atomic - if any error occurs, partial changes may have been applied
- Git repository clones are automatically deleted after import
- SSH keys provided via API or environment variables are deleted after use for security
