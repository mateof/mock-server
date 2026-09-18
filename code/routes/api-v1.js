/**
 * API v1
 *
 * La API pública del servidor: lo que permite gobernarlo desde fuera (un script
 * de pruebas, un pipeline, otra aplicación) sin abrir el panel.
 *
 * Es una superficie aparte de /api, que es la del panel, porque las dos tienen
 * contratos distintos: /api responde a lo que necesita la pantalla y cambia con
 * ella; esto es un contrato estable, versionado y documentado en
 * openapi/openapi.yaml, que es lo que se puede prometer a quien escribe un
 * script que no se va a tocar en un año.
 *
 * Aquí no hay lógica: cada handler traduce HTTP a una llamada a
 * control.service, que es la misma capa que usa el servidor MCP, y traduce de
 * vuelta el error al código que corresponde. Todo lo que se pueda hacer por MCP
 * se puede hacer por aquí, y al revés.
 */

const express = require('express');
const router = express.Router();

const control = require('../services/control.service');
const apiSpec = require('../services/api-spec.service');
const apiAuth = require('../middlewares/api-auth.middleware');
const uploads = require('../middlewares/uploads.middleware');

// ===== TRADUCCIÓN DE ERRORES =====

const ESTADOS = {
    invalid: 400,
    unauthorized: 401,
    not_found: 404,
    conflict: 409,
    unprocessable: 422
};

function fallo(res, err) {
    // `validation` lo marcan los servicios cuando el fallo es de quien llama y
    // no del servidor; sin código concreto, eso es un 400
    const code = ESTADOS[err.code] ? err.code : (err.validation ? 'invalid' : 'internal_error');
    const status = ESTADOS[code] || 500;

    if (status >= 500) console.error(`[API v1] ${err.stack || err.message}`);
    res.status(status).json({ error: err.message, code });
}

/**
 * Envuelve un handler: lo que devuelve se sirve como JSON y lo que lance se
 * traduce a su código. Sin esto, cada endpoint repetiría el mismo try/catch y
 * alguno acabaría contestando 500 a un "no existe".
 */
const atiende = (fn) => async (req, res) => {
    try {
        const datos = await fn(req, res);
        if (datos !== undefined && !res.headersSent) res.json(datos);
    } catch (err) {
        // Un fichero subido para una operación que acabó mal no lo reclama nadie
        uploads.descartar(req.file);
        if (!res.headersSent) fallo(res, err);
    }
};

// ===== LECTURA DE PARÁMETROS =====

const bool = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const lista = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (Array.isArray(v)) return v;
    return String(v).split(',').map(s => s.trim()).filter(Boolean);
};

const numero = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

const numeros = (v) => {
    const partes = lista(v);
    return partes ? partes.map(Number).filter(n => !Number.isNaN(n)) : undefined;
};

// Una ruta de tipo file viaja como multipart, y en un formulario todo es texto:
// los booleanos llegan como "true" y las listas como JSON dentro de un campo
const CAMPOS_BOOLEANOS = ['is_regex', 'active', 'wait_mode', 'templating', 'sse_loop', 'recording'];
const CAMPOS_NUMERICOS = ['proxy_timeout', 'latency_ms', 'latency_max_ms', 'fault_rate'];
const CAMPOS_JSON = ['tags', 'custom_headers', 'conditions', 'proxy_request_headers', 'proxy_request_params'];

function desdeFormulario(body = {}) {
    const datos = { ...body };

    CAMPOS_BOOLEANOS.forEach(campo => {
        if (datos[campo] !== undefined) datos[campo] = bool(datos[campo]);
    });
    CAMPOS_NUMERICOS.forEach(campo => {
        if (datos[campo] !== undefined) datos[campo] = numero(datos[campo]);
    });
    CAMPOS_JSON.forEach(campo => {
        if (typeof datos[campo] !== 'string' || !datos[campo].trim()) return;
        try {
            datos[campo] = JSON.parse(datos[campo]);
        } catch (e) {
            // Mejor decirlo que guardar el texto crudo en una columna que espera
            // una lista: eso se descubre al servir la ruta, mucho más tarde
            throw new control.OperationError(
                `"${campo}" must be valid JSON when the route is sent as a form`, 'invalid');
        }
    });

    return datos;
}

/** Cuerpo de una operación de ruta, venga como JSON o como formulario */
const cuerpoDeRuta = (req) => (req.is('multipart/form-data') ? desdeFormulario(req.body) : req.body);

/** Selector de rutas tal y como llega en el cuerpo de una operación masiva */
const selector = (body = {}) => ({
    ids: Array.isArray(body.ids) ? body.ids.map(Number) : numeros(body.ids),
    tag: body.tag,
    method: body.method,
    path: body.path,
    path_contains: body.path_contains,
    response_type: body.response_type,
    search: body.search
});

/** Filtros del log, iguales en la consulta, el resumen y el vaciado */
const filtrosDeLog = (query = {}) => ({
    from: numero(query.from),
    to: numero(query.to),
    minutes: numero(query.minutes),
    level: lista(query.level),
    type: lista(query.type),
    method: query.method,
    status: query.status,
    url: query.url,
    search: query.search,
    route_id: numero(query.route_id),
    trace_id: query.trace_id,
    min_duration: numero(query.min_duration)
});

