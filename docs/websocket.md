# WebSocket Support

Mock Server provides WebSocket mocking capabilities, allowing you to simulate WebSocket endpoints with configurable message handling, automatic responses, and a real-time client management panel.

## Overview

WebSocket routes create real WebSocket endpoints on the same server and port as the HTTP mock server. Clients connect using the standard WebSocket protocol (`ws://`) and receive responses based on configurable message handlers.

Key features:
- **On Connect Messages** — Send messages automatically when a client connects
- **Pattern-Based Responses** — Match incoming messages by exact text or regex and respond accordingly
- **Periodic Messages** — Send messages at regular intervals to connected clients
- **Client Management Panel** — View connected clients, send manual messages, and disconnect clients from the UI
- **Real-Time Monitoring** — All WebSocket activity is logged in the real-time console
- **Export/Import** — Full support in the export/import system

## Creating a WebSocket Route

1. Click **New Route**
2. Enter the route path (e.g., `/ws/chat`)
3. Select response type: **WebSocket**
4. The WebSocket messages panel will appear
5. Add message handlers (on connect, on message, periodic)
6. Save the route

Once saved, clients can connect to `ws://localhost:3880/ws/chat`.

> **Note:** The HTTP method field is hidden for WebSocket routes since WebSocket connections use the HTTP Upgrade mechanism, not standard HTTP methods.

## Message Types

Each WebSocket route can have multiple message handlers of three types:

### On Connect

Messages sent automatically when a client establishes a connection.

| Field | Description |
|-------|-------------|
| **Response Message** | The message to send to the client |
| **Delay** | Time in milliseconds to wait before sending (default: 0) |

**Use case:** Send a welcome message, initial state, or authentication challenge.

### On Message

Messages sent in response to incoming client messages that match a pattern.

| Field | Description |
|-------|-------------|
| **Match Pattern** | Text or regex to match against incoming messages |
| **Regex** | Enable regex matching (default: exact text match) |
| **Response Message** | The message to send back |
| **Delay** | Time in milliseconds to wait before responding (default: 0) |

Messages are evaluated in order — the first matching handler wins.

An empty match pattern matches all incoming messages (catch-all).

**Use case:** Simulate request/response protocols, echo services, or command handlers.

### Periodic

Messages sent at regular intervals while the client is connected.

| Field | Description |
|-------|-------------|
| **Response Message** | The message to send periodically |
| **Interval** | Time in milliseconds between messages |
| **Delay** | Initial delay before the first message (default: 0) |

**Use case:** Simulate heartbeats, real-time data feeds, stock tickers, or push notifications.

## Route Matching

WebSocket routes support three matching modes:

1. **Exact match** — The client's connection path must exactly match the route path
2. **Wildcard** — Routes ending with `/*` match any path with that prefix (e.g., `/ws/*` matches `/ws/room1`, `/ws/chat/general`)
3. **Regex** — Enable the regex checkbox to use regex patterns for matching (e.g., `/ws/room/\d+`)

Routes are evaluated in order (by the `orden` field), so more specific routes should have a lower order number.

## Client Management Panel

Access the WebSocket Clients panel from **Tools** > **WebSocket Clients**.

### Connected Clients List

Each connected client shows:
- **Path** — The WebSocket endpoint path
- **IP Address** — Client's IP address
- **Connection Duration** — How long the client has been connected
- **Messages Received** — Number of messages received from the client
- **Messages Sent** — Number of messages sent to the client

The client count badge in the Tools menu updates in real time.

### Sending Manual Messages

From the clients panel you can send messages to connected clients:

1. Type your message in the text area
2. Choose the target:
   - **All connected clients** — Broadcast to everyone
   - **Selected clients only** — Send to checked clients
3. Click **Send**

This is useful for testing push notifications, triggering client-side events, or simulating server-initiated messages.

### Disconnecting Clients

Click the disconnect button (X icon) on any client to close its connection from the server side with a clean close frame (code 1000).

## Real-Time Logging

All WebSocket activity appears in the real-time console log:

- `🔌 WS conectado` — Client connected
- `🔌 WS desconectado` — Client disconnected
- `🔌 WS recibido` — Message received from client
- `🔌 WS enviado [onConnect]` — On-connect message sent
- `🔌 WS enviado [onMessage]` — Response message sent
- `🔌 WS enviado [periodic]` — Periodic message sent
- `🔌 WS enviado [manual]` — Manual message sent from UI

## API Reference

### WebSocket Messages CRUD

#### Get Messages for a Route

```
GET /api/ws-messages/:routeId
```

**Response:**
```json
{
  "success": true,
  "messages": [
    {
      "id": 1,
      "route_id": 5,
      "orden": 0,
      "event_type": "onConnect",
      "match_pattern": null,
      "is_regex": 0,
      "respuesta": "{\"type\": \"welcome\", \"message\": \"Connected!\"}",
      "delay": 0,
      "send_interval": 0,
      "activo": 1,
      "nombre": "Welcome message"
    }
  ]
}
```

#### Save Messages for a Route

```
PUT /api/ws-messages/:routeId
Content-Type: application/json
```

