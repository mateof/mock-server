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
        proxy_post_script: isProxy ? (payload.proxyPostScript || null) : null
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
            requestBodyExample, proxy_timeout, proxy_request_headers, proxy_request_params, proxy_pre_script, proxy_post_script)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [columns.tipo, columns.ruta, columns.codigo, columns.respuesta, columns.tiporespuesta,
         columns.esperaActiva, columns.isRegex, columns.customHeaders, columns.activo, orden,
         file.fileName || null, file.filePath || null, file.fileMimeType || null,
         columns.tags, columns.operationId, columns.summary, columns.description, columns.requestBodyExample,
         columns.proxy_timeout, columns.proxy_request_headers, columns.proxy_request_params,
         columns.proxy_pre_script, columns.proxy_post_script]
    );

    if (Array.isArray(payload.conditions)) {
        await sqliteService.saveConditionalResponses(result.lastID, payload.conditions);
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
            proxy_request_headers = ?, proxy_request_params = ?, proxy_pre_script = ?, proxy_post_script = ?
         WHERE id = ?`,
        [columns.tipo, columns.ruta, columns.codigo, columns.respuesta, columns.tiporespuesta,
         columns.esperaActiva, columns.isRegex, columns.customHeaders, columns.activo, orden,
         file.fileName, file.filePath, file.fileMimeType,
         columns.tags, columns.operationId, columns.summary, columns.description, columns.requestBodyExample,
         columns.proxy_timeout, columns.proxy_request_headers, columns.proxy_request_params,
         columns.proxy_pre_script, columns.proxy_post_script, routeId]
    );

    if (Array.isArray(payload.conditions)) {
        await sqliteService.saveConditionalResponses(routeId, payload.conditions);
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

module.exports = {
    UPLOADS_DIR,
    RESERVED_PREFIXES,
    RouteValidationError,
    isReservedRoute,
    asJsonText,
    getNextOrder,
    listRoutes,
    getRoute,
    createRoute,
    updateRoute,
    deleteRoute
};
