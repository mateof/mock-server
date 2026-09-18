/**
 * Control Service
 *
 * Las operaciones con las que se gobierna el servidor desde fuera: listar y
 * editar rutas, encenderlas y apagarlas, mover entornos, leer el log y
 * comprobar qué se llamó de verdad.
 *
 * Existe porque hay tres superficies pidiendo lo mismo (el panel, el servidor
 * MCP y la API REST v1) y cada una implementando lo suyo acaba divergiendo:
 * una valida algo que la otra no, una recarga la configuración de proxy y la
 * otra se olvida, y el fallo aparece solo por un lado. Aquí está la operación;
 * cada superficie pone encima su vocabulario de transporte (códigos HTTP,
 * errores MCP) y nada más.
 *
 * El vocabulario de entrada y salida es el de la API pública, en inglés
 * (`method`, `path`, `status_code`...), no el de la tabla, que es español
 * heredado (`tipo`, `ruta`, `codigo`). La traducción entre los dos vive en este
 * mismo fichero, en un solo sitio.
 *
 * La escritura de rutas pasa siempre por routes.service, que es quien valida y
 * recarga los proxys.
 */

const routesService = require('./routes.service');
const sqliteService = require('./sqlite.service');
const criteriaService = require('./criteria-evaluator.service');
const scriptRunner = require('./script-runner.service');
const logService = require('./log.service');
const recordingService = require('./recording.service');
const scenarioService = require('./scenario.service');
const environmentService = require('./environment.service');
const websocketService = require('./websocket.service');
const versionService = require('./version.service');
const semaphore = require('./semaphore.service');
const { log } = require('./socket.service');
const { version } = require('../package.json');

// ===== VOCABULARIO =====

const RESPONSE_TYPES = ['json', 'xml', 'soap', 'text', 'html', 'page', 'empty', 'sse', 'file', 'graphql', 'websocket', 'proxy'];
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'any'];

// Lo que puede imponer un paso, una condición o un fallback: solo lo que se
// construye a partir de un cuerpo de texto. Lo demás lo resuelve otro camino.
const BODY_RESPONSE_TYPES = routesService.BODY_RESPONSE_TYPES;

const ERROR_TYPES = routesService.ERROR_TYPES;
const WS_EVENT_TYPES = routesService.WS_EVENT_TYPES;

// ===== ERRORES =====

/**
 * Fallo de uso, no del servidor: el llamante pidió algo que no existe o que no
 * encaja. `code` es lo que cada superficie traduce a lo suyo (404, 400, 409...)
 * y `validation` lo que hace que el servidor MCP lo cuente como respuesta de
 * herramienta y no como error interno.
 */
class OperationError extends Error {
    constructor(message, code = 'invalid') {
        super(message);
        this.name = 'OperationError';
        this.code = code;
        this.validation = true;
    }
}

const invalid = (mensaje) => new OperationError(mensaje, 'invalid');
const notFound = (mensaje) => new OperationError(mensaje, 'not_found');
const unprocessable = (mensaje) => new OperationError(mensaje, 'unprocessable');

/**
 * Quién hizo el cambio, para la línea del terminal del panel. Verlo ahí es lo
 * que evita el "esto se ha movido solo" cuando un script de otra máquina
 * enciende y apaga mocks.
 */
function marca(source) {
    if (source === 'MCP') return '🤖 MCP';
    if (source === 'PANEL') return '🖥️ Panel';
    return '🔌 API';
}

const anotar = (source, mensaje, nivel = 'success') => log[nivel](`${marca(source)}: ${mensaje}`);

// ===== TRADUCCIÓN DE VOCABULARIOS =====

/**
 * Del vocabulario de la API al de la tabla.
 *
 * Solo copia lo que se pasa, para que sirva de parche sobre una base.
 */
function toPayload(args, base = {}) {
    const payload = { ...base };

    // En minúscula porque la resolución compara `tipo = ?` contra el método ya
    // normalizado: una ruta guardada como 'GET' no casaría con ninguna petición
    if (args.method !== undefined) payload.tipo = String(args.method).toLowerCase();
    if (args.path !== undefined) payload.ruta = args.path;
    if (args.status_code !== undefined) payload.codigo = args.status_code;
    if (args.response_type !== undefined) payload.tiporespuesta = args.response_type;
    if (args.response !== undefined) payload.respuesta = args.response;
    if (args.is_regex !== undefined) payload.isRegex = args.is_regex;
    if (args.active !== undefined) payload.activo = args.active;
    if (args.wait_mode !== undefined) payload.esperaActiva = args.wait_mode;
    if (args.custom_headers !== undefined) payload.customHeaders = args.custom_headers;
    if (args.tags !== undefined) payload.tags = args.tags;
    if (args.operation_id !== undefined) payload.operationId = args.operation_id;
    if (args.summary !== undefined) payload.summary = args.summary;
    if (args.description !== undefined) payload.description = args.description;
    if (args.proxy_timeout !== undefined) payload.proxyTimeout = args.proxy_timeout;
    if (args.proxy_request_headers !== undefined) payload.proxyRequestHeaders = args.proxy_request_headers;
    if (args.proxy_request_params !== undefined) payload.proxyRequestParams = args.proxy_request_params;
    if (args.proxy_pre_script !== undefined) payload.proxyPreScript = args.proxy_pre_script;
    if (args.proxy_post_script !== undefined) payload.proxyPostScript = args.proxy_post_script;
    if (args.recording !== undefined) payload.recording = args.recording;
    if (args.recording_mode !== undefined) payload.recordingMode = args.recording_mode;
    if (args.latency_mode !== undefined) payload.latencyMode = args.latency_mode;
    if (args.latency_ms !== undefined) payload.latencyMs = args.latency_ms;
    if (args.latency_max_ms !== undefined) payload.latencyMaxMs = args.latency_max_ms;
    if (args.fault_rate !== undefined) payload.faultRate = args.fault_rate;
    if (args.fault_type !== undefined) payload.faultType = args.fault_type;
    if (args.fault_status !== undefined) payload.faultStatus = args.fault_status;
    if (args.templating !== undefined) payload.templating = args.templating;
    if (args.sequence_mode !== undefined) payload.sequenceMode = args.sequence_mode;
    if (args.mock_script !== undefined) payload.mockScript = args.mock_script;
    if (args.sse_loop !== undefined) payload.sseLoop = args.sse_loop;

    if (args.conditions !== undefined) {
        payload.conditions = toConditionRows(args.conditions);
    }

    return payload;
}

/**
 * Condiciones al formato de la tabla. Lo usan las condiciones de una ruta y las
 * de un fallback, que se guardan igual.
 */
