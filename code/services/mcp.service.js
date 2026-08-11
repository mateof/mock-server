/**
 * MCP Service
 *
 * Expone el servidor como herramienta MCP para que un asistente pueda montar
 * flujos de mocks por su cuenta: listar, crear, editar y borrar rutas,
 * configurar condiciones y transformaciones de proxy, y validar antes de
 * guardar.
 *
 * Transporte HTTP en /mcp, autenticado con un Bearer token que se crea desde
 * el panel. Sin sesión: cada petición levanta su propio servidor y transporte
 * y se descarta al terminar. Para un servidor de solo herramientas no hace
 * falta estado entre llamadas, y así no hay sesiones que caduquen ni que
 * limpiar si el cliente desaparece.
 *
 * Toda la escritura pasa por routes.service.js, el mismo que usa el panel: si
 * cada superficie tuviera su propia lógica acabarían divergiendo en las
 * validaciones y los fallos saldrían solo por un lado.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const sqliteService = require('./sqlite.service');
const routesService = require('./routes.service');
const criteriaService = require('./criteria-evaluator.service');
const scriptRunner = require('./script-runner.service');
const { log } = require('./socket.service');
const { version } = require('../package.json');

const RESPONSE_TYPES = ['json', 'xml', 'soap', 'text', 'html', 'page', 'empty', 'file', 'graphql', 'websocket', 'proxy'];
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'any'];

// ===== ESQUEMAS REUTILIZADOS =====

const headerRuleSchema = z.object({
    action: z.enum(['set', 'remove']).describe("'set' adds or replaces, 'remove' deletes"),
    name: z.string().describe('Header or parameter name'),
    value: z.string().optional().describe("Value, only for 'set'")
});

const conditionSchema = z.object({
    name: z.string().optional().describe('Descriptive name for the condition'),
    criteria: z.string().describe("JavaScript expression over headers, body, query, path, params and method. E.g. headers['x-api-key'] === 'premium'"),
    status_code: z.string().optional().describe('Status code to return when the condition matches'),
    response_type: z.enum(RESPONSE_TYPES).optional(),
    response: z.string().optional().describe('Body to return when the condition matches')
});

// Campos comunes de alta y edición
const routeFields = {
    method: z.enum(HTTP_METHODS).optional().describe("HTTP method. 'any' answers all of them"),
    path: z.string().optional().describe("Path, e.g. /fake-api/users. It cannot start with /api or /mcp"),
    status_code: z.string().optional().describe("Status code, e.g. '200'. With '301' the body is the redirect target"),
    response_type: z.enum(RESPONSE_TYPES).optional(),
    response: z.string().optional().describe("Response body. On proxy routes, the target URL"),
    is_regex: z.boolean().optional().describe('Treat the path as a regular expression'),
    active: z.boolean().optional(),
    wait_mode: z.boolean().optional().describe('Active wait: holds the request until it is released from the panel'),
    custom_headers: z.array(headerRuleSchema).optional().describe('RESPONSE headers'),
    tags: z.array(z.object({ id: z.string(), name: z.string(), color: z.string().optional() })).optional(),
    operation_id: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    proxy_timeout: z.number().optional().describe('Timeout in ms for proxy routes (30000 by default)'),
    proxy_request_headers: z.array(headerRuleSchema).optional().describe('Rules applied to the REQUEST headers before calling the backend (proxy only)'),
    proxy_request_params: z.array(headerRuleSchema).optional().describe('Rules applied to the REQUEST query parameters (proxy only)'),
    proxy_pre_script: z.string().optional().describe('ms.* script that transforms the request before calling the backend (proxy only)'),
    proxy_post_script: z.string().optional().describe('ms.* script that transforms the response before returning it (proxy only)'),
    conditions: z.array(conditionSchema).optional().describe('Conditional responses, evaluated in order: the first match wins')
};

// ===== TRADUCCIÓN A LA CAPA DE SERVICIO =====

/**
 * Los nombres de la API MCP son los que le resultan naturales a un asistente;
 * la tabla usa los suyos, en español y heredados. La traducción vive aquí y en
 * un solo sitio.
 */
function toPayload(args, base = {}) {
    const payload = { ...base };

    if (args.method !== undefined) payload.tipo = args.method;
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

    if (args.conditions !== undefined) {
        payload.conditions = args.conditions.map(c => ({
            nombre: c.name || null,
            criteria: c.criteria,
            codigo: c.status_code || null,
            tiporespuesta: c.response_type || null,
            respuesta: c.response || null,
            activo: 1
        }));
    }

    return payload;
}

/**
 * Fila de la tabla al vocabulario de la API MCP
 */
