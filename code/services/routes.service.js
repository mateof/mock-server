/**
 * Routes Service
 *
 * Lógica de alta, edición y borrado de rutas, compartida por el panel
 * (routes/api.js) y el servidor MCP (services/mcp.service.js).
 *
 * Está extraída a propósito: si cada superficie implementa lo suyo, acaban
 * divergiendo en las validaciones y en detalles como el cálculo del orden o la
 * recarga de la configuración de proxy, y los fallos aparecen solo en una de
 * las dos. Todo lo que valga para el panel tiene que valer igual por MCP.
 */

const path = require('path');
const fs = require('fs');
const sqliteService = require('./sqlite.service');
const scriptRunner = require('./script-runner.service');
const criteriaService = require('./criteria-evaluator.service');
const graphqlService = require('./graphql.service');
const faultService = require('./fault.service');
const scenarioService = require('./scenario.service');
const websocketService = require('./websocket.service');
const proxyMiddleware = require('../middlewares/proxy.middleware');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

// El panel vive en /api y el servidor MCP en /mcp: una ruta mock ahí quedaría
// ensombrecida y el usuario no entendería por qué no responde nunca
const RESERVED_PREFIXES = ['/api', '/mcp'];

const PROXY_ORDER_START = 99999999;

// ===== HELPERS =====

function isReservedRoute(ruta) {
    const value = ruta || '';
    return RESERVED_PREFIXES.some(prefix => value === prefix || value.startsWith(prefix + '/'));
}

/**
 * Normaliza un campo que se guarda como texto JSON.
 * El panel manda estos campos por FormData (ya serializados) y el MCP manda el
 * array. Serializar sin mirar deja el valor con doble codificación.
 */
function asJsonText(value) {
    if (value === undefined || value === null || value === '') return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function toBool(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        sqliteService.getDatabase().run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        sqliteService.getDatabase().get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        sqliteService.getDatabase().all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

/**
 * Siguiente orden libre. Los proxies numeran hacia abajo desde 99999999 para
 * que nunca adelanten a un mock en la prioridad.
 */
async function getNextOrder(isProxy) {
    if (isProxy) {
        const row = await dbGet(`SELECT MIN(orden) as minOrden FROM rutas WHERE tiporespuesta = 'proxy'`);
        return (row && row.minOrden) ? row.minOrden - 1 : PROXY_ORDER_START;
    }
    const row = await dbGet(`SELECT MAX(orden) as maxOrden FROM rutas WHERE tiporespuesta != 'proxy' OR tiporespuesta IS NULL`);
    return (row && row.maxOrden) ? row.maxOrden + 1 : 1;
}

/**
 * Error con la causa que el llamante debe traducir a su formato (HTTP o MCP)
 */
class RouteValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RouteValidationError';
        this.validation = true;
    }
}

/**
 * Comprueba lo que no puede depender de quién llama
 */
function validatePayload(payload) {
    if (isReservedRoute(payload.ruta)) {
        throw new RouteValidationError(`Routes starting with ${RESERVED_PREFIXES.join(' or ')} are reserved for internal use`);
    }

    if (payload.isRegex && payload.ruta) {
        try {
            new RegExp(payload.ruta);
        } catch (e) {
            throw new RouteValidationError(`Invalid regular expression: ${e.message}`);
        }
    }

    for (const [campo, script] of [['proxyPreScript', payload.proxyPreScript], ['proxyPostScript', payload.proxyPostScript]]) {
        const check = scriptRunner.validateScript(script);
        if (!check.valid) {
            throw new RouteValidationError(`Invalid script (${campo}): ${check.error}`);
        }
    }
}

/**
 * Campos de la tabla a partir de un payload, con los mismos valores por
 * defecto sea cual sea la superficie que llama
 */