function toConditionRows(conditions) {
    return (conditions || []).map(c => ({
        nombre: c.name || null,
        criteria: c.criteria,
        codigo: c.status_code || null,
        tiporespuesta: c.response_type || null,
        respuesta: c.response || null,
        activo: 1
    }));
}

/**
 * Fila de la tabla al vocabulario de la API
 */
function toRouteView(row, { detailed = false, includeDocs = false } = {}) {
    if (!row) return null;

    const parse = (value) => {
        if (!value) return null;
        try { return JSON.parse(value); } catch (e) { return value; }
    };

    const view = {
        id: row.id,
        method: row.tipo,
        path: row.ruta,
        status_code: row.codigo,
        response_type: row.tiporespuesta,
        is_regex: row.isRegex === 1,
        active: row.activo !== 0,
        wait_mode: row.esperaActiva === 1,
        order: row.orden,
        tags: parse(row.tags) || []
    };

    if (row.summary) view.summary = row.summary;
    if (row.operationId) view.operation_id = row.operationId;

    // Que la ruta lleva instrucciones se dice siempre, aunque no se pidan: es
    // lo que hace que quien la lee sepa que hay algo que leer
    if (row.description) view.has_docs = true;
    if (includeDocs && row.description) view.docs = row.description;

    if (!detailed) return view;

    view.response = row.respuesta;
    view.description = row.description || null;
    // En una ruta de tipo file el cuerpo no está en `response` sino en un
    // fichero subido: sin esto no habría forma de saber cuál desde fuera
    if (row.tiporespuesta === 'file') {
        view.file = row.fileName
            ? { name: row.fileName, mime_type: row.fileMimeType || null }
            : null;
    }
    view.docs = row.description || null;
    view.custom_headers = parse(row.customHeaders) || [];
    if (row.templating === 1) view.templating = true;
    if (row.mock_script) view.mock_script = row.mock_script;
    if (row.tiporespuesta === 'sse') view.sse_loop = row.sse_loop === 1;

    if (Array.isArray(row.sequence) && row.sequence.length) {
        view.sequence_mode = row.sequence_mode || 'stick';
        view.sequence = row.sequence.map(p => ({
            name: p.nombre,
            status_code: p.codigo,
            response_type: p.tiporespuesta,
            response: p.respuesta,
            repeat: p.repeticiones || 1,
            active: p.activo !== 0
        }));
        view.calls_so_far = scenarioService.llamadas(row.id);
    }

    // Solo se asoma cuando hay algo configurado: en la inmensa mayoría de rutas
    // sería ruido en cada respuesta
    if ((row.latency_mode && row.latency_mode !== 'none') || row.fault_rate > 0) {
        view.latency = {
            mode: row.latency_mode || 'none',
            ms: row.latency_ms || 0,
            max_ms: row.latency_max_ms || 0
        };
        view.fault = {
            rate: row.fault_rate || 0,
            type: row.fault_type || 'error',
            status: row.fault_status || '500'
        };
    }

    if (row.tiporespuesta === 'proxy') {
        view.proxy_timeout = row.proxy_timeout;
        view.proxy_request_headers = parse(row.proxy_request_headers) || [];
        view.proxy_request_params = parse(row.proxy_request_params) || [];
        view.proxy_pre_script = row.proxy_pre_script || null;
        view.proxy_post_script = row.proxy_post_script || null;
        view.recording = row.recording === 1;
        view.recording_mode = row.recording_mode || 'update';
        view.fallbacks = (row.fallbacks || []).map(f => ({
            id: f.id,
            name: f.nombre,
            path_pattern: f.path_pattern,
            error_types: parse(f.error_types),
            status_code: f.codigo,
            response: f.respuesta
        }));
    }

    view.conditions = (row.conditions || []).map(c => ({
        id: c.id,
        name: c.nombre,
        criteria: c.criteria,
        status_code: c.codigo,
        response_type: c.tiporespuesta,
        response: c.respuesta
    }));

    if (row.graphqlOperations) {
        view.graphql_operations = row.graphqlOperations.map(o => ({
            name: o.operationName, type: o.operationType, use_proxy: o.useProxy === 1
        }));
    }
    if (row.websocketMessages) {
        view.websocket_messages = row.websocketMessages.map(m => ({
            name: m.nombre, event_type: m.event_type, match_pattern: m.match_pattern,
            is_regex: m.is_regex === 1, response: m.respuesta, delay: m.delay, interval: m.send_interval
        }));
    }

    return view;
}

/**
 * Payload completo a partir de una ruta existente.
 *
 * updateRoute reescribe la fila entera, así que cualquier operación que toque
 * un solo campo tiene que mandar todos los demás. Hacerlo a mano en cada una ya
 * apagó la grabación una vez al editar una transformación; con un solo sitio,
 * añadir una columna no puede volver a romperlas de una en una.
 */
function baseFromRoute(ruta) {
    return {
        tipo: ruta.tipo,
        ruta: ruta.ruta,
        codigo: ruta.codigo,
        respuesta: ruta.respuesta,
        tiporespuesta: ruta.tiporespuesta,
        esperaActiva: ruta.esperaActiva,
        isRegex: ruta.isRegex,
        customHeaders: ruta.customHeaders,
        activo: ruta.activo,
        tags: ruta.tags,
        operationId: ruta.operationId,
        summary: ruta.summary,
        description: ruta.description,
        requestBodyExample: ruta.requestBodyExample,
        proxyTimeout: ruta.proxy_timeout,
        proxyRequestHeaders: ruta.proxy_request_headers,
        proxyRequestParams: ruta.proxy_request_params,
        proxyPreScript: ruta.proxy_pre_script,
        proxyPostScript: ruta.proxy_post_script,
        recording: ruta.recording === 1,
        recordingMode: ruta.recording_mode,
        latencyMode: ruta.latency_mode,
        latencyMs: ruta.latency_ms,
        latencyMaxMs: ruta.latency_max_ms,
        faultRate: ruta.fault_rate,
        faultType: ruta.fault_type,
        faultStatus: ruta.fault_status,
        templating: ruta.templating === 1,
        sequenceMode: ruta.sequence_mode,
        mockScript: ruta.mock_script,
        sseLoop: ruta.sse_loop === 1
    };
}

// ===== SELECCIÓN DE RUTAS =====

function llevaTag(ruta, tag) {
    if (!ruta.tags) return false;
    try {
        // Por nombre o por id: quien llama desde fuera conoce los nombres, y
        // obligarle a traducir a id sería un paso de más
        const buscado = String(tag).toLowerCase();
        return JSON.parse(ruta.tags).some(t => t.id === tag || String(t.name).toLowerCase() === buscado);
    } catch (e) {
        return false;
    }
}