const API = { source: 'API' };

// ===== CONTRATO =====
// Va antes de la autenticación: la documentación no es secreta, y con la API
// cerrada la pantalla de Swagger no podría ni cargarla para pedir el token.

router.get('/openapi.json', atiende(async (req, res) => {
    res.json(apiSpec.documento({ baseUrl: `${req.protocol}://${req.get('host')}` }));
}));

router.get('/openapi.yaml', atiende(async (req, res) => {
    res.type('application/yaml').send(apiSpec.bruto());
}));

router.get('/health', atiende(async () => ({ status: 'ok', auth: apiAuth.estado() })));

// ===== AUTENTICACIÓN =====

router.use(apiAuth.authenticate);

// ===== SERVIDOR =====

router.get('/server', atiende(async () => ({ ...await control.serverInfo(), auth: apiAuth.estado() })));

router.get('/version', atiende(async (req) => control.versionStatus({ force: bool(req.query.force) === true })));

// ===== RUTAS =====

router.get('/routes', atiende(async (req) => control.listRoutes({
    method: req.query.method,
    response_type: req.query.response_type,
    active: bool(req.query.active),
    tag: req.query.tag,
    search: req.query.search,
    include_docs: bool(req.query.include_docs),
    documented: bool(req.query.documented)
})));

// `upload.single` deja pasar de largo lo que no sea multipart, así que el mismo
// endpoint sirve para el JSON de siempre y para una ruta con fichero
router.post('/routes', uploads.upload.single('file'), atiende(async (req, res) => {
    const creada = await control.createRoute(cuerpoDeRuta(req), {
        ...API,
        file: uploads.desdeMulter(req.file)
    });
    res.status(201).json(creada);
}));

// Las operaciones masivas y las de solo lectura van ANTES de /routes/:id: si no,
// Express leería "activate" como un id y contestaría "no existe la ruta NaN"
router.post('/routes/activate', atiende(async (req) => control.setRoutesActive({
    active: true,
    exclusive: bool(req.body.exclusive) === true,
    ...selector(req.body)
}, API)));

router.post('/routes/deactivate', atiende(async (req) => control.setRoutesActive({
    active: false,
    ...selector(req.body)
}, API)));

router.post('/routes/delete', atiende(async (req) => control.deleteRoutes(selector(req.body), API)));

// `tag` es el que se pone o se quita y `match_tag` el que elige a quién, así que
// aquí no vale el selector genérico: mezclarlos borraría uno de los dos
router.post('/routes/tags', atiende(async (req) => control.setRoutesTags({
    tag: req.body.tag,
    action: req.body.action,
    match_tag: req.body.match_tag,
    ids: Array.isArray(req.body.ids) ? req.body.ids.map(Number) : numeros(req.body.ids),
    method: req.body.method,
    path: req.body.path,
    path_contains: req.body.path_contains,
    response_type: req.body.response_type,
    search: req.body.search
}, API)));

router.post('/routes/reorder', atiende(async (req) => control.reorderRoutes(req.body, API)));

router.post('/routes/try', atiende(async (req) => control.tryRoute(req.body)));

router.get('/routes/usage', atiende(async (req) => control.routeUsage({
    since_ms: numero(req.query.since_ms),
    include_unused: bool(req.query.include_unused)
})));

router.get('/routes/:id', atiende(async (req) => control.getRoute(req.params.id)));

router.patch('/routes/:id', uploads.upload.single('file'), atiende(async (req) => control.updateRoute(
    req.params.id,
    cuerpoDeRuta(req),
    { ...API, file: req.file ? uploads.desdeMulter(req.file) : 'keep' }
)));

router.delete('/routes/:id', atiende(async (req) => control.deleteRoute(req.params.id, API)));

router.post('/routes/:id/duplicate', atiende(async (req, res) => {
    const copia = await control.duplicateRoute(req.params.id, req.body, API);
    res.status(201).json(copia);
}));

router.get('/routes/:id/docs', atiende(async (req) => control.getRouteDocs(req.params.id)));

router.put('/routes/:id/docs', atiende(async (req) => control.setRouteDocs(req.params.id, req.body, API)));

router.get('/routes/:id/conditions', atiende(async (req) => control.getRouteConditions(req.params.id)));

router.put('/routes/:id/conditions', atiende(async (req) => control.setRouteConditions(req.params.id, req.body, API)));

router.put('/routes/:id/sequence', atiende(async (req) => control.setRouteSequence(req.params.id, req.body, API)));

router.post('/routes/:id/sequence/reset', atiende(async (req) => control.resetRouteSequence({ id: Number(req.params.id) }, API)));

router.put('/routes/:id/faults', atiende(async (req) => control.setRouteFaults(req.params.id, req.body, API)));

router.put('/routes/:id/recording', atiende(async (req) => control.setRouteRecording(req.params.id, req.body, API)));