function buildColumns(payload) {
    const isProxy = payload.tiporespuesta === 'proxy';

    return {
        tipo: payload.tipo,
        ruta: payload.ruta,
        codigo: payload.codigo,
        respuesta: payload.respuesta,
        tiporespuesta: payload.tiporespuesta,
        esperaActiva: toBool(payload.esperaActiva) ? 1 : 0,
        isRegex: toBool(payload.isRegex) ? 1 : 0,
        customHeaders: asJsonText(payload.customHeaders),
        activo: payload.activo === undefined ? 1 : (toBool(payload.activo) ? 1 : 0),
        tags: asJsonText(payload.tags),
        operationId: payload.operationId || null,
        summary: payload.summary || null,
        description: payload.description || null,
        requestBodyExample: payload.requestBodyExample || null,
        proxy_timeout: isProxy ? (parseInt(payload.proxyTimeout) || 30000) : null,
        proxy_request_headers: isProxy ? asJsonText(payload.proxyRequestHeaders) : null,
        proxy_request_params: isProxy ? asJsonText(payload.proxyRequestParams) : null,
        proxy_pre_script: isProxy ? (payload.proxyPreScript || null) : null,
        proxy_post_script: isProxy ? (payload.proxyPostScript || null) : null,
        recording: isProxy && toBool(payload.recording) ? 1 : 0,
        recording_mode: isProxy ? (payload.recordingMode === 'skip' ? 'skip' : 'update') : null,
        // Latencia y fallos: valen en cualquier tipo de ruta, no solo proxy
        latency_mode: faultService.MODOS_LATENCIA.includes(payload.latencyMode) ? payload.latencyMode : 'none',
        latency_ms: parseInt(payload.latencyMs) || 0,
        latency_max_ms: parseInt(payload.latencyMaxMs) || 0,
        fault_rate: parseInt(payload.faultRate) || 0,
        fault_type: faultService.TIPOS_FALLO.includes(payload.faultType) ? payload.faultType : 'error',
        fault_status: String(payload.faultStatus || '500'),
        templating: toBool(payload.templating) ? 1 : 0,
        sequence_mode: payload.sequenceMode === 'loop' ? 'loop' : 'stick'
    };
}

// ===== OPERACIONES =====

async function listRoutes(filtros = {}) {
    const where = [];
    const params = [];

    if (filtros.tipo) {
        where.push('LOWER(tipo) = ?');
        params.push(String(filtros.tipo).toLowerCase());
    }
    if (filtros.tiporespuesta) {
        where.push('tiporespuesta = ?');
        params.push(filtros.tiporespuesta);
    }
    if (filtros.activo !== undefined && filtros.activo !== null) {
        where.push('COALESCE(activo, 1) = ?');
        params.push(toBool(filtros.activo) ? 1 : 0);
    }
    if (filtros.search) {
        where.push('(ruta LIKE ? OR COALESCE(summary, "") LIKE ? OR COALESCE(operationId, "") LIKE ?)');
        const like = `%${filtros.search}%`;
        params.push(like, like, like);
    }

    const sql = `SELECT * FROM rutas
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY COALESCE(orden, 999999) ASC, id ASC`;
    return dbAll(sql, params);
}

/**
 * Ruta con todo lo que cuelga de ella, para que quien la lea no tenga que
 * saber en qué tabla vive cada cosa
 */
async function getRoute(id) {
    const routeId = Number(id);
    const route = await dbGet('SELECT * FROM rutas WHERE id = ?', [routeId]);
    if (!route) return null;

    route.conditions = await sqliteService.getConditionalResponses(routeId);
    route.sequence = await sqliteService.getAllRouteSequence(routeId);

    if (route.tiporespuesta === 'proxy') {
        route.fallbacks = await sqliteService.getAllProxyFallbacks(routeId);
        for (const fallback of route.fallbacks) {
            fallback.conditions = await sqliteService.getAllFallbackConditions(fallback.id);
        }
    }
    if (route.tiporespuesta === 'graphql') {
        route.graphqlOperations = await sqliteService.getAllGraphQLOperations(routeId);
    }
    if (route.tiporespuesta === 'websocket') {
        route.websocketMessages = await sqliteService.getAllWebSocketMessages(routeId);
    }

    return route;
}