/**
 * Rutas que casan con un selector.
 *
 * El selector es lo que permite gobernar el servidor sin conocer los ids, que
 * es el caso normal desde fuera: un script de pruebas sabe el tag que le puso a
 * sus mocks, o el método y el camino, pero no el id que les tocó en la tabla.
 * Los filtros se combinan con Y.
 */
function tieneSelector(selector = {}) {
    const { ids, tag, method, path, path_contains, response_type, search } = selector;
    return Boolean((Array.isArray(ids) && ids.length) || tag || method || path
        || path_contains || response_type || search);
}

async function resolverRutas(selector = {}) {
    const { ids, tag, method, path, path_contains, response_type, search } = selector;

    if (!tieneSelector(selector)) {
        throw invalid('A selector is required: ids, tag, method, path, path_contains, response_type or search');
    }

    let rutas = await routesService.listRoutes({});

    if (Array.isArray(ids) && ids.length) {
        const buscados = new Set(ids.map(Number));
        rutas = rutas.filter(r => buscados.has(r.id));
    }
    if (tag) rutas = rutas.filter(r => llevaTag(r, tag));
    if (method) rutas = rutas.filter(r => String(r.tipo).toLowerCase() === String(method).toLowerCase());
    if (path) rutas = rutas.filter(r => r.ruta === path);
    if (path_contains) rutas = rutas.filter(r => String(r.ruta).includes(path_contains));
    if (response_type) rutas = rutas.filter(r => r.tiporespuesta === response_type);
    if (search) {
        const texto = String(search).toLowerCase();
        rutas = rutas.filter(r => [r.ruta, r.summary, r.operationId, r.description]
            .some(campo => campo && String(campo).toLowerCase().includes(texto)));
    }

    if (!rutas.length) {
        throw notFound(`No route matches the selector ${JSON.stringify(selector)}`);
    }

    return rutas;
}

/**
 * Ruta existente o error de "no existe", que es lo que casi todas las
 * operaciones necesitan antes de tocar nada
 */
async function exigirRuta(id) {
    const ruta = await routesService.getRoute(id);
    if (!ruta) throw notFound(`Route ${id} not found`);
    return ruta;
}

function exigirTipo(ruta, tipo, que) {
    if (ruta.tiporespuesta !== tipo) {
        throw unprocessable(`Route ${ruta.id} is of type "${ruta.tiporespuesta}"; ${que} only exist on ${tipo} routes`);
    }
}

// ===== SERVIDOR =====

async function serverInfo() {
    const rutas = await routesService.listRoutes();
    const porTipo = {};
    rutas.forEach(r => { porTipo[r.tiporespuesta] = (porTipo[r.tiporespuesta] || 0) + 1; });

    const documentadas = rutas.filter(r => r.description && r.description.trim()).length;
    const entorno = environmentService.activo();

    return {
        version,
        total_routes: rutas.length,
        active_routes: rutas.filter(r => r.activo !== 0).length,
        documented_routes: documentadas,
        routes_by_type: porTipo,
        response_types: RESPONSE_TYPES,
        http_methods: HTTP_METHODS,
        active_environment: entorno ? entorno.name : null,
        log: logService.estado(),
        notes: [
            'The /api and /mcp prefixes are reserved: a route there never answers.',
            'Exact matching ignores the query string; regex routes are tested against the full URL.',
            'Proxy routes are always evaluated after mocks, whatever their order.',
            'On a proxy route, response is the target URL.',
            'A graphql route needs its operations (or an imported schema) to answer anything.',
            'A websocket route needs its messages to do anything.',
            'When several routes match, the lowest order wins.',
            'Routes can carry documentation: what they simulate and how they are meant to be used.'
        ],
        workflow: {
            mock: 'create route -> set conditions',
            proxy: 'create route (response = target URL) -> set proxy transform -> set proxy fallbacks',
            graphql: 'create route -> import schema or set operations',
            websocket: 'create route -> set messages'
        }
    };
}

async function versionStatus({ force = false } = {}) {
    try {
        return await versionService.getStatus({ force });
    } catch (e) {
        // No poder comprobarlo no es un error para quien pregunta
        return {
            current: versionService.VERSION_ACTUAL,
            latest: null,
            update_available: false,
            package_url: versionService.URL_PAQUETE
        };
    }
}

// ===== RUTAS =====

async function listRoutes(args = {}) {
    let rutas = await routesService.listRoutes({
        tipo: args.method,
        tiporespuesta: args.response_type,
        activo: args.active,
        search: args.search
    });

    if (args.tag) rutas = rutas.filter(r => llevaTag(r, args.tag));
    if (args.documented !== undefined) {
        rutas = rutas.filter(r => Boolean(r.description && r.description.trim()) === args.documented);
    }

    return {
        count: rutas.length,
        documented: rutas.filter(r => r.description && r.description.trim()).length,
        routes: rutas.map(r => toRouteView(r, { includeDocs: args.include_docs === true }))
    };
}

async function getRoute(id) {
    return toRouteView(await exigirRuta(id), { detailed: true });
}

/**
 * Lo que en MCP comprueba el esquema de la herramienta y por HTTP no comprueba
 * nadie: sin esto, un cuerpo vacío creaba una ruta sin método ni camino que no
 * responde a nada y que hay que ir a buscar al panel para borrarla.
 */
function validarRuta(args, { alta = false } = {}) {
    if (alta) {
        const faltan = ['method', 'path', 'status_code', 'response_type']
            .filter(campo => args[campo] === undefined || args[campo] === null || args[campo] === '');
        if (faltan.length) throw invalid(`Missing required fields: ${faltan.join(', ')}`);
    }

    if (args.method !== undefined && !HTTP_METHODS.includes(String(args.method).toLowerCase())) {
        throw invalid(`Unknown method "${args.method}". Allowed: ${HTTP_METHODS.join(', ')}`);
    }
    if (args.response_type !== undefined && !RESPONSE_TYPES.includes(args.response_type)) {
        throw invalid(`Unknown response_type "${args.response_type}". Allowed: ${RESPONSE_TYPES.join(', ')}`);
    }
}

async function createRoute(args, { source, file = null } = {}) {
    validarRuta(args, { alta: true });

    // Una ruta de tipo file sin fichero se guarda tan ricamente y luego no
    // responde nada, así que se para aquí, que es donde se puede explicar
    if (args.response_type === 'file' && !file) {
        throw invalid('A route with response_type "file" needs the file itself: send it as multipart/form-data with a "file" part');
    }

    const id = await routesService.createRoute(toPayload(args), file ? { file } : {});
    anotar(source, `route created ${String(args.method || 'get').toUpperCase()} ${args.path}`);
    return { created: true, route: toRouteView(await routesService.getRoute(id), { detailed: true }) };
}

