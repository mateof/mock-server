const { WebSocketServer } = require('ws');
const sqliteService = require('./sqlite.service');
const socketService = require('./socket.service');
const crypto = require('crypto');

let wss = null;
// Map of route path -> Set of client connections
const clients = new Map();
// Map of client id -> client info
const clientInfo = new Map();
// Map of route_id -> loaded config (messages)
const routeConfigs = new Map();
// Map of client id -> interval timers
const clientIntervals = new Map();

/**
 * Initialize WebSocket server attached to the existing HTTP server
 */
function init(server) {
    wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (request, socket, head) => {
        // Ignore socket.io upgrade requests
        if (request.url && request.url.startsWith('/socket.io')) {
            return;
        }

        const pathname = request.url.split('?')[0];

        // Check if there's a WS route matching this path
        const route = await findWebSocketRoute(pathname);
        if (!route) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request, route);
        });
    });

    wss.on('connection', async (ws, request, route) => {
        const clientId = crypto.randomUUID();
        const pathname = request.url.split('?')[0];
        const ip = request.headers['x-forwarded-for'] || request.socket.remoteAddress;

        // Store client
        if (!clients.has(pathname)) {
            clients.set(pathname, new Set());
        }
        clients.get(pathname).add(clientId);

        const info = {
            id: clientId,
            routeId: route.id,
            path: pathname,
            ip: ip,
            connectedAt: Date.now(),
            messagesReceived: 0,
            messagesSent: 0,
            ws: ws
        };
        clientInfo.set(clientId, info);

        socketService.log.info(`🔌 WS conectado: ${ip} → ${pathname} (${clientId.substring(0, 8)})`);
        broadcastClientsUpdate();

        // Load messages config for this route
        const messages = await loadRouteMessages(route.id);

        // Send onConnect messages
        const onConnectMsgs = messages.filter(m => m.event_type === 'onConnect' && m.activo);
        for (const msg of onConnectMsgs) {
            const delay = msg.delay || 0;
            setTimeout(() => {
                if (ws.readyState === ws.OPEN) {
                    ws.send(msg.respuesta || '');
                    info.messagesSent++;
                    socketService.log.info(`🔌 WS enviado [onConnect] → ${pathname} (${clientId.substring(0, 8)})`);
                    broadcastClientsUpdate();
                }
            }, delay);
        }

        // Set up periodic messages
        const periodicMsgs = messages.filter(m => m.event_type === 'periodic' && m.activo && m.send_interval > 0);
        const intervals = [];
        for (const msg of periodicMsgs) {
            const delay = msg.delay || 0;
            setTimeout(() => {
                const intervalId = setInterval(() => {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(msg.respuesta || '');
                        info.messagesSent++;
                        socketService.log.info(`🔌 WS enviado [periodic] → ${pathname} (${clientId.substring(0, 8)})`);
                        broadcastClientsUpdate();
                    }
                }, msg.send_interval);
                intervals.push(intervalId);
            }, delay);
        }
        clientIntervals.set(clientId, intervals);

        // Handle incoming messages
        ws.on('message', async (data) => {
            const messageStr = data.toString();
            info.messagesReceived++;
            socketService.log.info(`🔌 WS recibido: "${messageStr.substring(0, 100)}" ← ${pathname} (${clientId.substring(0, 8)})`);
            broadcastClientsUpdate();

            // Always read fresh config from cache
            const currentMessages = routeConfigs.get(route.id) || messages;
            const onMessageHandlers = currentMessages.filter(m => m.event_type === 'onMessage' && m.activo);
            for (const handler of onMessageHandlers) {
                if (!handler.match_pattern) {
                    // Empty pattern = match all
                    sendResponse(ws, handler, info, pathname, clientId);
                    break;
                }

                let matched = false;
                if (handler.is_regex) {
                    try {
                        const regex = new RegExp(handler.match_pattern);
                        matched = regex.test(messageStr);
                    } catch (e) {
                        // Invalid regex, skip
                    }
                } else {
                    matched = messageStr === handler.match_pattern;
                }

                if (matched) {
                    sendResponse(ws, handler, info, pathname, clientId);
                    break;
                }
            }
        });

        ws.on('close', () => {
            // Clean up intervals
            const intervals = clientIntervals.get(clientId) || [];
            intervals.forEach(id => clearInterval(id));
            clientIntervals.delete(clientId);

            // Remove client
            const pathClients = clients.get(pathname);
            if (pathClients) {
                pathClients.delete(clientId);
                if (pathClients.size === 0) {
                    clients.delete(pathname);
                }
            }
            clientInfo.delete(clientId);

            socketService.log.info(`🔌 WS desconectado: ${ip} ← ${pathname} (${clientId.substring(0, 8)})`);
            broadcastClientsUpdate();
        });

        ws.on('error', (err) => {
            socketService.log.error(`🔌 WS error: ${err.message} - ${pathname} (${clientId.substring(0, 8)})`);
        });
    });

    console.log('[WS] Servidor WebSocket inicializado');
}