**Request Body:**
```json
{
  "messages": [
    {
      "event_type": "onConnect",
      "respuesta": "{\"type\": \"welcome\"}",
      "delay": 0,
      "activo": true,
      "nombre": "Welcome"
    },
    {
      "event_type": "onMessage",
      "match_pattern": "ping",
      "is_regex": false,
      "respuesta": "pong",
      "delay": 0,
      "activo": true,
      "nombre": "Ping handler"
    },
    {
      "event_type": "periodic",
      "respuesta": "{\"type\": \"heartbeat\"}",
      "delay": 1000,
      "send_interval": 5000,
      "activo": true,
      "nombre": "Heartbeat"
    }
  ]
}
```

### Client Management

#### Get Connected Clients

```
GET /api/ws-clients
```

**Response:**
```json
{
  "success": true,
  "clients": [
    {
      "id": "a1b2c3d4-...",
      "routeId": 5,
      "path": "/ws/chat",
      "ip": "::1",
      "connectedAt": 1711234567890,
      "duration": 15234,
      "messagesReceived": 3,
      "messagesSent": 7
    }
  ]
}
```

#### Send Message to Clients

```
POST /api/ws-clients/send
Content-Type: application/json
```

**Request Body:**
```json
{
  "clientIds": ["a1b2c3d4-...", "e5f6g7h8-..."],
  "message": "{\"type\": \"notification\", \"text\": \"Hello!\"}"
}
```

**Response:**
```json
{
  "success": true,
  "sent": 2
}
```

#### Disconnect a Client

```
POST /api/ws-clients/disconnect
Content-Type: application/json
```

**Request Body:**
```json
{
  "clientId": "a1b2c3d4-..."
}
```

## Database Schema

### websocket_messages Table

| Field | Type | Description |
|-------|------|-------------|
| `id` | INTEGER | Primary key |
| `route_id` | INTEGER | Foreign key to `rutas` table |
| `orden` | INTEGER | Message order/priority |
| `event_type` | TEXT | `onConnect`, `onMessage`, or `periodic` |
| `match_pattern` | TEXT | Pattern for matching incoming messages (onMessage only) |
| `is_regex` | INTEGER | 1 if pattern is regex, 0 for exact match |
| `respuesta` | TEXT | Message to send |
| `delay` | INTEGER | Delay in milliseconds before sending |
| `send_interval` | INTEGER | Interval in milliseconds for periodic messages |
| `activo` | INTEGER | 1 if active, 0 if disabled |
| `nombre` | TEXT | Display name for the message handler |

## Export/Import

WebSocket routes are fully supported by the export/import system. When exporting, each WebSocket route includes its `websocketMessages` array.

**JSON format:**
```json
{
  "tipo": "get",
  "ruta": "/ws/chat",
  "tiporespuesta": "websocket",
  "websocketMessages": [
    {
      "orden": 0,
      "event_type": "onConnect",
      "respuesta": "{\"type\": \"welcome\"}",
      "delay": 0,
      "activo": 1,
      "nombre": "Welcome"
    },
    {
      "orden": 1,
      "event_type": "onMessage",
      "match_pattern": "ping",
      "is_regex": 0,
      "respuesta": "pong",
      "delay": 0,
      "activo": 1,
      "nombre": "Ping"
    }
  ]
}
```

**XML format:**
```xml
<route>
  <ruta>/ws/chat</ruta>
  <tiporespuesta>websocket</tiporespuesta>
  <websocketMessages>
    <wsMessage>
      <orden>0</orden>
      <event_type>onConnect</event_type>
      <respuesta><![CDATA[{"type": "welcome"}]]></respuesta>
      <delay>0</delay>
      <activo>1</activo>
      <nombre>Welcome</nombre>
    </wsMessage>
  </websocketMessages>
</route>
```

## Example: Chat Room Mock

This example creates a WebSocket endpoint that simulates a simple chat room.

### Step 1: Create the Route

1. Click **New Route**
2. Path: `/ws/chat`
3. Response type: **WebSocket**

### Step 2: Add Message Handlers

**1. Welcome message (onConnect):**
- Type: On Connect
- Response: `{"type": "system", "message": "Welcome to the chat room!", "users": 3}`
- Delay: 0

**2. Echo handler (onMessage, regex):**
- Type: On Message
- Pattern: `.*` (regex enabled)
- Response: `{"type": "echo", "message": "Server received your message"}`
- Delay: 100

**3. Periodic status update (periodic):**
- Type: Periodic
- Response: `{"type": "status", "users": 3, "timestamp": "2024-01-15T10:30:00Z"}`
- Interval: 10000 (10 seconds)
- Delay: 5000 (start after 5 seconds)

### Step 3: Save and Test

Save the route. Connect using any WebSocket client:

```javascript
const ws = new WebSocket('ws://localhost:3880/ws/chat');

ws.onopen = () => console.log('Connected');
ws.onmessage = (e) => console.log('Received:', e.data);
ws.send('Hello!');
```

### Step 4: Monitor and Control

1. Open **Tools** > **WebSocket Clients**
2. See the connected client in the list
3. Send manual messages from the panel
4. Disconnect the client when done

## Notes

- WebSocket routes use the same HTTP server and port as the rest of the application
- Socket.IO connections (used by the Mock Server UI) are not affected by WebSocket routes
- Changing message configuration takes effect immediately for new connections. Existing connections continue using the configuration loaded at connect time
- Periodic message timers are cleaned up automatically when a client disconnects
- The client management panel updates in real time via Socket.IO