/**
 * Parche: se parte de lo que ya hay y se pisa solo lo indicado.
 *
 * La base sale de baseFromRoute y no de una lista escrita a mano porque
 * updateRoute reescribe la fila entera: un campo que falte en la base se queda
 * con su valor por defecto, y así es como se apagan solas la grabación, la
 * latencia o el templating de una ruta al cambiarle el código de estado.
 */
async function updateRoute(id, args, { source, file = 'keep' } = {}) {
    validarRuta(args);
    const actual = await exigirRuta(id);

    // Pasar una ruta a tipo file sin fichero, ni nuevo ni de antes, la deja
    // muda: es el mismo caso del alta y se para igual
    const seraFile = (args.response_type || actual.tiporespuesta) === 'file';
    if (seraFile && file === 'keep' && !actual.filePath) {
        throw invalid('A route with response_type "file" needs the file itself: send it as multipart/form-data with a "file" part');
    }

    await routesService.updateRoute(id, toPayload(args, baseFromRoute(actual)), { file });
    anotar(source, `route ${id} updated`);
    return { updated: true, route: toRouteView(await routesService.getRoute(id), { detailed: true }) };
}

async function deleteRoute(id, { source } = {}) {
    const ruta = await exigirRuta(id);
    await routesService.deleteRoute(id);
    anotar(source, `route deleted ${String(ruta.tipo).toUpperCase()} ${ruta.ruta}`, 'warning');
    return { deleted: true, id: Number(id) };
}

async function deleteRoutes(selector, { source } = {}) {
    const objetivo = await resolverRutas(selector);
    for (const ruta of objetivo) await routesService.deleteRoute(ruta.id);
    anotar(source, `${objetivo.length} routes deleted`, 'warning');
    return {
        deleted: objetivo.length,
        routes: objetivo.map(r => ({ id: r.id, method: r.tipo, path: r.ruta }))
    };
}

async function duplicateRoute(id, { new_path }, { source } = {}) {
    await exigirRuta(id);
    const nuevoId = await routesService.duplicateRoute(id, new_path);
    anotar(source, `route ${id} duplicated into ${new_path}`);
    return { created: true, route: toRouteView(await routesService.getRoute(nuevoId), { detailed: true }) };
}

/**
 * Enciende o apaga un conjunto de rutas.
 *
 * `exclusive` es lo que convierte esto en un interruptor de escenario: al
 * encender un grupo, apaga las rutas que competirían por la misma petición
 * (mismo método y mismo camino) y no están en el grupo. Sin eso, encender el
 * mock de error dejaría también encendido el de éxito y ganaría el de menor
 * orden, que no es lo que pide quien cambia de caso de prueba.
 *
 * Solo toca las que colisionan de verdad: una ruta que no responde a lo mismo
 * se queda como estaba.
 */
async function setRoutesActive({ active, exclusive = false, ...selector }, { source } = {}) {
    if (active === undefined) throw invalid('active is required');

    const objetivo = await resolverRutas(selector);
    const encendidas = await routesService.setActive(objetivo.map(r => r.id), active);

    let apagadas = [];
    if (active && exclusive) {
        const todas = await routesService.listRoutes({});
        const seleccionadas = new Set(objetivo.map(r => r.id));

        const compiten = todas.filter(otra => {
            if (seleccionadas.has(otra.id)) return false;
            if (otra.activo === 0) return false;
            return objetivo.some(elegida => mismaPeticion(elegida, otra));
        });

        if (compiten.length) {
            await routesService.setActive(compiten.map(r => r.id), false);
            apagadas = compiten.map(r => ({ id: r.id, method: r.tipo, path: r.ruta }));
        }
    }

    anotar(source, `${encendidas} routes ${active ? 'enabled' : 'disabled'}`
        + (apagadas.length ? `, ${apagadas.length} disabled for colliding with them` : ''));

    return {
        updated: encendidas,
        active: !!active,
        routes: objetivo.map(r => ({ id: r.id, method: r.tipo, path: r.ruta })),
        deactivated: apagadas
    };
}

/**
 * Dos rutas que se pisan: mismo camino y métodos que se solapan. `any` responde
 * a todos, así que solapa con cualquiera.
 */
function mismaPeticion(a, b) {
    if (String(a.ruta).toLowerCase() !== String(b.ruta).toLowerCase()) return false;
    const metodoA = String(a.tipo || '').toLowerCase();
    const metodoB = String(b.tipo || '').toLowerCase();
    return metodoA === metodoB || metodoA === 'any' || metodoB === 'any';
}

/**
 * `tag` es el que se pone o se quita; `match_tag` el que elige a quién. Son dos
 * cosas distintas y con un solo nombre no se podría, por ejemplo, quitar el tag
 * "wip" a todo lo que lleva "checkout".
 */
async function setRoutesTags({ tag, action, match_tag, ...selector }, { source } = {}) {
    if (!tag) throw invalid('tag is required');
    if (!['add', 'remove'].includes(action)) throw invalid("action must be 'add' or 'remove'");

    const selectorRutas = { ...selector, tag: match_tag };
    if (!tieneSelector(selectorRutas)) {
        throw invalid('A selector is required: ids, match_tag, method, path, path_contains, response_type or search');
    }

    const objetivo = await resolverRutas(selectorRutas);
    const nombre = String(tag).toLowerCase();
    let cambiadas = 0;

    for (const fila of objetivo) {
        const ruta = await routesService.getRoute(fila.id);
        let actuales = [];
        try { actuales = ruta.tags ? JSON.parse(ruta.tags) : []; } catch (e) { actuales = []; }

        const tenia = actuales.some(t => String(t.name).toLowerCase() === nombre);
        if (action === 'add' && tenia) continue;
        if (action === 'remove' && !tenia) continue;

        const nuevas = action === 'remove'
            ? actuales.filter(t => String(t.name).toLowerCase() !== nombre)
            : [...actuales, { name: tag }];

        await routesService.updateRoute(fila.id, { ...baseFromRoute(ruta), tags: nuevas }, { file: 'keep' });
        cambiadas += 1;
    }

    anotar(source, `tag "${tag}" ${action === 'add' ? 'added to' : 'removed from'} ${cambiadas} routes`);
    return { updated: cambiadas, tag, action };
}

/**
 * Prioridad explícita. El orden decide qué ruta gana cuando varias podrían
 * atender la misma petición.
 */
