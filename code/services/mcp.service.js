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
const logService = require('./log.service');
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
                'On a proxy route, response is the target URL.',
                'A graphql route needs set_graphql_operations (or import_graphql_schema) to answer anything.',
                'A websocket route needs set_websocket_messages to do anything.',
                'When several routes match, the lowest order wins; reorder_routes decides it.'
            ],
            workflow: {
                mock: 'create_route -> set_route_conditions',
                proxy: 'create_route (response = target URL) -> set_proxy_transform -> set_proxy_fallbacks',
                graphql: 'create_route -> import_graphql_schema or set_graphql_operations',
                websocket: 'create_route -> set_websocket_messages'
            }
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

    server.registerTool('set_proxy_fallbacks', {
        title: 'Set proxy fallbacks',
        description: 'Replaces the fallbacks of a proxy route: canned answers for when the backend times out, refuses the connection or returns 5xx. Each one can carry its own conditions. Proxy routes only.',
        inputSchema: {
            id: z.number(),
            fallbacks: z.array(z.object({
                name: z.string().optional(),
                path_pattern: z.string().describe('Regex against the path sent to the backend. Use .* for everything'),
                error_types: z.array(z.enum(['timeout', 'connection', 'http5xx', 'all'])).describe('Which failures trigger it'),
                status_code: z.string().optional().describe("Status code to answer with (200 by default)"),
                response_type: z.enum(RESPONSE_TYPES).optional(),
                response: z.string().optional(),
                conditions: z.array(conditionSchema).optional().describe('Refines the answer depending on the request')
            })).describe('The full list; an empty list removes all of them')
        }
    }, async ({ id, fallbacks }) => run('set_proxy_fallbacks', async () => {
        const ruta = await routesService.getRoute(id);
        if (!ruta) return fail(`Route ${id} not found`);
        if (ruta.tiporespuesta !== 'proxy') {
            return fail(`Route ${id} is of type "${ruta.tiporespuesta}"; fallbacks only exist on proxy routes`);
        }

        await routesService.saveFallbacks(id, fallbacks.map((f, i) => ({
            nombre: f.name || `fallback ${i + 1}`,
            path_pattern: f.path_pattern,
            error_types: f.error_types,
            codigo: f.status_code || '200',
            tiporespuesta: f.response_type || 'json',
            respuesta: f.response || '',
            activo: true,
            conditions: (f.conditions || []).map(c => ({
                nombre: c.name || null,
                criteria: c.criteria,
                codigo: c.status_code || null,
                tiporespuesta: c.response_type || null,
                respuesta: c.response || null,
                activo: 1
            }))
        })));

        log.success(`🤖 MCP: ${fallbacks.length} fallback(s) en la ruta ${id}`);
        const actualizada = await routesService.getRoute(id);
        return ok({ updated: true, route: toRouteView(actualizada, { detailed: true }) });
    }));

    server.registerTool('set_graphql_operations', {
        title: 'Set GraphQL operations',
        description: 'Replaces the operations of a GraphQL route. Each operation answers a query or mutation by name, either with mock data or by forwarding to the real server.',
        inputSchema: {
            id: z.number(),
            operations: z.array(z.object({
                name: z.string().describe('Operation or root field name, e.g. characters'),
                type: z.enum(['query', 'mutation']).default('query'),
                response: z.string().optional().describe('JSON body returned in mock mode'),
                use_proxy: z.boolean().optional().describe('Forward this operation to the real server instead of mocking it'),
                active: z.boolean().optional()
            })).describe('The full list; an empty list removes all of them')
        }
    }, async ({ id, operations }) => run('set_graphql_operations', async () => {
        const ruta = await routesService.getRoute(id);
        if (!ruta) return fail(`Route ${id} not found`);
        if (ruta.tiporespuesta !== 'graphql') {
            return fail(`Route ${id} is of type "${ruta.tiporespuesta}"; operations only exist on graphql routes`);
        }

        await routesService.saveGraphQLOperations(id, operations.map(op => ({
            operationName: op.name,
            operationType: op.type || 'query',
            respuesta: op.response || null,
            useProxy: op.use_proxy ? 1 : 0,
            activo: op.active === false ? 0 : 1
        })));

        log.success(`🤖 MCP: ${operations.length} operacion(es) GraphQL en la ruta ${id}`);
        const actualizada = await routesService.getRoute(id);
        return ok({ updated: true, route: toRouteView(actualizada, { detailed: true }) });
    }));

    server.registerTool('import_graphql_schema', {
        title: 'Import a GraphQL schema',
        description: 'Reads a real GraphQL endpoint by introspection and generates the mock operations automatically. The fastest way to get a usable GraphQL route.',
        inputSchema: {
            id: z.number(),
            url: z.string().describe('Endpoint to introspect, e.g. https://rickandmortyapi.com/graphql')
        }
    }, async ({ id, url }) => run('import_graphql_schema', async () => {
        const ruta = await routesService.getRoute(id);
        if (!ruta) return fail(`Route ${id} not found`);
        if (ruta.tiporespuesta !== 'graphql') {
            return fail(`Route ${id} is of type "${ruta.tiporespuesta}"; the schema only applies to graphql routes`);
        }

        const operations = await routesService.importGraphQLSchema(id, url);
        log.success(`🤖 MCP: esquema GraphQL importado en la ruta ${id} (${operations.length} operaciones)`);
        return ok({
            imported: true,
            operation_count: operations.length,
            operations: operations.map(o => ({ name: o.operationName, type: o.operationType }))
        });
    }));

    server.registerTool('set_websocket_messages', {
        title: 'Set WebSocket messages',
        description: 'Replaces the handlers of a WebSocket route: what to send on connect, what to answer to an incoming message, and what to send periodically.',
        inputSchema: {
            id: z.number(),
            messages: z.array(z.object({
                name: z.string().optional(),
                event_type: z.enum(['onConnect', 'onMessage', 'periodic']),
                match_pattern: z.string().optional().describe('For onMessage: text or regex to match. Empty matches everything'),
                is_regex: z.boolean().optional(),
                response: z.string().describe('Message sent to the client'),
                delay: z.number().optional().describe('Milliseconds to wait before sending'),
                interval: z.number().optional().describe('For periodic: milliseconds between sends')
            })).describe('The full list; an empty list removes all of them')
        }
    }, async ({ id, messages }) => run('set_websocket_messages', async () => {
        const ruta = await routesService.getRoute(id);
        if (!ruta) return fail(`Route ${id} not found`);
        if (ruta.tiporespuesta !== 'websocket') {
            return fail(`Route ${id} is of type "${ruta.tiporespuesta}"; messages only exist on websocket routes`);
        }

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

        log.success(`🤖 MCP: ${messages.length} mensaje(s) WebSocket en la ruta ${id}`);
        const actualizada = await routesService.getRoute(id);
        return ok({ updated: true, route: toRouteView(actualizada, { detailed: true }) });
    }));

    server.registerTool('reorder_routes', {
        title: 'Reorder routes',
        description: 'Sets the priority of the given routes. When several routes could answer the same request, the lowest order wins, so this decides which mock takes precedence.',
        inputSchema: {
            order: z.array(z.number()).describe('Route ids in the desired priority order, highest priority first')
        }
    }, async ({ order }) => run('reorder_routes', async () => {
        const rutas = await routesService.listRoutes();
        const existentes = new Set(rutas.map(r => r.id));
        const desconocidas = order.filter(id => !existentes.has(id));
        if (desconocidas.length) {
            return fail(`These routes do not exist: ${desconocidas.join(', ')}`);
        }

        // Los proxies viven en su propio rango alto para quedar siempre por
        // detrás de los mocks: se respeta numerándolos aparte
        const porId = new Map(rutas.map(r => [r.id, r]));
        const orders = [];
        let mock = 1;
        let proxy = 99999999;
        for (const id of order) {
            if (porId.get(id).tiporespuesta === 'proxy') {
                orders.push({ id, orden: proxy-- });
            } else {
                orders.push({ id, orden: mock++ });
            }
        }

        await routesService.reorderRoutes(orders);
        log.success(`🤖 MCP: ${orders.length} rutas reordenadas`);
        return ok({ reordered: orders.length, order: orders });
    }));

    server.registerTool('duplicate_route', {
        title: 'Duplicate a route',
        description: 'Copies a route to a new path, including its conditions, fallbacks, GraphQL operations and WebSocket messages. Handy for building variants of a flow.',
        inputSchema: {
            id: z.number(),
            new_path: z.string().describe('Path for the copy')
        }
    }, async ({ id, new_path }) => run('duplicate_route', async () => {
        const nuevoId = await routesService.duplicateRoute(id, new_path);
        log.success(`🤖 MCP: ruta ${id} duplicada en ${new_path}`);
        const copia = await routesService.getRoute(nuevoId);
        return ok({ created: true, route: toRouteView(copia, { detailed: true }) });
    }));

    server.registerTool('create_tag', {
        title: 'Create a tag',
        description: 'Creates a tag (or returns the existing one with that name) to classify routes.',
        inputSchema: {
            name: z.string(),
            color: z.string().optional().describe('Hex colour, e.g. #6366f1')
        }
    }, async ({ name, color }) => run('create_tag', async () => {
        const tag = await sqliteService.getOrCreateTag(name, color);
        return ok({ tag });
    }));

    server.registerTool('delete_tag', {
        title: 'Delete a tag',
        description: 'Deletes a tag and removes it from every route carrying it.',
        inputSchema: { id: z.string() }
    }, async ({ id }) => run('delete_tag', async () => {
        await sqliteService.deleteTag(id);
        return ok({ deleted: true, id });
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

    // Filtros del log, compartidos por las dos herramientas para que el resumen
    // y el detalle no puedan contar cosas distintas
    const logFilters = {
        from: z.number().optional().describe('Start of the range, epoch milliseconds'),
        to: z.number().optional().describe('End of the range, epoch milliseconds'),
        minutes: z.number().optional().describe('Shortcut: only the last N minutes. Ignored if from is given'),
        level: z.array(z.enum(['info', 'success', 'warning', 'error'])).optional(),
        type: z.array(z.string()).optional().describe('Entry type: mock, proxy, proxy-detailed, error, wait...'),
        method: z.string().optional(),
        status: z.string().optional().describe("Exact code ('404') or family ('4xx')"),
        url: z.string().optional().describe('Substring of the requested URL'),
        search: z.string().optional().describe('Free text over message, URL and details'),
        min_duration: z.number().optional().describe('Only entries slower than this, in ms'),
        trace_id: z.string().optional().describe('Only entries of one request, as returned by X-Mock-Trace-Id')
    };

    const toLogFilters = (args) => ({
        from: args.minutes && !args.from ? Date.now() - args.minutes * 60000 : args.from,
        to: args.to,
        level: args.level,
        type: args.type,
        method: args.method,
        status: args.status,
        url: args.url,
        search: args.search,
        minDuration: args.min_duration,
        traceId: args.trace_id
    });

    server.registerTool('query_logs', {
        title: 'Query the log',
        description: 'Reads the recorded traffic: which requests arrived, what was answered, how long it took and, for proxied requests, the full headers and bodies. This is how you find out what actually happened instead of guessing.',
        inputSchema: {
            ...logFilters,
            limit: z.number().optional().describe('Entries to return, 100 by default, 1000 max'),
            offset: z.number().optional(),
            include_details: z.boolean().optional().describe('Include headers and bodies. Off by default because they are big')
        }
    }, async (args) => run('query_logs', async () => {
        const resultado = await logService.query({
            ...toLogFilters(args),
            limit: args.limit,
            offset: args.offset
        });

        return ok({
            total: resultado.total,
            returned: resultado.count,
            entries: resultado.entries.map(e => {
                const vista = {
                    id: e.id,
                    at: e.ts,
                    level: e.level,
                    type: e.type,
                    message: e.message
                };
                if (e.method) vista.method = e.method;
                if (e.url) vista.url = e.url;
                if (e.status !== null) vista.status = e.status;
                if (e.duration !== null) vista.duration_ms = e.duration;
                if (e.target) vista.target = e.target;
                if (args.include_details && e.details) vista.details = e.details;
                return vista;
            })
        });
    }));

    server.registerTool('get_trace', {
        title: 'Get a request trace',
        description: 'The full story of one request in order: which route matched, which condition won, what each script did, what was asked of the backend and what came back. This is how you find out why a request answered what it answered instead of guessing from the final line.',
        inputSchema: {
            trace_id: z.string().describe('Trace id. Every answer carries it in the X-Mock-Trace-Id header, and query_logs returns it')
        }
    }, async ({ trace_id }) => run('get_trace', async () => {
        const traza = await logService.getTrace(trace_id);
        if (!traza) return fail(`Trace ${trace_id} not found. It may have been pruned by the log retention.`);
        return ok(traza);
    }));

    server.registerTool('log_stats', {
        title: 'Log summary',
        description: 'Totals by level, by type and by status code, average and worst duration, and a histogram over time. Use it to spot what is failing before pulling the individual entries.',
        inputSchema: logFilters
    }, async (args) => run('log_stats', async () => {
        const resumen = await logService.stats(toLogFilters(args));
        return ok({
            total: resumen.total,
            range: resumen.range,
            by_level: resumen.by_level,
            by_type: resumen.by_type,
            top_status: resumen.top_status,
            duration: resumen.duration,
            storage: logService.estado()
        });
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