async function createRoute(payload, options = {}) {
    validatePayload(payload);

    const columns = buildColumns(payload);
    const isProxy = columns.tiporespuesta === 'proxy';
    const orden = await getNextOrder(isProxy);
    const file = options.file || {};

    const result = await dbRun(
        `INSERT INTO rutas(tipo, ruta, codigo, respuesta, tiporespuesta, esperaActiva, isRegex, customHeaders,
            activo, orden, fileName, filePath, fileMimeType, tags, operationId, summary, description,
            requestBodyExample, proxy_timeout, proxy_request_headers, proxy_request_params, proxy_pre_script, proxy_post_script,
            recording, recording_mode, latency_mode, latency_ms, latency_max_ms, fault_rate, fault_type, fault_status,
            templating, sequence_mode)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [columns.tipo, columns.ruta, columns.codigo, columns.respuesta, columns.tiporespuesta,
         columns.esperaActiva, columns.isRegex, columns.customHeaders, columns.activo, orden,
         file.fileName || null, file.filePath || null, file.fileMimeType || null,
         columns.tags, columns.operationId, columns.summary, columns.description, columns.requestBodyExample,
         columns.proxy_timeout, columns.proxy_request_headers, columns.proxy_request_params,
         columns.proxy_pre_script, columns.proxy_post_script, columns.recording, columns.recording_mode,
         columns.latency_mode, columns.latency_ms, columns.latency_max_ms,
         columns.fault_rate, columns.fault_type, columns.fault_status, columns.templating,
         columns.sequence_mode]
    );

    if (Array.isArray(payload.conditions)) {
        await sqliteService.saveConditionalResponses(result.lastID, payload.conditions);
    }
    if (Array.isArray(payload.sequence)) {
        await sqliteService.saveRouteSequence(result.lastID, payload.sequence);
    }

    console.log(`[ROUTES] Ruta creada con id ${result.lastID} y orden ${orden}`);

    if (isProxy) {
        await proxyMiddleware.reloadProxyConfigs();
    }

    return result.lastID;
}

async function updateRoute(id, payload, options = {}) {
    validatePayload(payload);

    const routeId = Number(id);
    const current = await dbGet('SELECT tiporespuesta, orden, filePath, fileName, fileMimeType FROM rutas WHERE id = ?', [routeId]);
    if (!current) {
        throw new RouteValidationError(`Route ${id} not found`);
    }

    const columns = buildColumns(payload);
    const isProxy = columns.tiporespuesta === 'proxy';
    const wasProxy = current.tiporespuesta === 'proxy';

    // Cambiar de proxy a mock (o al revés) mueve la ruta de rango de prioridad
    const orden = wasProxy !== isProxy ? await getNextOrder(isProxy) : current.orden;

    // El fichero lo resuelve quien llama: el panel sabe de multer, el MCP no
    let file = { fileName: null, filePath: null, fileMimeType: null };
    if (options.file === 'keep') {
        file = { fileName: current.fileName, filePath: current.filePath, fileMimeType: current.fileMimeType };
    } else if (options.file) {
        file = options.file;
    }

    await dbRun(
        `UPDATE rutas SET tipo = ?, ruta = ?, codigo = ?, respuesta = ?, tiporespuesta = ?, esperaActiva = ?,
            isRegex = ?, customHeaders = ?, activo = ?, orden = ?, fileName = ?, filePath = ?, fileMimeType = ?,
            tags = ?, operationId = ?, summary = ?, description = ?, requestBodyExample = ?, proxy_timeout = ?,
            proxy_request_headers = ?, proxy_request_params = ?, proxy_pre_script = ?, proxy_post_script = ?,
            recording = ?, recording_mode = ?, latency_mode = ?, latency_ms = ?, latency_max_ms = ?,
            fault_rate = ?, fault_type = ?, fault_status = ?, templating = ?, sequence_mode = ?
         WHERE id = ?`,
        [columns.tipo, columns.ruta, columns.codigo, columns.respuesta, columns.tiporespuesta,
         columns.esperaActiva, columns.isRegex, columns.customHeaders, columns.activo, orden,
         file.fileName, file.filePath, file.fileMimeType,
         columns.tags, columns.operationId, columns.summary, columns.description, columns.requestBodyExample,
         columns.proxy_timeout, columns.proxy_request_headers, columns.proxy_request_params,
         columns.proxy_pre_script, columns.proxy_post_script, columns.recording, columns.recording_mode,
         columns.latency_mode, columns.latency_ms, columns.latency_max_ms,
         columns.fault_rate, columns.fault_type, columns.fault_status, columns.templating,
         columns.sequence_mode, routeId]
    );

    if (Array.isArray(payload.conditions)) {
        await sqliteService.saveConditionalResponses(routeId, payload.conditions);
    }
    if (Array.isArray(payload.sequence)) {
        await sqliteService.saveRouteSequence(routeId, payload.sequence);
    }

    // Borrar el fichero antiguo si dejó de usarse
    const oldPath = current.filePath;
    if (oldPath && oldPath !== file.filePath) {
        fs.unlink(path.join(UPLOADS_DIR, oldPath), (err) => {
            if (!err) console.log(`[ROUTES] Fichero eliminado: ${oldPath}`);
        });
    }

    console.log(`[ROUTES] Ruta ${routeId} actualizada con orden ${orden}`);
    await proxyMiddleware.reloadProxyConfigs();

    return true;
}

async function deleteRoute(id) {
    const routeId = Number(id);
    const row = await dbGet('SELECT filePath FROM rutas WHERE id = ?', [routeId]);
    if (!row) {
        throw new RouteValidationError(`Route ${id} not found`);
    }

    if (row.filePath) {
        fs.unlink(path.join(UPLOADS_DIR, row.filePath), (err) => {
            if (!err) console.log(`[ROUTES] Fichero eliminado: ${row.filePath}`);
        });
    }

    await dbRun('DELETE FROM rutas WHERE id = ?', [routeId]);
    console.log(`[ROUTES] Ruta ${routeId} eliminada`);
    await proxyMiddleware.reloadProxyConfigs();

    return true;
}

// ===== FALLBACKS DE PROXY =====

const ERROR_TYPES = ['timeout', 'connection', 'http5xx', 'all'];

/**
 * Sustituye los fallbacks de una ruta, con sus condiciones.
 *
 * Van juntos a propósito: guardar los fallbacks los borra y los reinserta, así
 * que sus ids cambian y las condiciones tienen que reasignarse después. Si el
 * llamante tuviera que hacerlo en dos pasos, cualquier despiste dejaría
 * condiciones colgando de un fallback que ya no existe.
 */
/**
 * Guarda solo los pasos del escenario, sin tocar el resto de la ruta
 */
async function saveSequence(routeId, pasos, modo) {
    const route = await dbGet('SELECT id, tiporespuesta FROM rutas WHERE id = ?', [Number(routeId)]);
    if (!route) {
        throw new RouteValidationError(`Route ${routeId} not found`);
    }
    await sqliteService.saveRouteSequence(Number(routeId), Array.isArray(pasos) ? pasos : []);
    if (modo === 'loop' || modo === 'stick') {
        await dbRun('UPDATE rutas SET sequence_mode = ? WHERE id = ?', [modo, Number(routeId)]);
    }

    // Cambiar los pasos y dejar el contador a medias haría que la primera
    // llamada después de editar empezase por el paso tres. Va aquí y no en cada
    // superficie para que el panel y el MCP no puedan divergir en esto
    scenarioService.reiniciar(Number(routeId));
    console.log(`[ROUTES] Secuencia de la ruta ${routeId} guardada (${(pasos || []).length} pasos)`);
    return true;
}

async function saveFallbacks(routeId, fallbacks) {
    if (!Array.isArray(fallbacks)) {
        throw new RouteValidationError('fallbacks must be an array');
    }

    fallbacks.forEach((f, i) => {
        if (!f.path_pattern || !String(f.path_pattern).trim()) {
            throw new RouteValidationError(`Fallback ${i + 1} has no path_pattern`);
        }
        try {
            new RegExp(f.path_pattern);
        } catch (e) {
            throw new RouteValidationError(`Fallback "${f.nombre || i + 1}": invalid regex - ${e.message}`);
        }
        if (!Array.isArray(f.error_types) || f.error_types.length === 0) {
            throw new RouteValidationError(`Fallback ${i + 1} needs at least one error type`);
        }
        for (const tipo of f.error_types) {
            if (!ERROR_TYPES.includes(tipo)) {
                throw new RouteValidationError(`Fallback "${f.nombre || i + 1}": invalid error type "${tipo}"`);
            }
        }
        (f.conditions || []).forEach(c => {
            const check = criteriaService.validateCriteria(c.criteria);
            if (!check.valid) {
                throw new RouteValidationError(`Condition "${c.nombre || c.criteria}": ${check.error}`);
            }
        });
    });

    const id = Number(routeId);
    await sqliteService.saveProxyFallbacks(id, fallbacks);

    // Los ids son nuevos tras el borrado e inserción, así que se releen
    const guardados = await sqliteService.getAllProxyFallbacks(id);
    for (let i = 0; i < guardados.length; i++) {
        const condiciones = fallbacks[i] && fallbacks[i].conditions;
        if (Array.isArray(condiciones)) {
            await sqliteService.saveFallbackConditions(guardados[i].id, condiciones);
        }
    }

    await proxyMiddleware.reloadProxyConfigs();
    console.log(`[ROUTES] Guardados ${fallbacks.length} fallbacks en la ruta ${id}`);
    return guardados.length;
}

/**
 * Sustituye las condiciones de un fallback concreto
 */
async function saveFallbackConditions(fallbackId, conditions) {
    if (!Array.isArray(conditions)) {
        throw new RouteValidationError('conditions must be an array');
    }
    for (const c of conditions) {
        const check = criteriaService.validateCriteria(c.criteria);
        if (!check.valid) {
            throw new RouteValidationError(`Condition "${c.nombre || c.criteria}": ${check.error}`);
        }
    }

    await sqliteService.saveFallbackConditions(Number(fallbackId), conditions);
    await proxyMiddleware.reloadProxyConfigs();
    return conditions.length;
}

// ===== GRAPHQL =====

async function saveGraphQLOperations(routeId, operations) {
    if (!Array.isArray(operations)) {
        throw new RouteValidationError('operations must be an array');
    }
    operations.forEach((op, i) => {
        if (!op.operationName || !String(op.operationName).trim()) {
            throw new RouteValidationError(`Operation ${i + 1} has no name`);
        }
        if (op.operationType && !['query', 'mutation'].includes(op.operationType)) {
            throw new RouteValidationError(`Operation "${op.operationName}": type must be query or mutation`);
        }
    });

    await sqliteService.saveGraphQLOperations(Number(routeId), operations);
    console.log(`[ROUTES] Guardadas ${operations.length} operaciones GraphQL en la ruta ${routeId}`);
    return operations.length;
}

async function saveGraphQLProxyUrl(routeId, url) {
    await dbRun('UPDATE rutas SET graphql_proxy_url = ? WHERE id = ?', [url || null, Number(routeId)]);
    return true;
}

/**
 * Importa el esquema por introspección y genera las operaciones simuladas
 */
async function importGraphQLSchema(routeId, url) {
    if (!url || !String(url).trim()) {
        throw new RouteValidationError('The GraphQL endpoint URL is required');
    }

    const introspection = await graphqlService.fetchIntrospectionFromUrl(url);
    const { operations } = graphqlService.generateMockFromIntrospection(introspection);

    const id = Number(routeId);
    await sqliteService.saveGraphQLOperations(id, operations);
    await dbRun('UPDATE rutas SET graphql_schema = ?, graphql_proxy_url = ? WHERE id = ?',
        [JSON.stringify(introspection), url, id]);

    console.log(`[ROUTES] Esquema GraphQL importado en la ruta ${id}: ${operations.length} operaciones`);
    return operations;
}

// ===== WEBSOCKET =====

const WS_EVENT_TYPES = ['onConnect', 'onMessage', 'periodic'];

async function saveWebSocketMessages(routeId, messages) {
    if (!Array.isArray(messages)) {
        throw new RouteValidationError('messages must be an array');
    }
    messages.forEach((m, i) => {
        if (!WS_EVENT_TYPES.includes(m.event_type)) {
            throw new RouteValidationError(`Message ${i + 1}: invalid event_type "${m.event_type}"`);
        }
        if (m.is_regex && m.match_pattern) {
            try {
                new RegExp(m.match_pattern);
            } catch (e) {
                throw new RouteValidationError(`Message ${i + 1}: invalid regex - ${e.message}`);
            }
        }
    });

    const id = Number(routeId);
    await sqliteService.saveWebSocketMessages(id, messages);
    // Sin esto los clientes ya conectados seguirían con la configuración vieja
    await websocketService.reloadRouteConfig(id);
    console.log(`[ROUTES] Guardados ${messages.length} mensajes WebSocket en la ruta ${id}`);
    return messages.length;
}

// ===== ORDEN =====

/**
 * Asigna órdenes explícitos. El orden decide qué ruta gana cuando varias
 * podrían atender la misma petición, así que es parte de configurar un flujo.
 */
async function reorderRoutes(orders) {
    if (!Array.isArray(orders) || orders.length === 0) {
        throw new RouteValidationError('An array of { id, order } is required');
    }

    for (const { id, orden } of orders) {
        await dbRun('UPDATE rutas SET orden = ? WHERE id = ?', [orden, Number(id)]);
    }

    await proxyMiddleware.reloadProxyConfigs();
    console.log(`[ROUTES] Reordenadas ${orders.length} rutas`);
    return orders.length;
}

// ===== DUPLICAR =====

async function duplicateRoute(id, newPath) {
    if (!newPath) {
        throw new RouteValidationError('The new path is required');
    }
    if (isReservedRoute(newPath)) {
        throw new RouteValidationError(`Routes starting with ${RESERVED_PREFIXES.join(' or ')} are reserved for internal use`);
    }

    const original = await dbGet('SELECT * FROM rutas WHERE id = ?', [Number(id)]);
    if (!original) {
        throw new RouteValidationError(`Route ${id} not found`);
    }

    const isProxy = original.tiporespuesta === 'proxy';
    const orden = await getNextOrder(isProxy);

    // El fichero se copia: dos rutas apuntando al mismo no pueden borrarlo por
    // separado sin dejar a la otra sin nada
    let fileName = original.fileName, filePath = original.filePath, fileMimeType = original.fileMimeType;
    if (original.filePath) {
        const ext = path.extname(original.filePath);
        const nuevo = `${Date.now()}${ext}`;
        try {
            fs.copyFileSync(path.join(UPLOADS_DIR, original.filePath), path.join(UPLOADS_DIR, nuevo));
            filePath = nuevo;
        } catch (e) {
            console.log(`[ROUTES] No se pudo copiar el fichero: ${e.message}`);
            fileName = filePath = fileMimeType = null;
        }
    }

    const result = await dbRun(
        `INSERT INTO rutas(tipo, ruta, codigo, respuesta, tiporespuesta, esperaActiva, isRegex, customHeaders,
            activo, orden, fileName, filePath, fileMimeType, tags, operationId, summary, description,
            requestBodyExample, proxy_timeout, proxy_request_headers, proxy_request_params, proxy_pre_script,
            proxy_post_script, graphql_schema, graphql_proxy_url, recording, recording_mode,
            latency_mode, latency_ms, latency_max_ms, fault_rate, fault_type, fault_status, templating,
            sequence_mode)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [original.tipo, newPath, original.codigo, original.respuesta, original.tiporespuesta,
         original.esperaActiva, original.isRegex, original.customHeaders, original.activo, orden,
         fileName, filePath, fileMimeType, original.tags, original.operationId, original.summary,
         original.description, original.requestBodyExample, original.proxy_timeout,
         original.proxy_request_headers, original.proxy_request_params, original.proxy_pre_script,
         original.proxy_post_script, original.graphql_schema, original.graphql_proxy_url,
         // La grabación no se copia: es un modo de operación, no configuración,
         // y duplicar una ruta no debería poner a grabar una segunda en silencio
         0, original.recording_mode,
         original.latency_mode, original.latency_ms, original.latency_max_ms,
         original.fault_rate, original.fault_type, original.fault_status, original.templating,
         original.sequence_mode]
    );

    const nuevoId = result.lastID;

    // Lo que cuelga de la ruta se copia también, o el duplicado sería una
    // carcasa vacía justo en los tipos que más configuración llevan
    const condiciones = await sqliteService.getConditionalResponses(Number(id));
    if (condiciones.length) await sqliteService.saveConditionalResponses(nuevoId, condiciones);

    const pasos = await sqliteService.getAllRouteSequence(Number(id));
    if (pasos.length) await sqliteService.saveRouteSequence(nuevoId, pasos);

    if (isProxy) {
        const fallbacks = await sqliteService.getAllProxyFallbacks(Number(id));
        if (fallbacks.length) {
            for (const f of fallbacks) {
                f.conditions = await sqliteService.getAllFallbackConditions(f.id);
            }
            await sqliteService.saveProxyFallbacks(nuevoId, fallbacks);
            const nuevos = await sqliteService.getAllProxyFallbacks(nuevoId);
            for (let i = 0; i < nuevos.length; i++) {
                if (fallbacks[i] && fallbacks[i].conditions.length) {
                    await sqliteService.saveFallbackConditions(nuevos[i].id, fallbacks[i].conditions);
                }
            }
        }
        await proxyMiddleware.reloadProxyConfigs();
    }

    if (original.tiporespuesta === 'graphql') {
        const ops = await sqliteService.getAllGraphQLOperations(Number(id));
        if (ops.length) await sqliteService.saveGraphQLOperations(nuevoId, ops);
    }

    if (original.tiporespuesta === 'websocket') {
        const msgs = await sqliteService.getAllWebSocketMessages(Number(id));
        if (msgs.length) {
            await sqliteService.saveWebSocketMessages(nuevoId, msgs);
            await websocketService.reloadRouteConfig(nuevoId);
        }
    }

    console.log(`[ROUTES] Ruta duplicada: ${original.ruta} -> ${newPath} (id ${nuevoId})`);
    return nuevoId;
}

module.exports = {
    UPLOADS_DIR,
    RESERVED_PREFIXES,
    ERROR_TYPES,
    WS_EVENT_TYPES,
    RouteValidationError,
    isReservedRoute,
    asJsonText,
    getNextOrder,
    listRoutes,
    getRoute,
    createRoute,
    updateRoute,
    deleteRoute,
    saveSequence,
    saveFallbacks,
    saveFallbackConditions,
    saveGraphQLOperations,
    saveGraphQLProxyUrl,
    importGraphQLSchema,
    saveWebSocketMessages,
    reorderRoutes,
    duplicateRoute
};