async function reorderRoutes({ order }, { source } = {}) {
    if (!Array.isArray(order) || !order.length) throw invalid('order must be a non-empty array of route ids');

    const rutas = await routesService.listRoutes();
    const porId = new Map(rutas.map(r => [r.id, r]));
    const desconocidas = order.map(Number).filter(id => !porId.has(id));
    if (desconocidas.length) throw notFound(`These routes do not exist: ${desconocidas.join(', ')}`);

    // Los proxys viven en su propio rango alto para quedar siempre por detrás
    // de los mocks: se respeta numerándolos aparte
    const orders = [];
    let mock = 1;
    let proxy = 99999999;
    for (const id of order.map(Number)) {
        orders.push(porId.get(id).tiporespuesta === 'proxy'
            ? { id, orden: proxy-- }
            : { id, orden: mock++ });
    }

    await routesService.reorderRoutes(orders);
    anotar(source, `${orders.length} routes reordered`);
    return { reordered: orders.length, order: orders };
}

// ===== DOCUMENTACIÓN DE UNA RUTA =====

async function getRouteDocs(id) {
    const ruta = await exigirRuta(id);
    return {
        id: ruta.id,
        method: ruta.tipo,
        path: ruta.ruta,
        docs: ruta.description || null,
        documented: Boolean(ruta.description && ruta.description.trim())
    };
}

async function setRouteDocs(id, { docs, append = false }, { source } = {}) {
    const ruta = await exigirRuta(id);
    if (docs === undefined || docs === null) throw invalid('docs is required (an empty string clears it)');

    const previo = ruta.description || '';
    const texto = append && previo ? `${previo.trimEnd()}\n\n${docs}` : docs;

    await routesService.setDocs(id, texto);
    anotar(source, `docs ${texto.trim() ? 'updated' : 'cleared'} on route ${id}`);
    return { updated: true, id: Number(id), docs: texto || null };
}

// ===== COMPORTAMIENTO DE UNA RUTA =====

async function setRouteConditions(id, { conditions }, { source } = {}) {
    await exigirRuta(id);
    if (!Array.isArray(conditions)) throw invalid('conditions must be an array (an empty one removes them all)');

    // Se valida antes de guardar: una condición que no compila no filtraría
    // nunca y el fallo aparecería en ejecución, lejos de aquí
    for (const c of conditions) {
        const check = criteriaService.validateCriteria(c.criteria);
        if (!check.valid) throw invalid(`Invalid criteria in "${c.name || c.criteria}": ${check.error}`);
    }

    await sqliteService.saveConditionalResponses(Number(id), toConditionRows(conditions));
    anotar(source, `${conditions.length} condition(s) on route ${id}`);
    return { updated: true, count: conditions.length };
}

async function getRouteConditions(id) {
    const ruta = await exigirRuta(id);
    return { id: ruta.id, conditions: toRouteView(ruta, { detailed: true }).conditions };
}

async function setProxyTransform(id, args, { source } = {}) {
    const ruta = await exigirRuta(id);
    exigirTipo(ruta, 'proxy', 'transforms');

    await routesService.updateRoute(id, toPayload({
        proxy_request_headers: args.request_headers,
        proxy_request_params: args.request_params,
        proxy_pre_script: args.pre_script,
        proxy_post_script: args.post_script
    }, baseFromRoute(ruta)), { file: 'keep' });

    anotar(source, `proxy transform updated on route ${id}`);
    return { updated: true, route: toRouteView(await routesService.getRoute(id), { detailed: true }) };
}

async function setProxyFallbacks(id, { fallbacks }, { source } = {}) {
    const ruta = await exigirRuta(id);
    exigirTipo(ruta, 'proxy', 'fallbacks');
    if (!Array.isArray(fallbacks)) throw invalid('fallbacks must be an array (an empty one removes them all)');

    await routesService.saveFallbacks(id, fallbacks.map((f, i) => ({
        nombre: f.name || `fallback ${i + 1}`,
        path_pattern: f.path_pattern,
        error_types: f.error_types,
        codigo: f.status_code || '200',
        tiporespuesta: f.response_type || 'json',
        respuesta: f.response || '',
        activo: true,
        conditions: toConditionRows(f.conditions)
    })));

    anotar(source, `${fallbacks.length} fallback(s) on route ${id}`);
    return { updated: true, route: toRouteView(await routesService.getRoute(id), { detailed: true }) };
}

async function setGraphqlOperations(id, { operations }, { source } = {}) {
    const ruta = await exigirRuta(id);
    exigirTipo(ruta, 'graphql', 'operations');
    if (!Array.isArray(operations)) throw invalid('operations must be an array (an empty one removes them all)');

    await routesService.saveGraphQLOperations(id, operations.map(op => ({
        operationName: op.name,
        operationType: op.type || 'query',
        respuesta: op.response || null,
        useProxy: op.use_proxy ? 1 : 0,
        activo: op.active === false ? 0 : 1
    })));

    anotar(source, `${operations.length} GraphQL operation(s) on route ${id}`);
    return { updated: true, route: toRouteView(await routesService.getRoute(id), { detailed: true }) };
}

async function importGraphqlSchema(id, { url }, { source } = {}) {
    const ruta = await exigirRuta(id);
    exigirTipo(ruta, 'graphql', 'schemas');
    if (!url) throw invalid('url is required');

    const operations = await routesService.importGraphQLSchema(id, url);
    anotar(source, `GraphQL schema imported on route ${id} (${operations.length} operations)`);
    return {
        imported: true,
        operation_count: operations.length,
        operations: operations.map(o => ({ name: o.operationName, type: o.operationType }))
    };
}

async function setWebsocketMessages(id, { messages }, { source } = {}) {
    const ruta = await exigirRuta(id);
    exigirTipo(ruta, 'websocket', 'messages');
    if (!Array.isArray(messages)) throw invalid('messages must be an array (an empty one removes them all)');

    await routesService.saveWebSocketMessages(id, messages.map(m => ({
        nombre: m.name || null,
        event_type: m.event_type,
        match_pattern: m.match_pattern || null,
        is_regex: m.is_regex ? 1 : 0,
        respuesta: m.response,
        delay: m.delay || 0,
        send_interval: m.interval || 0,
        activo: 1
    })));

    anotar(source, `${messages.length} WebSocket message(s) on route ${id}`);
    return { updated: true, route: toRouteView(await routesService.getRoute(id), { detailed: true }) };
}

async function setRouteSequence(id, { sequence, mode }, { source } = {}) {
    const ruta = await exigirRuta(id);
    if (ruta.tiporespuesta === 'proxy') {
        throw unprocessable(`Route ${id} is a proxy; scenarios only exist on mock routes`);
    }
    if (!Array.isArray(sequence)) throw invalid('sequence must be an array (an empty one removes the scenario)');

    await routesService.saveSequence(id, sequence.map(p => ({
        nombre: p.name || null,
        codigo: p.status_code || null,
        tiporespuesta: p.response_type || null,
        respuesta: p.response === undefined ? null : p.response,
        repeticiones: p.repeat || 1,
        activo: p.active !== false
    })), mode);

    anotar(source, `scenario of route ${id} updated (${sequence.length} steps)`);
    return { updated: true, route: toRouteView(await routesService.getRoute(id), { detailed: true }) };
}

