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
 * Aquí solo vive el vocabulario: el esquema de argumentos de cada herramienta y
 * la descripción que lee el asistente. La operación la hace control.service.js,
 * la misma capa que atiende la API REST, y la escritura acaba siempre en
 * routes.service.js, el que usa el panel. Si cada superficie tuviera su propia
 * lógica acabarían divergiendo en las validaciones y los fallos saldrían solo
 * por un lado.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const sqliteService = require('./sqlite.service');
const control = require('./control.service');
const { version } = require('../package.json');

// Cada herramienta es una petición a la capa de control, la misma que atiende
// la API REST: aquí solo viven el esquema de argumentos y la descripción que
// lee el asistente.
const MCP = { source: 'MCP' };

const RESPONSE_TYPES = control.RESPONSE_TYPES;
const BODY_RESPONSE_TYPES = control.BODY_RESPONSE_TYPES;
const HTTP_METHODS = control.HTTP_METHODS;

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
    response_type: z.enum(BODY_RESPONSE_TYPES).optional(),
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
    // El id lo pone el registro, no quien llama: pedirlo obligaba al asistente a
    // inventarse uno que no casaba con nada, y el filtro del panel casa por id
    tags: z.array(z.object({
        name: z.string().describe('Tag name. It is the identity: the server registers it if it does not exist and assigns the id'),
        color: z.string().optional().describe('Hex colour, only used when the tag is created'),
        id: z.string().optional().describe('Ignored on write: the registry decides it')
    })).optional().describe('Tags for the route. Unknown ones are registered automatically, so they show up in the panel filter'),
    operation_id: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    proxy_timeout: z.number().optional().describe('Timeout in ms for proxy routes (30000 by default)'),
    proxy_request_headers: z.array(headerRuleSchema).optional().describe('Rules applied to the REQUEST headers before calling the backend (proxy only)'),
    proxy_request_params: z.array(headerRuleSchema).optional().describe('Rules applied to the REQUEST query parameters (proxy only)'),
    proxy_pre_script: z.string().optional().describe('ms.* script that transforms the request before calling the backend (proxy only)'),
    proxy_post_script: z.string().optional().describe('ms.* script that transforms the response before returning it (proxy only)'),
    latency_mode: z.enum(['none', 'fixed', 'random']).optional().describe('Injected latency: none, a fixed delay, or a random one between latency_ms and latency_max_ms'),
    latency_ms: z.number().optional().describe('Delay in ms (the lower bound when the mode is random)'),
    latency_max_ms: z.number().optional().describe('Upper bound in ms when the mode is random'),
    fault_rate: z.number().optional().describe('Percentage of requests that fail on purpose, 0 to 100'),
    fault_type: z.enum(['error', 'reset', 'empty']).optional().describe("What failing means: 'error' answers fault_status with a JSON body, 'reset' drops the connection, 'empty' answers the code with no body"),
    fault_status: z.string().optional().describe("Status code used when fault_type is 'error' or 'empty'. Default '500'"),
    sse_loop: z.boolean().optional().describe('For sse routes: start the event list over instead of closing when it runs out'),
    mock_script: z.string().optional().describe('ms.* script that shapes the response of a MOCK route, running last: after conditions, scenario and templating. It can read the request (ms.request.json(), headers, query) and change the response (ms.response.code, headers, setBody). On proxy routes use proxy_pre_script and proxy_post_script instead'),
    templating: z.boolean().optional().describe("Resolve {{...}} placeholders in the response body and headers. Off by default, because a response can legitimately contain {{...}}. Use {{body.x}}, {{query.x}}, {{params.x}}, {{headers.x}}, generators like {{uuid()}}, {{now('+1d')}}, {{randomInt(1,100)}}, {{pick('a','b')}}, and {{x ?? 'fallback'}}. In JSON, quote it to get a string and leave it unquoted to get a number, array or object"),
    conditions: z.array(conditionSchema).optional().describe('Conditional responses, evaluated in order: the first match wins')
};

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
    }, async (args) => run('server_info', async () => ok(await control.serverInfo())));

    server.registerTool('list_routes', {
        title: 'List routes',
        description: 'Lists the configured routes in priority order. Supports filtering by method, response type, state and free text. Routes carrying documentation are flagged with has_docs; pass include_docs to read that documentation in the same call, which is the cheap way to find out how the routes are meant to be used before touching them.',
        inputSchema: {
            method: z.enum(HTTP_METHODS).optional(),
            response_type: z.enum(RESPONSE_TYPES).optional(),
            active: z.boolean().optional(),
            search: z.string().optional().describe('Searches the path, the summary, the operationId and the documentation'),
            include_docs: z.boolean().optional().describe('Include each route\'s documentation in the listing. Off by default because it can be long'),
            documented: z.boolean().optional().describe('Only routes that have documentation (true) or only those that lack it (false)')
        }
    }, async (args) => run('list_routes', async () => ok(await control.listRoutes(args))));

    server.registerTool('get_route_docs', {
        title: 'Read a route\'s documentation',
        description: 'The instructions and notes written on a route: what it simulates, how it is meant to be called, what to be careful with. Read this before changing a route you did not create.',
        inputSchema: { id: z.number() }
    }, async (args) => run('get_route_docs', async () => ok(await control.getRouteDocs(args.id))));

    server.registerTool('set_route_docs', {
        title: 'Write a route\'s documentation',
        description: 'Replaces the documentation of a route. Markdown is the convention. Use it to leave instructions for whoever uses the route next, human or assistant: what it simulates, which headers it expects, what the scenario does. Only this field is touched, so nothing else about the route can be lost.',
        inputSchema: {
            id: z.number(),
            docs: z.string().describe('The documentation. An empty string clears it'),
            append: z.boolean().optional().describe('Add to the end of what is already there instead of replacing it')
        }
    }, async (args) => run('set_route_docs', async () => ok(await control.setRouteDocs(args.id, args, MCP))));

    server.registerTool('get_route', {
        title: 'Get a route',
        description: 'Full detail of a route: body, headers, conditions and, for proxies, fallbacks and transforms.',
        inputSchema: { id: z.number().describe('Route id') }
    }, async (args) => run('get_route', async () => ok(await control.getRoute(args.id))));

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
    }, async (args) => run('create_route', async () => ok(await control.createRoute(args, MCP))));

    server.registerTool('update_route', {
        title: 'Update a route',
        description: 'Changes only the fields you pass; everything else is kept as it is.',
        inputSchema: { id: z.number(), ...routeFields }
    }, async (args) => run('update_route', async () => ok(await control.updateRoute(args.id, args, MCP))));

    server.registerTool('delete_route', {
        title: 'Delete a route',
        description: 'Deletes a route and everything attached to it (conditions, fallbacks, operations).',
        inputSchema: { id: z.number() }
    }, async (args) => run('delete_route', async () => ok(await control.deleteRoute(args.id, MCP))));

    server.registerTool('set_route_conditions', {
        title: 'Set conditional responses',
        description: 'Replaces the conditions of a route. They are evaluated in order and the first match wins; if none matches, the default response is used.',
        inputSchema: {
            id: z.number(),
            conditions: z.array(conditionSchema).describe('The full list; an empty list removes all of them')
        }
    }, async (args) => run('set_route_conditions', async () => ok(await control.setRouteConditions(args.id, args, MCP))));

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
    }, async (args) => run('set_proxy_transform', async () => ok(await control.setProxyTransform(args.id, args, MCP))));

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
                response_type: z.enum(BODY_RESPONSE_TYPES).optional(),
                response: z.string().optional(),
                conditions: z.array(conditionSchema).optional().describe('Refines the answer depending on the request')
            })).describe('The full list; an empty list removes all of them')
        }
    }, async (args) => run('set_proxy_fallbacks', async () => ok(await control.setProxyFallbacks(args.id, args, MCP))));

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
    }, async (args) => run('set_graphql_operations', async () => ok(await control.setGraphqlOperations(args.id, args, MCP))));

    server.registerTool('import_graphql_schema', {
        title: 'Import a GraphQL schema',
        description: 'Reads a real GraphQL endpoint by introspection and generates the mock operations automatically. The fastest way to get a usable GraphQL route.',
        inputSchema: {
            id: z.number(),
            url: z.string().describe('Endpoint to introspect, e.g. https://rickandmortyapi.com/graphql')
        }
    }, async (args) => run('import_graphql_schema', async () => ok(await control.importGraphqlSchema(args.id, args, MCP))));

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
    }, async (args) => run('set_websocket_messages', async () => ok(await control.setWebsocketMessages(args.id, args, MCP))));

    server.registerTool('reorder_routes', {
        title: 'Reorder routes',
        description: 'Sets the priority of the given routes. When several routes could answer the same request, the lowest order wins, so this decides which mock takes precedence.',
        inputSchema: {
            order: z.array(z.number()).describe('Route ids in the desired priority order, highest priority first')
        }
    }, async (args) => run('reorder_routes', async () => ok(await control.reorderRoutes(args, MCP))));

    server.registerTool('duplicate_route', {
        title: 'Duplicate a route',
        description: 'Copies a route to a new path, including its conditions, fallbacks, GraphQL operations and WebSocket messages. Handy for building variants of a flow.',
        inputSchema: {
            id: z.number(),
            new_path: z.string().describe('Path for the copy')
        }
    }, async (args) => run('duplicate_route', async () => ok(await control.duplicateRoute(args.id, args, MCP))));

    server.registerTool('create_tag', {
        title: 'Create a tag',
        description: 'Creates a tag (or returns the existing one with that name) to classify routes.',
        inputSchema: {
            name: z.string(),
            color: z.string().optional().describe('Hex colour, e.g. #6366f1')
        }
    }, async (args) => run('create_tag', async () => ok(await control.createTag(args, MCP))));

    server.registerTool('delete_tag', {
        title: 'Delete a tag',
        description: 'Deletes a tag and removes it from every route carrying it.',
        inputSchema: { id: z.string() }
    }, async (args) => run('delete_tag', async () => ok(await control.deleteTag(args.id, MCP))));

    server.registerTool('verify_calls', {
        title: 'Check what was actually called',
        description: 'Answers "was /orders called, how many times, and with what?". Give an expectation (times, at_least, at_most) and it reports whether it holds, so a flow can be built, exercised and then checked without leaving the conversation. Matches on the recorded request: path, method, resulting status and a substring of the body. Bounded by log retention.',
        inputSchema: {
            path: z.string().optional().describe('Substring of the path, e.g. /orders'),
            method: z.string().optional(),
            status: z.string().optional().describe('Exact code (404) or family (2xx) of the response given'),
            body_contains: z.string().optional().describe('Substring that must appear in the recorded request body'),
            since_ms: z.number().optional().describe('Epoch ms lower bound. Use it to check only what happened after a step'),
            times: z.number().optional().describe('Expect exactly this many calls'),
            at_least: z.number().optional(),
            at_most: z.number().optional()
        }
    }, async (args) => run('verify_calls', async () => ok(await control.verifyCalls(args))));

    server.registerTool('set_routes_active', {
        title: 'Enable or disable routes in bulk',
        description: 'Turns a whole set of routes on or off at once, by id or by tag. "Disable everything tagged payments" or "enable only the demo set". Disabling is how you let traffic fall through to a proxy again without deleting the mocks.',
        inputSchema: {
            active: z.boolean(),
            ids: z.array(z.number()).optional().describe('Route ids. Takes precedence over tag'),
            tag: z.string().optional().describe('Tag name or id: every route carrying it')
        }
    }, async (args) => run('set_routes_active', async () => ok(await control.setRoutesActive(args, MCP))));

    server.registerTool('route_usage', {
        title: 'Which routes are actually used',
        description: 'Calls, last use, errors and average duration per route, taken from the log. Useful to find dead routes before cleaning up, or to confirm the traffic you expected actually landed. Bounded by log retention: what fell out of the log is no longer counted.',
        inputSchema: {
            since_ms: z.number().optional().describe('Epoch ms lower bound. Without it, everything still in the log'),
            include_unused: z.boolean().optional().describe('Also list routes with no calls at all. Default true')
        }
    }, async (args) => run('route_usage', async () => ok(await control.routeUsage(args))));

    server.registerTool('set_route_sequence', {
        title: 'Set a stateful scenario',
        description: 'Makes a route answer differently depending on how many times it has been called: first pending, then processing, then done. This is what simulates polling flows, which conditional responses cannot: conditions only look at the request, and in a poll every request is identical. The sequence wins over conditional responses. The call counter lives in memory and resets when the server restarts or when reset_route_sequence is called.',
        inputSchema: {
            id: z.number(),
            mode: z.enum(['stick', 'loop']).optional().describe("What happens after the last step: 'stick' repeats it (default), 'loop' starts over"),
            sequence: z.array(z.object({
                name: z.string().optional().describe('Label for the step, shown in the trace'),
                status_code: z.string().optional(),
                response_type: z.enum(BODY_RESPONSE_TYPES).optional(),
                response: z.string().optional(),
                repeat: z.number().optional().describe('How many consecutive calls this step covers. Default 1'),
                active: z.boolean().optional()
            })).describe('Steps in order. An empty array removes the scenario')
        }
    }, async (args) => run('set_route_sequence', async () => ok(await control.setRouteSequence(args.id, args, MCP))));

    server.registerTool('reset_route_sequence', {
        title: 'Restart a scenario',
        description: 'Puts the call counter back to zero so the scenario starts from its first step again. Without an id, every scenario is reset.',
        inputSchema: { id: z.number().optional() }
    }, async (args) => run('reset_route_sequence', async () => ok(await control.resetRouteSequence(args, MCP))));

    server.registerTool('set_route_faults', {
        title: 'Set latency and fault injection',
        description: 'Makes a route slow, unreliable, or both. This is how you test timeouts, retries and degradation, which a mock that always answers instantly cannot exercise. Works on any route type, mock and proxy alike. On a proxy the delay happens before calling the backend and an injected fault never reaches it.',
        inputSchema: {
            id: z.number(),
            latency_mode: z.enum(['none', 'fixed', 'random']).optional(),
            latency_ms: z.number().optional().describe('Delay in ms, or the lower bound when the mode is random'),
            latency_max_ms: z.number().optional().describe('Upper bound in ms when the mode is random'),
            fault_rate: z.number().optional().describe('Percentage of requests that fail, 0 to 100'),
            fault_type: z.enum(['error', 'reset', 'empty']).optional(),
            fault_status: z.string().optional().describe("Status code for 'error' and 'empty'. Default '500'")
        }
    }, async (args) => run('set_route_faults', async () => ok(await control.setRouteFaults(args.id, args, MCP))));

    // ===== GRABACIÓN =====

    server.registerTool('set_route_recording', {
        title: 'Turn recording on or off',
        description: 'Puts a proxy route into recording mode: every backend response is saved as a mock route. Recorded routes are created INACTIVE, because an active mock outranks the proxy and would stop any further traffic reaching the backend. Activate them with update_route once the session is captured.',
        inputSchema: {
            id: z.number(),
            recording: z.boolean(),
            mode: z.enum(['update', 'skip']).optional().describe('What to do when a mock for that method and path already exists. Default: update')
        }
    }, async (args) => run('set_route_recording', async () => ok(await control.setRouteRecording(args.id, args, MCP))));

    server.registerTool('create_mocks_from_logs', {
        title: 'Turn recorded traffic into mocks',
        description: 'Creates mock routes from proxied traffic already in the log: "everything that went through /orders in the last hour". Takes the newest response for each method and path, so repeated calls yield one route, not one per call. Entries whose body the log truncated, or whose response is binary, are reported as skipped instead of producing a broken mock.',
        inputSchema: {
            url: z.string().optional().describe('Substring of the path, e.g. /orders'),
            from: z.number().optional().describe('Epoch ms, lower bound'),
            to: z.number().optional().describe('Epoch ms, upper bound'),
            method: z.string().optional(),
            status: z.string().optional().describe('Exact code (404) or family (2xx)'),
            trace_id: z.string().optional(),
            limit: z.number().optional().describe('How many log entries to examine, max 1000'),
            active: z.boolean().optional().describe('Whether the created routes are active. Default false, so they do not shadow the proxy they came from'),
            mode: z.enum(['update', 'skip']).optional().describe('What to do when the mock already exists. Default: update'),
            tags: z.array(z.string()).optional()
        }
    }, async (args) => run('create_mocks_from_logs', async () => ok(await control.createMocksFromLogs(args, MCP))));

    server.registerTool('create_mock_from_log_entry', {
        title: 'Turn one log line into a mock',
        description: 'Creates a mock route from a single log entry, using its id as returned by query_logs. The route is created active, because asking for one specific entry is an explicit choice.',
        inputSchema: {
            log_id: z.number(),
            active: z.boolean().optional(),
            mode: z.enum(['update', 'skip']).optional(),
            tags: z.array(z.string()).optional()
        }
    }, async (args) => run('create_mock_from_log_entry', async () => ok(await control.createMockFromLogEntry(args.log_id, args, MCP))));

    server.registerTool('try_route', {
        title: 'Call a route and see what it answers',
        description: 'Sends a request to a configured route through this same server and returns the status, headers and body. This is how you close the loop after configuring something: build it, call it, check it, without leaving the conversation. It goes through the whole pipeline, so conditions, scenarios, templating, latency and faults all apply, and the call shows up in the log like any other.',
        inputSchema: {
            path: z.string().describe('Path to call, e.g. /orders?page=2'),
            method: z.string().optional().describe('Default GET'),
            body: z.string().optional().describe('Request body, as text'),
            headers: z.array(headerRuleSchema).optional().describe('Request headers, using the set action'),
            timeout_ms: z.number().optional().describe('Default 10000')
        }
    }, async (args) => run('try_route', async () => ok(await control.tryRoute(args))));

    server.registerTool('list_waiting', {
        title: 'Requests held by active wait',
        description: 'Routes with active wait hold their requests until something releases them. This lists what is currently held, with the response each one is about to send.',
        inputSchema: {}
    }, async (args) => run('list_waiting', async () => ok(control.listWaiting())));

    server.registerTool('release_waiting', {
        title: 'Release a held request',
        description: 'Lets a request held by active wait continue, optionally overriding what it answers. Without an id, everything currently held is released. This is what makes it possible to drive a flow that pauses, which until now could only be done by hand from the panel.',
        inputSchema: {
            id: z.string().optional().describe('The held request id, from list_waiting. Without it, all of them'),
            status_code: z.string().optional().describe('Override the status it answers'),
            response: z.string().optional().describe('Override the body it answers')
        }
    }, async (args) => run('release_waiting', async () => ok(control.releaseWaiting(args, MCP))));

    server.registerTool('delete_routes', {
        title: 'Delete several routes at once',
        description: 'Removes a set of routes by id, or every route carrying a tag. Deleting is not reversible, so prefer set_routes_active to turn things off.',
        inputSchema: {
            ids: z.array(z.number()).optional(),
            tag: z.string().optional().describe('Tag name or id: every route carrying it')
        }
    }, async (args) => run('delete_routes', async () => ok(await control.deleteRoutes(args, MCP))));

    server.registerTool('set_routes_tags', {
        title: 'Add or remove a tag on several routes',
        description: 'Tags or untags a set of routes in one call. The tag is created in the registry if it does not exist, so it shows up in the panel filter.',
        inputSchema: {
            tag: z.string().describe('Tag name'),
            action: z.enum(['add', 'remove']),
            ids: z.array(z.number()).optional(),
            match_tag: z.string().optional().describe('Instead of ids: every route carrying this other tag')
        }
    }, async (args) => run('set_routes_tags', async () => ok(await control.setRoutesTags(args, MCP))));

    server.registerTool('clear_logs', {
        title: 'Empty the log',
        description: 'Deletes recorded traffic. Without filters it clears everything; with them, only what matches, which is the safe way to start a clean measurement without losing the rest.',
        inputSchema: {
            from_ms: z.number().optional(),
            to_ms: z.number().optional(),
            level: z.string().optional().describe('info, success, warning or error'),
            type: z.string().optional()
        }
    }, async (args) => run('clear_logs', async () => ok(await control.clearLogs({
            from: args.from_ms,
            to: args.to_ms,
            level: args.level ? [args.level] : null,
            type: args.type ? [args.type] : null
        }, MCP))));

    // ===== ENTORNOS =====

    server.registerTool('list_environments', {
        title: 'List environments and their variables',
        description: 'Environments hold variables that routes reference as ${NAME} in the proxy target, the response body and the headers. Only one is active, and that is the one routes resolve against. Read this before pointing routes at a backend, so you use the variable instead of hardcoding a URL.',
        inputSchema: {}
    }, async (args) => run('list_environments', async () => ok(await control.listEnvironments())));

    server.registerTool('set_environment', {
        title: 'Create an environment or change its variables',
        description: 'Creates an environment if the name is new, or replaces the variables of an existing one. Replacing is how a variable is removed. Pass activate to make it the one routes resolve against.',
        inputSchema: {
            name: z.string(),
            variables: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
            mode: z.enum(['merge', 'replace']).optional()
                .describe("How to apply variables. 'merge' (default) adds and updates without touching the rest; 'replace' makes the list the whole set, which is how you delete several at once. To change one variable, set_env_var is safer than either"),
            activate: z.boolean().optional().describe('Make it the active environment')
        }
    }, async (args) => run('set_environment', async () => ok(await control.setEnvironment(args, MCP))));

    server.registerTool('get_environment', {
        title: 'Read one environment',
        description: 'The variables of a single environment, by name. Without a name, the active one.',
        inputSchema: { name: z.string().optional() }
    }, async (args) => run('get_environment', async () => ok(await control.getEnvironment(args))));

    server.registerTool('set_env_var', {
        title: 'Set one environment variable',
        description: 'Creates or updates a single variable, leaving every other one alone. Prefer this over set_environment when changing one value: set_environment takes a list, and getting that list wrong can remove variables you did not mean to touch.',
        inputSchema: {
            key: z.string(),
            value: z.string(),
            environment: z.string().optional().describe('Environment name. Without it, the active one')
        }
    }, async (args) => run('set_env_var', async () => ok(await control.setEnvVar(args, MCP))));

    server.registerTool('delete_env_var', {
        title: 'Delete one environment variable',
        description: 'Removes a single variable, leaving the rest in place. Routes referencing it keep the ${NAME} text and start reporting it as undefined, which check_environment_usage will show.',
        inputSchema: {
            key: z.string(),
            environment: z.string().optional().describe('Environment name. Without it, the active one')
        }
    }, async (args) => run('delete_env_var', async () => ok(await control.deleteEnvVar(args, MCP))));

    server.registerTool('rename_environment', {
        title: 'Rename an environment',
        description: 'Changes the name, keeping its variables and whether it was the active one.',
        inputSchema: { name: z.string(), new_name: z.string() }
    }, async (args) => run('rename_environment', async () => ok(await control.renameEnvironment(args, MCP))));

    server.registerTool('activate_environment', {
        title: 'Switch the active environment',
        description: 'Makes an environment the one routes resolve their ${NAME} references against. It takes effect on the next request, with no reload.',
        inputSchema: { name: z.string() }
    }, async (args) => run('activate_environment', async () => ok(await control.activateEnvironment(args, MCP))));

    server.registerTool('delete_environment', {
        title: 'Delete an environment',
        description: 'Removes an environment and its variables. The last remaining one cannot be deleted, and deleting the active one moves the flag to another.',
        inputSchema: { name: z.string() }
    }, async (args) => run('delete_environment', async () => ok(await control.deleteEnvironment(args, MCP))));

    server.registerTool('check_environment_usage', {
        title: 'Which routes reference variables, and which are missing',
        description: 'Reports every route that uses ${NAME} and, of those, which names the active environment does not define. It looks at the response body, headers, proxy target and rules, the scripts, and the criteria of conditions and fallbacks. Undefined variables are left in the text rather than blanked, so a route can answer with ${NAME} inside it; this is how you find that before it happens.',
        inputSchema: {}
    }, async (args) => run('check_environment_usage', async () => ok(await control.checkEnvironmentUsage())));

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
    }, async (args) => run('validate_script', async () => ok(control.validateScript(args))));

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
    }, async (args) => run('validate_criteria', async () => ok(control.validateCriteria(args))));

    server.registerTool('validate_regex', {
        title: 'Test a regex path',
        description: 'Checks that the regular expression compiles and, optionally, whether it matches a test URL.',
        inputSchema: {
            pattern: z.string(),
            test_url: z.string().optional()
        }
    }, async (args) => run('validate_regex', async () => ok(control.validateRegex(args))));

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

    server.registerTool('query_logs', {
        title: 'Query the log',
        description: 'Reads the recorded traffic: which requests arrived, what was answered, how long it took and, for proxied requests, the full headers and bodies. This is how you find out what actually happened instead of guessing.',
        inputSchema: {
            ...logFilters,
            limit: z.number().optional().describe('Entries to return, 100 by default, 1000 max'),
            offset: z.number().optional(),
            include_details: z.boolean().optional().describe('Include headers and bodies. Off by default because they are big')
        }
    }, async (args) => run('query_logs', async () => ok(await control.queryLogs(args))));

    server.registerTool('get_trace', {
        title: 'Get a request trace',
        description: 'The full story of one request in order: which route matched, which condition won, what each script did, what was asked of the backend and what came back. This is how you find out why a request answered what it answered instead of guessing from the final line.',
        inputSchema: {
            trace_id: z.string().describe('Trace id. Every answer carries it in the X-Mock-Trace-Id header, and query_logs returns it')
        }
    }, async (args) => run('get_trace', async () => ok(await control.getTrace(args.trace_id))));

    server.registerTool('log_stats', {
        title: 'Log summary',
        description: 'Totals by level, by type and by status code, average and worst duration, and a histogram over time. Use it to spot what is failing before pulling the individual entries.',
        inputSchema: logFilters
    }, async (args) => run('log_stats', async () => ok(await control.logStats(args))));

    server.registerTool('list_tags', {
        title: 'List tags',
        description: 'Tags available to classify routes.',
        inputSchema: {}
    }, async (args) => run('list_tags', async () => ok(await control.listTags())));

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
    // Se reexportan desde control.service: la traducción entre vocabularios es
    // la misma para MCP y para la API REST, y aquí se mantiene el nombre por el
    // que ya la importaban las pruebas
    toPayload: control.toPayload,
    toRouteView: control.toRouteView,
    RESPONSE_TYPES,
    HTTP_METHODS
};