router.put('/routes/:id/proxy-transform', atiende(async (req) => control.setProxyTransform(req.params.id, req.body, API)));

router.put('/routes/:id/proxy-fallbacks', atiende(async (req) => control.setProxyFallbacks(req.params.id, req.body, API)));

router.put('/routes/:id/graphql-operations', atiende(async (req) => control.setGraphqlOperations(req.params.id, req.body, API)));

router.post('/routes/:id/graphql-schema/import', atiende(async (req) => control.importGraphqlSchema(req.params.id, req.body, API)));

router.put('/routes/:id/websocket-messages', atiende(async (req) => control.setWebsocketMessages(req.params.id, req.body, API)));

// ===== TAGS =====

router.get('/tags', atiende(async () => control.listTags()));

router.post('/tags', atiende(async (req, res) => {
    const creado = await control.createTag(req.body, API);
    res.status(201).json(creado);
}));

router.delete('/tags/:id', atiende(async (req) => control.deleteTag(req.params.id, API)));

// ===== ENTORNOS =====
// Se direccionan por nombre y no por id: el id es un uuid que nadie escribe en
// un script, y el nombre es lo que se ve en el panel

router.get('/environments', atiende(async () => control.listEnvironments()));

router.get('/environments/usage', atiende(async () => control.checkEnvironmentUsage()));

router.get('/environments/:name', atiende(async (req) => control.getEnvironment({ name: req.params.name })));

router.put('/environments/:name', atiende(async (req) => control.setEnvironment({
    name: req.params.name,
    variables: req.body.variables,
    mode: req.body.mode,
    activate: bool(req.body.activate) === true
}, API)));

router.delete('/environments/:name', atiende(async (req) => control.deleteEnvironment({ name: req.params.name }, API)));

router.post('/environments/:name/activate', atiende(async (req) => control.activateEnvironment({ name: req.params.name }, API)));

router.post('/environments/:name/rename', atiende(async (req) => control.renameEnvironment({
    name: req.params.name,
    new_name: req.body.new_name
}, API)));

router.put('/environments/:name/variables/:key', atiende(async (req) => control.setEnvVar({
    environment: req.params.name,
    key: req.params.key,
    value: req.body.value
}, API)));

router.delete('/environments/:name/variables/:key', atiende(async (req) => control.deleteEnvVar({
    environment: req.params.name,
    key: req.params.key
}, API)));

// ===== LOG =====

router.get('/logs', atiende(async (req) => control.queryLogs({
    ...filtrosDeLog(req.query),
    limit: numero(req.query.limit),
    offset: numero(req.query.offset),
    include_details: bool(req.query.include_details)
})));

router.delete('/logs', atiende(async (req) => control.clearLogs({
    from: numero(req.query.from),
    to: numero(req.query.to),
    level: lista(req.query.level),
    type: lista(req.query.type)
}, API)));

router.get('/logs/stats', atiende(async (req) => control.logStats(filtrosDeLog(req.query))));

router.get('/logs/traces/:traceId', atiende(async (req) => control.getTrace(req.params.traceId)));

router.post('/logs/mocks', atiende(async (req) => control.createMocksFromLogs(req.body, API)));

router.post('/logs/:id/mock', atiende(async (req) => control.createMockFromLogEntry(req.params.id, req.body, API)));

// ===== COMPROBACIONES =====

router.post('/verify/calls', atiende(async (req) => control.verifyCalls(req.body)));

router.get('/scenarios', atiende(async () => control.listScenarios()));

router.post('/scenarios/reset', atiende(async (req) => control.resetRouteSequence({ id: numero(req.body.id) }, API)));

// ===== ESPERA ACTIVA =====

router.get('/waiting', atiende(async () => control.listWaiting()));

router.post('/waiting/release', atiende(async (req) => control.releaseWaiting(req.body, API)));

// ===== CLIENTES WEBSOCKET =====

router.get('/ws/clients', atiende(async () => control.listWsClients()));

router.post('/ws/clients/send', atiende(async (req) => control.sendWsMessage(req.body, API)));

router.post('/ws/clients/:clientId/disconnect', atiende(async (req) => control.disconnectWsClient({ client_id: req.params.clientId }, API)));

// ===== VALIDACIONES =====
// Comprobar sin guardar: es lo que permite a un editor externo avisar del fallo
// mientras se escribe, en vez de al llegar la primera petición

router.post('/validate/regex', atiende(async (req) => control.validateRegex(req.body)));

router.post('/validate/criteria', atiende(async (req) => control.validateCriteria(req.body)));

router.post('/validate/script', atiende(async (req) => control.validateScript(req.body)));

// ===== NO ENCONTRADO =====
// Propio y no el genérico de la aplicación: dentro de /api/v1 la respuesta tiene
// que seguir siendo del formato de la API, con su código legible

router.use((req, res) => {
    res.status(404).json({
        error: `${req.method} ${req.baseUrl}${req.path} is not part of the API. See ${req.baseUrl}/openapi.json`,
        code: 'not_found'
    });
});

module.exports = router;