async function resetRouteSequence({ id } = {}, { source } = {}) {
    const total = scenarioService.reiniciar(id);
    anotar(source, `scenario reset${id ? ` on route ${id}` : ' (all routes)'}`);
    return { reset: true, id: id ?? null, cleared: total };
}

function listScenarios() {
    const estado = scenarioService.estado();
    return { count: estado.length, scenarios: estado };
}

async function setRouteFaults(id, args, { source } = {}) {
    const ruta = await exigirRuta(id);
    const base = baseFromRoute(ruta);

    await routesService.updateRoute(id, {
        ...base,
        latencyMode: args.latency_mode === undefined ? base.latencyMode : args.latency_mode,
        latencyMs: args.latency_ms === undefined ? base.latencyMs : args.latency_ms,
        latencyMaxMs: args.latency_max_ms === undefined ? base.latencyMaxMs : args.latency_max_ms,
        faultRate: args.fault_rate === undefined ? base.faultRate : args.fault_rate,
        faultType: args.fault_type === undefined ? base.faultType : args.fault_type,
        faultStatus: args.fault_status === undefined ? base.faultStatus : args.fault_status
    }, { file: 'keep' });

    anotar(source, `latency and faults updated on route ${id}`);
    return { updated: true, route: toRouteView(await routesService.getRoute(id), { detailed: true }) };
}

async function setRouteRecording(id, { recording, mode }, { source } = {}) {
    const ruta = await exigirRuta(id);
    exigirTipo(ruta, 'proxy', 'recording');
    if (recording === undefined) throw invalid('recording is required');

    await routesService.updateRoute(id, {
        ...baseFromRoute(ruta),
        recording,
        recordingMode: mode || ruta.recording_mode
    }, { file: 'keep' });

    anotar(source, `recording ${recording ? 'enabled' : 'disabled'} on route ${id}`);
    return { updated: true, route: toRouteView(await routesService.getRoute(id), { detailed: true }) };
}

// ===== OBSERVACIÓN =====

async function routeUsage({ since_ms, include_unused } = {}) {
    const uso = await logService.usoPorRuta({ from: since_ms });
    const rutas = await routesService.listRoutes({});
    const incluirSinUso = include_unused !== false;

    const filas = rutas
        .map(r => {
            const datos = uso[r.id] || { calls: 0, last_call: null, errors: 0, avg_duration: null };
            return {
                id: r.id,
                method: r.tipo,
                path: r.ruta,
                active: r.activo !== 0,
                calls: datos.calls,
                last_call: datos.last_call ? new Date(datos.last_call).toISOString() : null,
                errors: datos.errors,
                avg_duration_ms: datos.avg_duration
            };
        })
        .filter(r => incluirSinUso || r.calls > 0)
        .sort((a, b) => b.calls - a.calls);

    return { routes: filas, unused: filas.filter(r => r.calls === 0).length, total: filas.length };
}

/**
 * "¿Se llamó a /orders, cuántas veces y con qué?" con una expectativa que el
 * llamante puede tratar como una aserción.
 */
async function verifyCalls(args = {}) {
    return logService.verificarLlamadas({
        path: args.path,
        method: args.method,
        status: args.status,
        bodyContains: args.body_contains,
        since: args.since_ms
    }, {
        times: args.times,
        atLeast: args.at_least,
        atMost: args.at_most
    });
}

/**
 * Filtros del log, compartidos por la consulta, el resumen y el vaciado, para
 * que el resumen y el detalle no puedan contar cosas distintas
 */
function toLogFilters(args = {}) {
    return {
        from: args.minutes && !args.from ? Date.now() - args.minutes * 60000 : args.from,
        to: args.to,
        level: args.level,
        type: args.type,
        method: args.method,
        status: args.status,
        url: args.url,
        search: args.search,
        routeId: args.route_id,
        minDuration: args.min_duration,
        traceId: args.trace_id
    };
}

async function queryLogs(args = {}) {
    const resultado = await logService.query({
        ...toLogFilters(args),
        limit: args.limit,
        offset: args.offset
    });

    return {
        total: resultado.total,
        returned: resultado.count,
        entries: resultado.entries.map(e => {
            const vista = { id: e.id, at: e.ts, level: e.level, type: e.type, message: e.message };
            if (e.method) vista.method = e.method;
            if (e.url) vista.url = e.url;
            if (e.status !== null) vista.status = e.status;
            if (e.duration !== null) vista.duration_ms = e.duration;
            if (e.target) vista.target = e.target;
            if (e.trace_id) vista.trace_id = e.trace_id;
            if (args.include_details && e.details) vista.details = e.details;
            return vista;
        })
    };
}

async function logStats(args = {}) {
    const resumen = await logService.stats(toLogFilters(args));
    return {
        total: resumen.total,
        range: resumen.range,
        by_level: resumen.by_level,
        by_type: resumen.by_type,
        top_status: resumen.top_status,
        duration: resumen.duration,
        histogram: resumen.histogram,
        storage: logService.estado()
    };
}

async function getTrace(traceId) {
    const traza = await logService.getTrace(traceId);
    if (!traza) throw notFound(`Trace ${traceId} not found. It may have been pruned by the log retention.`);
    return traza;
}

async function clearLogs(args = {}, { source } = {}) {
    const eliminados = await logService.clear({
        from: args.from,
        to: args.to,
        level: args.level,
        type: args.type
    });
    anotar(source, `${eliminados} log entries deleted`);
    return { deleted: eliminados };
}

async function createMocksFromLogs(args = {}, { source } = {}) {
    const resumen = await recordingService.desdeFiltrosDeLog({
        url: args.url,
        from: args.from,
        to: args.to,
        method: args.method,
        status: args.status,
        search: args.search,
        routeId: args.route_id,
        traceId: args.trace_id,
        limit: args.limit
    }, {
        activo: !!args.active,
        mode: args.mode,
        tags: args.tags
    });

    anotar(source, `${resumen.created} routes created and ${resumen.updated} updated from the log`);
    return resumen;
}

async function createMockFromLogEntry(logId, args = {}, { source } = {}) {
    const resultado = await recordingService.desdeEntradaDeLog(logId, {
        activo: args.active === undefined ? true : !!args.active,
        mode: args.mode,
        tags: args.tags
    });

    if (resultado.action === 'skipped') {
        throw unprocessable(`Log entry ${logId} could not be turned into a mock: ${resultado.reason}`);
    }

    anotar(source, `route ${resultado.id} ${resultado.action} from log entry ${logId}`);
    return resultado;
}

