/**
 * Trace Service
 *
 * Da a cada petición entrante un identificador y va anotando los pasos por los
 * que pasa: qué ruta casó, qué condición ganó, qué hizo cada script, qué se le
 * pidió al backend y con qué se respondió.
 *
 * Los pasos van SOLO al log persistente, no a la consola en vivo del panel:
 * la consola quedaría ilegible con seis líneas por petición, y el detalle se
 * consulta después en la pantalla de logs o por MCP.
 */

const crypto = require('crypto');
const contexto = require('./trace-context');
const logService = require('./log.service');

const PASOS_HABILITADOS = process.env.MOCK_SERVER_TRACE_STEPS !== 'false';

// Los pasos que puede tener una traza, en el orden natural del recorrido.
// El diagrama del panel los pinta con este vocabulario.
const PASOS = {
    REQUEST: 'request',
    ROUTE: 'route',
    CONDITION: 'condition',
    WAIT: 'wait',
    SCRIPT: 'script',
    PROXY_REQUEST: 'proxy-request',
    PROXY_RESPONSE: 'proxy-response',
    FALLBACK: 'fallback',
    RESPONSE: 'response'
};

function nuevoId() {
    // 16 hex: corto de leer y de sobra para no repetirse en un log acotado
    return crypto.randomBytes(8).toString('hex');
}

/**
 * Anota un paso de la traza actual. Fuera de una petición no hace nada, así
 * que se puede llamar sin comprobar antes si hay traza.
 */
function step(paso, datos = {}) {
    if (!PASOS_HABILITADOS) return;

    const ctx = contexto.actual();
    if (!ctx) return;

    logService.record({
        type: 'trace',
        level: datos.level || 'info',
        step: paso,
        message: datos.message || paso,
        method: datos.method || ctx.method,
        url: datos.url || ctx.url,
        status: datos.status,
        duration: datos.duration !== undefined ? datos.duration : Date.now() - ctx.startedAt,
        routeId: datos.routeId || ctx.routeId || null,
        target: datos.target,
        details: datos.details
    });
}

/**
 * Deja anotada la ruta que atendió la petición, para que todos los pasos
 * siguientes de la traza la lleven sin repetirla en cada llamada
 */
function setRoute(routeId) {
    const ctx = contexto.actual();
    if (ctx) ctx.routeId = routeId;
}

/**
 * Middleware que abre la traza. Se monta justo antes del middleware de mocks:
 * las llamadas del panel a /api y del asistente a /mcp no son tráfico simulado
 * y llenarían el log de trazas sin interés.
 */
function middleware(req, res, next) {
    const ctx = {
        traceId: nuevoId(),
        seq: 0,
        startedAt: Date.now(),
        method: req.method,
        url: req.originalUrl || req.url,
        routeId: null
    };

    contexto.run(ctx, () => {
        // Se expone en la respuesta para poder correlacionar desde fuera lo que
        // devolvió el mock con lo que se ve en la pantalla de logs
        res.setHeader('X-Mock-Trace-Id', ctx.traceId);

        step(PASOS.REQUEST, {
            message: `${ctx.method} ${ctx.url}`,
            duration: 0,
            details: { headers: cabecerasSeguras(req.headers), query: req.query }
        });

        // 'finish' salta cuando la respuesta ya se envió del todo, incluido el
        // caso de que la cierre otro middleware o una espera activa
        res.on('finish', () => {
            step(PASOS.RESPONSE, {
                message: `${res.statusCode} en ${Date.now() - ctx.startedAt}ms`,
                status: res.statusCode,
                level: res.statusCode >= 500 ? 'error' : (res.statusCode >= 400 ? 'warning' : 'success')
            });
        });

        next();
    });
}

// La autorización y las cookies no tienen por qué quedarse escritas en la BD
function cabecerasSeguras(headers) {
    const copia = { ...headers };
    delete copia.authorization;
    delete copia.cookie;
    return copia;
}

module.exports = {
    middleware,
    step,
    setRoute,
    nuevoId,
    PASOS,
    PASOS_HABILITADOS
};