function toRouteView(row, { detailed = false } = {}) {
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

    if (!detailed) return view;

    view.response = row.respuesta;
    view.description = row.description || null;
    view.custom_headers = parse(row.customHeaders) || [];

    if (row.tiporespuesta === 'proxy') {
        view.proxy_timeout = row.proxy_timeout;
        view.proxy_request_headers = parse(row.proxy_request_headers) || [];
        view.proxy_request_params = parse(row.proxy_request_params) || [];
        view.proxy_pre_script = row.proxy_pre_script || null;
        view.proxy_post_script = row.proxy_post_script || null;
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

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

/**
 * Ejecuta una herramienta traduciendo los errores de validación a un mensaje
 * que el asistente pueda leer y corregir, en vez de a un stack trace
 */
async function run(nombre, fn) {
    try {
        return await fn();
    } catch (error) {
        if (error && error.validation) {
            return fail(error.message);
        }
        console.error(`[MCP] Error en ${nombre}: ${error.message}`);
        return fail(`Error interno en ${nombre}: ${error.message}`);
    }
}

// ===== SERVIDOR =====

function buildServer() {
    const server = new McpServer(
        { name: 'mock-server', version },
        { capabilities: { tools: {} } }
    );

    server.registerTool('server_info', {
        title: 'Server info',
        description: 'Mock server state: version, route counts by type and the rules worth knowing before creating anything.',
        inputSchema: {}
    }, async () => run('server_info', async () => {
        const rutas = await routesService.listRoutes();
        const porTipo = {};
        rutas.forEach(r => { porTipo[r.tiporespuesta] = (porTipo[r.tiporespuesta] || 0) + 1; });

        return ok({
            version,
            total_routes: rutas.length,
            routes_by_type: porTipo,
            response_types: RESPONSE_TYPES,
            http_methods: HTTP_METHODS,
            notes: [
                'The /api and /mcp prefixes are reserved: a route there never answers.',
                'Exact matching ignores the query string; regex routes are tested against the full URL.',
                'Proxy routes are always evaluated after mocks, whatever their order.',
                'On a proxy route, response is the target URL.'
            ]
        });
    }));

    server.registerTool('list_routes', {
        title: 'List routes',
        description: 'Lists the configured routes in priority order. Supports filtering by method, response type, state and free text.',
        inputSchema: {
            method: z.enum(HTTP_METHODS).optional(),
            response_type: z.enum(RESPONSE_TYPES).optional(),
            active: z.boolean().optional(),
            search: z.string().optional().describe('Searches the path, the summary and the operationId')
        }
    }, async (args) => run('list_routes', async () => {
        const rutas = await routesService.listRoutes({
            tipo: args.method,
            tiporespuesta: args.response_type,
            activo: args.active,
            search: args.search
        });
        return ok({ count: rutas.length, routes: rutas.map(r => toRouteView(r)) });
    }));

    server.registerTool('get_route', {
        title: 'Get a route',
        description: 'Full detail of a route: body, headers, conditions and, for proxies, fallbacks and transforms.',
        inputSchema: { id: z.number().describe('Route id') }
    }, async ({ id }) => run('get_route', async () => {
        const ruta = await routesService.getRoute(id);
        if (!ruta) return fail(`No existe la ruta ${id}`);
        return ok(toRouteView(ruta, { detailed: true }));
    }));

    server.registerTool('create_route', {
        title: 'Create a route',
        description: 'Creates a mock or proxy route. A JSON mock needs method, path, status_code, response_type and response. On a proxy, response is the target URL.',
        inputSchema: {
            ...routeFields,
            method: z.enum(HTTP_METHODS).describe("HTTP method. 'any' answers all of them"),
            path: z.string().describe('Path, e.g. /fake-api/users'),
            status_code: z.string().describe("Status code, e.g. '200'"),
            response_type: z.enum(RESPONSE_TYPES)
        }
    }, async (args) => run('create_route', async () => {
        const id = await routesService.createRoute(toPayload(args));
        log.success(`🤖 MCP: ruta creada ${args.method.toUpperCase()} ${args.path}`);
        const ruta = await routesService.getRoute(id);
        return ok({ created: true, route: toRouteView(ruta, { detailed: true }) });
    }));

    server.registerTool('update_route', {
        title: 'Update a route',
        description: 'Changes only the fields you pass; everything else is kept as it is.',
        inputSchema: { id: z.number(), ...routeFields }
    }, async (args) => run('update_route', async () => {
        const actual = await routesService.getRoute(args.id);
        if (!actual) return fail(`No existe la ruta ${args.id}`);

        // Semántica de parche: se parte de lo que ya hay y se pisa lo indicado,
        // porque un asistente que manda dos campos no espera perder los demás
        const base = {
            tipo: actual.tipo,
            ruta: actual.ruta,
            codigo: actual.codigo,
            respuesta: actual.respuesta,
            tiporespuesta: actual.tiporespuesta,
            esperaActiva: actual.esperaActiva,
            isRegex: actual.isRegex,
            customHeaders: actual.customHeaders,
            activo: actual.activo,
            tags: actual.tags,
            operationId: actual.operationId,
            summary: actual.summary,
            description: actual.description,
            requestBodyExample: actual.requestBodyExample,
            proxyTimeout: actual.proxy_timeout,
            proxyRequestHeaders: actual.proxy_request_headers,
            proxyRequestParams: actual.proxy_request_params,
            proxyPreScript: actual.proxy_pre_script,
            proxyPostScript: actual.proxy_post_script
        };

        await routesService.updateRoute(args.id, toPayload(args, base), { file: 'keep' });
        log.success(`🤖 MCP: ruta ${args.id} actualizada`);
        const ruta = await routesService.getRoute(args.id);
        return ok({ updated: true, route: toRouteView(ruta, { detailed: true }) });
    }));

    server.registerTool('delete_route', {
        title: 'Delete a route',
        description: 'Deletes a route and everything attached to it (conditions, fallbacks, operations).',
        inputSchema: { id: z.number() }
    }, async ({ id }) => run('delete_route', async () => {
        const ruta = await routesService.getRoute(id);
        if (!ruta) return fail(`No existe la ruta ${id}`);
        await routesService.deleteRoute(id);
        log.warning(`🤖 MCP: ruta eliminada ${ruta.tipo.toUpperCase()} ${ruta.ruta}`);
        return ok({ deleted: true, id });
    }));

    server.registerTool('set_route_conditions', {
        title: 'Set conditional responses',
        description: 'Replaces the conditions of a route. They are evaluated in order and the first match wins; if none matches, the default response is used.',
        inputSchema: {
            id: z.number(),
            conditions: z.array(conditionSchema).describe('The full list; an empty list removes all of them')
        }
    }, async ({ id, conditions }) => run('set_route_conditions', async () => {
        const ruta = await routesService.getRoute(id);
        if (!ruta) return fail(`No existe la ruta ${id}`);

        // Se valida antes de guardar: una condición que no compila no filtraría
        // nunca y el fallo aparecería en ejecución, lejos de aquí
        for (const c of conditions) {
            const check = criteriaService.validateCriteria(c.criteria);
            if (!check.valid) return fail(`Criterio inválido en "${c.name || c.criteria}": ${check.error}`);
        }

        const payload = toPayload({ conditions });
        await sqliteService.saveConditionalResponses(id, payload.conditions);
        log.success(`🤖 MCP: ${conditions.length} condicion(es) en la ruta ${id}`);
        return ok({ updated: true, count: conditions.length });
    }));

    server.registerTool('set_proxy_transform', {
        title: 'Set a proxy transform',
        description: 'Request header and query parameter rules, plus the ms.* request and response scripts. Proxy routes only.',
        inputSchema: {
            id: z.number(),
            request_headers: z.array(headerRuleSchema).optional(),
            request_params: z.array(headerRuleSchema).optional(),
            pre_script: z.string().optional().describe('Transforms the request. It can short-circuit with ms.respond(code, body)'),
            post_script: z.string().optional().describe('Transforms the response before returning it')
        }
    }, async (args) => run('set_proxy_transform', async () => {
        const ruta = await routesService.getRoute(args.id);
        if (!ruta) return fail(`No existe la ruta ${args.id}`);
        if (ruta.tiporespuesta !== 'proxy') {
            return fail(`La ruta ${args.id} es de tipo "${ruta.tiporespuesta}"; las transformaciones solo existen en rutas proxy`);
        }

        await routesService.updateRoute(args.id, toPayload({
            proxy_request_headers: args.request_headers,
            proxy_request_params: args.request_params,
            proxy_pre_script: args.pre_script,
            proxy_post_script: args.post_script
        }, {
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
            proxyTimeout: ruta.proxy_timeout,
            proxyRequestHeaders: ruta.proxy_request_headers,
            proxyRequestParams: ruta.proxy_request_params,
            proxyPreScript: ruta.proxy_pre_script,
            proxyPostScript: ruta.proxy_post_script
        }), { file: 'keep' });

        log.success(`🤖 MCP: transformación actualizada en la ruta ${args.id}`);
        const actualizada = await routesService.getRoute(args.id);
        return ok({ updated: true, route: toRouteView(actualizada, { detailed: true }) });
    }));

    server.registerTool('validate_script', {
        title: 'Validate a transform script',
        description: 'Checks an ms.* script without saving it. With test_context it also runs it and returns the result.',
        inputSchema: {
            script: z.string(),
            phase: z.enum(['request', 'response']).default('request'),
            test_context: z.object({
                method: z.string().optional(),
                path: z.string().optional(),
                headers: z.record(z.string()).optional(),
                query: z.record(z.string()).optional(),
                body: z.string().optional(),
                status: z.number().optional()
            }).optional()
        }
    }, async ({ script, phase, test_context }) => run('validate_script', async () => {
        const validation = scriptRunner.validateScript(script);
        if (!validation.valid) return ok({ valid: false, error: validation.error });
        if (!test_context) return ok({ valid: true });

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

        return ok({ valid: true, result: outcome });
    }));

    server.registerTool('validate_criteria', {
        title: 'Validate a criteria expression',
        description: 'Checks a conditional-response expression and, when given a context, evaluates it.',
        inputSchema: {
            criteria: z.string(),
            test_context: z.object({
                headers: z.record(z.string()).optional(),
                query: z.record(z.string()).optional(),
                body: z.any().optional(),
                path: z.string().optional(),
                method: z.string().optional()
            }).optional()
        }
    }, async ({ criteria, test_context }) => run('validate_criteria', async () => {
        const validation = criteriaService.validateCriteria(criteria);
        if (!validation.valid) return ok({ valid: false, error: validation.error });
        if (!test_context) return ok({ valid: true, helpers: criteriaService.getAvailableHelpers() });
        return ok({ valid: true, result: criteriaService.evaluateCriteria(criteria, test_context) });
    }));

    server.registerTool('validate_regex', {
        title: 'Test a regex path',
        description: 'Checks that the regular expression compiles and, optionally, whether it matches a test URL.',
        inputSchema: {
            pattern: z.string(),
            test_url: z.string().optional()
        }
    }, async ({ pattern, test_url }) => run('validate_regex', async () => {
        try {
            const regex = new RegExp(pattern);
            return ok({ valid: true, matches: test_url ? regex.test(test_url) : null });
        } catch (e) {
            return ok({ valid: false, error: e.message });
        }
    }));

    server.registerTool('list_tags', {
        title: 'List tags',
        description: 'Tags available to classify routes.',
        inputSchema: {}
    }, async () => run('list_tags', async () => {
        const tags = await sqliteService.getAllTags();
        return ok({ count: tags.length, tags });
    }));

    return server;
}

// ===== TRANSPORTE HTTP =====

/**
 * Comprueba el Bearer token contra los creados desde el panel
 */
async function authenticate(req, res, next) {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);

    if (!match) {
        res.status(401)
            .set('WWW-Authenticate', 'Bearer realm="mock-server"')
            .json({ error: 'unauthorized', message: 'Falta la cabecera Authorization: Bearer <token>' });
        return;
    }

    try {
        const registro = await sqliteService.findMcpToken(match[1].trim());
        if (!registro) {
            console.log('[MCP] Token rechazado');
            res.status(401).json({ error: 'unauthorized', message: 'Token no válido o revocado' });
            return;
        }
        sqliteService.touchMcpToken(registro.id);
        req.mcpToken = registro;
        next();
    } catch (error) {
        console.error(`[MCP] Error comprobando el token: ${error.message}`);
        res.status(500).json({ error: 'internal_error' });
    }
}

/**
 * Una petición, un servidor. Sin estado que mantener entre llamadas no hay
 * sesiones que caducar ni que limpiar si el cliente se va sin avisar.
 */
async function handleRequest(req, res) {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
        transport.close();
        server.close();
    });

    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error(`[MCP] Error atendiendo la petición: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null
            });
        }
    }
}

/**
 * GET y DELETE existen en el transporte para sesiones con streaming del
 * servidor al cliente. Aquí no hay sesión, así que se responde 405 explícito
 * en vez de dejar que caiga en el 404 genérico y parezca que /mcp no existe.
 */
function methodNotAllowed(req, res) {
    res.status(405).set('Allow', 'POST').json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Este servidor MCP no mantiene sesión: usa POST' },
        id: null
    });
}

module.exports = {
    authenticate,
    handleRequest,
    methodNotAllowed,
    buildServer,
    // Expuestas para poder probar la traducción entre vocabularios, que es
    // donde se esconden los fallos de mapeo de campos
    toPayload,
    toRouteView,
    RESPONSE_TYPES,
    HTTP_METHODS
};