// ===== INTERACCIÓN =====

/**
 * Llama al propio servidor por HTTP.
 *
 * Se hace una petición de verdad y no se invoca el middleware a mano para que
 * pase por todo: cabeceras, cuerpo crudo, traza y log. Una llamada simulada
 * probaría un camino distinto del que usan los clientes.
 */
function llamarASiMismo({ method, path, headers, body, timeout }) {
    const http = require('http');
    const puerto = process.env.PORT || 3880;

    return new Promise((resolve, reject) => {
        const peticion = http.request({
            host: '127.0.0.1',
            port: puerto,
            path,
            method,
            headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }
        }, (respuesta) => {
            const trozos = [];
            respuesta.on('data', c => trozos.push(c));
            respuesta.on('end', () => {
                const texto = Buffer.concat(trozos).toString('utf8');
                resolve({ status: respuesta.statusCode, headers: respuesta.headers, body: intentarJson(texto) });
            });
        });

        peticion.setTimeout(timeout, () => {
            peticion.destroy();
            reject(new Error(`no answer in ${timeout} ms`));
        });
        peticion.on('error', reject);
        if (body) peticion.write(body);
        peticion.end();
    });
}

function intentarJson(texto) {
    if (!texto) return '';
    try { return JSON.parse(texto); } catch (e) { return texto; }
}

/**
 * Llama a una ruta configurada por el camino normal y devuelve lo que contestó.
 * Pasa por todo el pipeline, así que condiciones, escenarios, plantillas,
 * latencia y fallos se aplican, y la llamada aparece en el log como cualquier
 * otra.
 */
async function tryRoute(args = {}) {
    if (!args.path) throw invalid('path is required');

    const camino = args.path.startsWith('/') ? args.path : `/${args.path}`;
    if (routesService.isReservedRoute(camino)) {
        throw invalid(`${camino} is a reserved prefix of the panel, not a simulated route`);
    }

    const cabeceras = {};
    for (const regla of args.headers || []) {
        if (regla.action !== 'remove' && regla.name) cabeceras[regla.name] = regla.value || '';
    }
    if (args.body && !cabeceras['content-type'] && !cabeceras['Content-Type']) {
        // Sin content-type, un cuerpo JSON llega al mock como texto suelto y las
        // condiciones sobre body no casan: el fallo más probable aquí
        cabeceras['Content-Type'] = 'application/json';
    }

    const inicio = Date.now();
    try {
        const respuesta = await llamarASiMismo({
            method: (args.method || 'GET').toUpperCase(),
            path: camino,
            headers: cabeceras,
            body: args.body,
            timeout: args.timeout_ms || 10000
        });

        return {
            status: respuesta.status,
            duration_ms: Date.now() - inicio,
            headers: respuesta.headers,
            body: respuesta.body,
            trace_id: respuesta.headers['x-mock-trace-id'] || null
        };
    } catch (e) {
        throw unprocessable(`Could not call ${camino}: ${e.message}`);
    }
}

function listWaiting() {
    const lista = semaphore.getList();
    return {
        count: lista.length,
        waiting: lista.map(e => ({
            id: e.id, method: e.method, path: e.url, at: e.date,
            status_code: e.codigo, response_type: e.tiporespuesta
        }))
    };
}

function releaseWaiting(args = {}, { source } = {}) {
    const personalizada = (args.status_code || args.response)
        ? { code: args.status_code, body: args.response }
        : null;

    const objetivos = args.id ? [args.id] : semaphore.getList().map(e => e.id);
    if (!objetivos.length) throw notFound('There is no held request');

    const liberadas = objetivos.filter(id => semaphore.wakeUp(id, personalizada));
    if (!liberadas.length) throw notFound(`No held request with id ${args.id}`);

    anotar(source, `${liberadas.length} held request(s) released`);
    return { released: liberadas.length, ids: liberadas };
}

// ===== CLIENTES WEBSOCKET =====

function listWsClients() {
    const clients = websocketService.getConnectedClients();
    return { count: clients.length, clients };
}

function sendWsMessage({ client_ids, message }, { source } = {}) {
    if (!Array.isArray(client_ids) || !client_ids.length) throw invalid('client_ids must be a non-empty array');
    if (typeof message !== 'string') throw invalid('message must be a string');

    const sent = websocketService.sendMessageToClients(client_ids, message);
    anotar(source, `message sent to ${sent} WebSocket client(s)`);
    return { sent };
}

function disconnectWsClient({ client_id }, { source } = {}) {
    if (!client_id) throw invalid('client_id is required');
    const disconnected = websocketService.disconnectClient(client_id);
    if (!disconnected) throw notFound(`No WebSocket client with id ${client_id}`);
    anotar(source, `WebSocket client ${client_id} disconnected`);
    return { disconnected };
}

// ===== ENTORNOS =====

async function listEnvironments() {
    const entornos = await environmentService.listar();
    const activo = environmentService.activo();
    return { active: activo ? activo.name : null, count: entornos.length, environments: entornos };
}

async function getEnvironment({ name } = {}) {
    const entornos = await environmentService.listar();
    const entorno = name
        ? entornos.find(e => e.name.toLowerCase() === String(name).toLowerCase())
        : entornos.find(e => e.active);

    if (!entorno) throw notFound(name ? `Environment "${name}" not found` : 'There is no active environment');
    return { environment: entorno };
}

/**
 * Crea el entorno si el nombre es nuevo, o cambia sus variables si ya existe.
 *
 * Mezcla por defecto: reemplazar obliga a leer y reenviar todo, y el olvido de
 * una variable la borra sin decir nada.
 */
async function setEnvironment({ name, variables, mode, activate }, { source } = {}) {
    if (!name) throw invalid('name is required');

    const entornos = await environmentService.listar();
    let entorno = entornos.find(e => e.name.toLowerCase() === String(name).toLowerCase());

    try {
        if (!entorno) {
            entorno = await environmentService.crear(name, variables);
        } else if (variables) {
            if (mode === 'replace') await environmentService.guardarVariables(entorno.id, variables);
            else await environmentService.mezclarVariables(entorno.id, variables);
        }
        if (activate) await environmentService.activar(entorno.id);
    } catch (e) {
        throw invalid(e.message);
    }

    anotar(source, `environment "${name}" saved${activate ? ' and activated' : ''}`);
    const actualizados = await environmentService.listar();
    return {
        active: environmentService.activo().name,
        environment: actualizados.find(e => e.id === entorno.id)
    };
}