function sendResponse(ws, handler, info, pathname, clientId) {
    const delay = handler.delay || 0;
    setTimeout(() => {
        if (ws.readyState === ws.OPEN) {
            ws.send(handler.respuesta || '');
            info.messagesSent++;
            socketService.log.info(`🔌 WS enviado [onMessage] → ${pathname} (${clientId.substring(0, 8)})`);
            broadcastClientsUpdate();
        }
    }, delay);
}

/**
 * Find a WS route matching the given path
 */
async function findWebSocketRoute(pathname) {
    try {
        const routes = await sqliteService.getWebSocketRoutes();
        for (const route of routes) {
            if (route.isRegex) {
                try {
                    const regex = new RegExp(route.ruta);
                    if (regex.test(pathname)) return route;
                } catch (e) { /* skip */ }
            } else {
                // Exact match or wildcard
                if (route.ruta === pathname) return route;
                // Simple wildcard: /chat/* matches /chat/room1
                if (route.ruta.endsWith('/*')) {
                    const base = route.ruta.slice(0, -2);
                    if (pathname.startsWith(base)) return route;
                }
            }
        }
    } catch (e) {
        console.error('[WS] Error buscando ruta:', e.message);
    }
    return null;
}

/**
 * Load and cache message configs for a route
 */
async function loadRouteMessages(routeId) {
    try {
        const messages = await sqliteService.getWebSocketMessages(routeId);
        routeConfigs.set(routeId, messages);
        return messages;
    } catch (e) {
        console.error('[WS] Error cargando mensajes:', e.message);
        return [];
    }
}

/**
 * Reload configs for a specific route (called after editing)
 */
async function reloadRouteConfig(routeId) {
    routeConfigs.delete(routeId);
    return loadRouteMessages(routeId);
}

/**
 * Reload all WS route configs
 */
async function reloadAllConfigs() {
    routeConfigs.clear();
    try {
        const routes = await sqliteService.getWebSocketRoutes();
        for (const route of routes) {
            await loadRouteMessages(route.id);
        }
    } catch (e) {
        console.error('[WS] Error recargando configs:', e.message);
    }
}

/**
 * Get connected clients info (for API/UI)
 */
function getConnectedClients() {
    const result = [];
    for (const [id, info] of clientInfo.entries()) {
        result.push({
            id: info.id,
            routeId: info.routeId,
            path: info.path,
            ip: info.ip,
            connectedAt: info.connectedAt,
            duration: Date.now() - info.connectedAt,
            messagesReceived: info.messagesReceived,
            messagesSent: info.messagesSent
        });
    }
    return result;
}

/**
 * Send a message to specific clients
 */
function sendMessageToClients(clientIds, message) {
    let sent = 0;
    for (const clientId of clientIds) {
        const info = clientInfo.get(clientId);
        if (info && info.ws && info.ws.readyState === info.ws.OPEN) {
            info.ws.send(message);
            info.messagesSent++;
            sent++;
            socketService.log.info(`🔌 WS enviado [manual] → ${info.path} (${clientId.substring(0, 8)})`);
        }
    }
    broadcastClientsUpdate();
    return sent;
}

/**
 * Disconnect a specific client
 */
function disconnectClient(clientId) {
    const info = clientInfo.get(clientId);
    if (info && info.ws) {
        info.ws.close(1000, 'Closed by server');
        return true;
    }
    return false;
}

/**
 * Broadcast clients update to UI via socket.io
 */
function broadcastClientsUpdate() {
    socketService.sendData('ws-clients-update', getConnectedClients());
}

exports.init = init;
exports.getConnectedClients = getConnectedClients;
exports.sendMessageToClients = sendMessageToClients;
exports.disconnectClient = disconnectClient;
exports.reloadRouteConfig = reloadRouteConfig;
exports.reloadAllConfigs = reloadAllConfigs;