async function setEnvVar({ key, value, environment }, { source } = {}) {
    if (!key) throw invalid('key is required');
    try {
        const r = await environmentService.fijarVariable(environment, key, value);
        anotar(source, `${r.key} set in "${r.environment}"`);
        const entornos = await environmentService.listar();
        return { updated: true, ...r, environment_detail: entornos.find(e => e.name === r.environment) };
    } catch (e) {
        throw invalid(e.message);
    }
}

async function deleteEnvVar({ key, environment }, { source } = {}) {
    if (!key) throw invalid('key is required');
    let r;
    try {
        r = await environmentService.borrarVariable(environment, key);
    } catch (e) {
        throw invalid(e.message);
    }
    if (!r.deleted) throw notFound(`"${key}" does not exist in "${r.environment}"`);
    anotar(source, `${r.key} removed from "${r.environment}"`);
    return r;
}

async function renameEnvironment({ name, new_name }, { source } = {}) {
    if (!name || !new_name) throw invalid('name and new_name are required');
    try {
        const r = await environmentService.renombrar(name, new_name);
        anotar(source, `environment "${r.previous}" renamed to "${r.name}"`);
        return { renamed: true, ...r };
    } catch (e) {
        throw invalid(e.message);
    }
}

async function activateEnvironment({ name }, { source } = {}) {
    const entornos = await environmentService.listar();
    const entorno = entornos.find(e => e.name.toLowerCase() === String(name).toLowerCase());
    if (!entorno) throw notFound(`Environment "${name}" not found`);

    try {
        await environmentService.activar(entorno.id);
    } catch (e) {
        throw invalid(e.message);
    }

    anotar(source, `active environment switched to "${entorno.name}"`);
    return { active: entorno.name, variables: entorno.variables.length };
}

async function deleteEnvironment({ name }, { source } = {}) {
    const entornos = await environmentService.listar();
    const entorno = entornos.find(e => e.name.toLowerCase() === String(name).toLowerCase());
    if (!entorno) throw notFound(`Environment "${name}" not found`);

    try {
        await environmentService.eliminar(entorno.id);
    } catch (e) {
        // El caso normal aquí es "es el único que queda", que es una regla del
        // dominio y no un fallo: se cuenta tal cual
        throw invalid(e.message);
    }

    anotar(source, `environment "${entorno.name}" deleted`, 'warning');
    return { deleted: true, active: environmentService.activo().name };
}

async function checkEnvironmentUsage() {
    // El análisis vive en el servicio: duplicarlo aquí es como uno de los dos se
    // queda sin mirar un campo nuevo
    return environmentService.analizarUso();
}

// ===== TAGS =====

async function listTags() {
    const tags = await sqliteService.getAllTags();
    return { count: tags.length, tags };
}

async function createTag({ name, color }, { source } = {}) {
    if (!name) throw invalid('name is required');
    const tag = await sqliteService.getOrCreateTag(name, color);
    anotar(source, `tag "${tag.name}" available`);
    return { tag };
}

async function deleteTag(id, { source } = {}) {
    if (!id) throw invalid('id is required');
    await sqliteService.deleteTag(id);
    anotar(source, `tag ${id} deleted`, 'warning');
    return { deleted: true, id };
}

// ===== VALIDACIONES =====

function validateScript({ script, phase = 'request', test_context }) {
    if (typeof script !== 'string') throw invalid('script is required');

    const validation = scriptRunner.validateScript(script);
    if (!validation.valid) return { valid: false, error: validation.error };
    if (!test_context) return { valid: true };

    const vars = {};
    const outcome = phase === 'response'
        ? scriptRunner.runResponseScript(script, {
            status: test_context.status || 200,
            headers: test_context.headers || {},
            bodyText: test_context.body || '{}',
            request: {},
            vars
        })
        : scriptRunner.runRequestScript(script, {
            method: test_context.method || 'GET',
            path: test_context.path || '/',
            query: test_context.query || {},
            headers: test_context.headers || {},
            bodyText: test_context.body || '',
            vars
        });

    return { valid: true, result: outcome };
}

function validateCriteria({ criteria, test_context }) {
    if (typeof criteria !== 'string') throw invalid('criteria is required');

    const validation = criteriaService.validateCriteria(criteria);
    if (!validation.valid) return { valid: false, error: validation.error };
    if (!test_context) return { valid: true, helpers: criteriaService.getAvailableHelpers() };
    return { valid: true, result: criteriaService.evaluateCriteria(criteria, test_context) };
}

function validateRegex({ pattern, test_url }) {
    if (typeof pattern !== 'string') throw invalid('pattern is required');
    try {
        const regex = new RegExp(pattern);
        return { valid: true, matches: test_url ? regex.test(test_url) : null };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

function criteriaHelpers() {
    return { helpers: criteriaService.getAvailableHelpers() };
}

module.exports = {
    // Vocabulario
    RESPONSE_TYPES,
    HTTP_METHODS,
    BODY_RESPONSE_TYPES,
    ERROR_TYPES,
    WS_EVENT_TYPES,
    OperationError,

    // Traducción
    toPayload,
    toRouteView,
    toConditionRows,
    baseFromRoute,
    resolverRutas,
    validarRuta,
    tieneSelector,

    // Servidor
    serverInfo,
    versionStatus,

    // Rutas
    listRoutes,
    getRoute,
    createRoute,
    updateRoute,
    deleteRoute,
    deleteRoutes,
    duplicateRoute,
    setRoutesActive,
    setRoutesTags,
    reorderRoutes,
    getRouteDocs,
    setRouteDocs,

    // Comportamiento
    getRouteConditions,
    setRouteConditions,
    setProxyTransform,
    setProxyFallbacks,
    setGraphqlOperations,
    importGraphqlSchema,
    setWebsocketMessages,
    setRouteSequence,
    resetRouteSequence,
    listScenarios,
    setRouteFaults,
    setRouteRecording,

    // Observación
    routeUsage,
    verifyCalls,
    queryLogs,
    logStats,
    getTrace,
    clearLogs,
    createMocksFromLogs,
    createMockFromLogEntry,

    // Interacción
    tryRoute,
    listWaiting,
    releaseWaiting,
    listWsClients,
    sendWsMessage,
    disconnectWsClient,

    // Entornos
    listEnvironments,
    getEnvironment,
    setEnvironment,
    setEnvVar,
    deleteEnvVar,
    renameEnvironment,
    activateEnvironment,
    deleteEnvironment,
    checkEnvironmentUsage,

    // Tags
    listTags,
    createTag,
    deleteTag,

    // Validaciones
    validateScript,
    validateCriteria,
    validateRegex,
    criteriaHelpers
};
