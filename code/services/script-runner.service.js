/**
 * Script Runner Service
 *
 * Ejecuta los scripts de transformación de las rutas proxy dentro de un
 * sandbox `vm`, con una API inspirada en la pestaña Scripts de Postman (`ms.*`).
 *
 * Hay dos momentos:
 *   - pre-request : transforma la petición antes de enviarla al backend y
 *                   puede cortocircuitarla con ms.respond(...)
 *   - post-response: transforma la respuesta del backend antes de devolverla
 *
 * Las mismas advertencias que en criteria-evaluator.service.js: `vm` no es un
 * sandbox de seguridad, es un aislamiento de conveniencia. La lista negra de
 * patrones y el timeout limitan los accidentes, no a un atacante decidido.
 * Quien puede escribir scripts aquí es quien tiene acceso al panel.
 */

const vm = require('vm');

// Tiempo máximo de ejecución de un script
const SCRIPT_TIMEOUT_MS = 1000;

// Longitud máxima de un script
const MAX_SCRIPT_LENGTH = 20000;

// Patrones no permitidos. Derivados de criteria-evaluator.service.js, con dos
// diferencias deliberadas: aquí no se bloquea `exec` (rompería
// regex.exec(), y child_process sigue bloqueado aparte) y sí se bloquea
// `Buffer`, que expone memoria sin inicializar con allocUnsafe.
const DANGEROUS_PATTERNS = [
    { pattern: /require\s*\(/i, name: 'require()' },
    { pattern: /\bimport\s*[({'"`]/i, name: 'import' },
    { pattern: /eval\s*\(/i, name: 'eval()' },
    { pattern: /\bFunction\s*\(/i, name: 'Function()' },
    { pattern: /process\s*\./i, name: 'process' },
    { pattern: /global(This)?\s*\./i, name: 'global' },
    { pattern: /\bthis\s*\./, name: 'this' },
    { pattern: /constructor/i, name: 'constructor' },
    { pattern: /__proto__/i, name: '__proto__' },
    { pattern: /prototype/i, name: 'prototype' },
    { pattern: /Reflect\s*\./i, name: 'Reflect' },
    { pattern: /\bProxy\s*\(/i, name: 'Proxy()' },
    { pattern: /\bBuffer\b/i, name: 'Buffer' },
    { pattern: /\bchild_process\b/i, name: 'child_process' },
    { pattern: /\bspawn\s*\(/i, name: 'spawn()' },
    { pattern: /\bfs\s*\./i, name: 'fs' },
];

// Marca interna para distinguir el cortocircuito de un error real
const SHORT_CIRCUIT = Symbol('shortCircuit');

/**
 * Valida un script sin ejecutarlo (sintaxis + patrones prohibidos)
 */
function validateScript(script) {
    if (script === null || script === undefined || script === '') {
        return { valid: true, empty: true };
    }

    if (typeof script !== 'string') {
        return { valid: false, error: 'El script debe ser texto' };
    }

    const trimmed = script.trim();
    if (trimmed.length === 0) {
        return { valid: true, empty: true };
    }

    if (trimmed.length > MAX_SCRIPT_LENGTH) {
        return { valid: false, error: `El script excede el límite de ${MAX_SCRIPT_LENGTH} caracteres` };
    }

    for (const { pattern, name } of DANGEROUS_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { valid: false, error: `El script usa "${name}", que no está permitido` };
        }
    }

    try {
        new vm.Script(trimmed);
    } catch (e) {
        return { valid: false, error: `Error de sintaxis: ${e.message}` };
    }

    return { valid: true, empty: false };
}

// ===== API DE PARES CLAVE/VALOR (headers y query params) =====

/**
 * Construye la API estilo Postman sobre un objeto plano.
 * Las cabeceras van en minúsculas porque HTTP no distingue mayúsculas y así
 * `remove('Authorization')` quita la que llegó como `authorization`.
 */
function createKeyValueApi(store, { lowercase = false } = {}) {
    const normalize = (key) => {
        const k = String(key == null ? '' : key);
        return lowercase ? k.toLowerCase() : k;
    };

    const api = {
        get(key) {
            const value = store[normalize(key)];
            return value === undefined ? null : value;
        },
        has(key) {
            return Object.prototype.hasOwnProperty.call(store, normalize(key));
        },
        set(key, value) {
            store[normalize(key)] = value == null ? '' : String(value);
            return api;
        },
        // Postman usa add/upsert con un objeto {key, value}
        add(item, maybeValue) {
            if (item && typeof item === 'object') {
                return api.set(item.key, item.value);
            }
            return api.set(item, maybeValue);
        },
        upsert(item, maybeValue) {
            return api.add(item, maybeValue);
        },
        remove(key) {
            delete store[normalize(key)];
            return api;
        },
        clear() {
            Object.keys(store).forEach(k => delete store[k]);
            return api;
        },
        all() {
            return Object.keys(store).map(key => ({ key, value: store[key] }));
        },
        toObject() {
            return { ...store };
        },
        each(fn) {
            api.all().forEach(item => fn(item));
            return api;
        },
        count() {
            return Object.keys(store).length;
        }
    };

    return api;
}

// ===== API DE CUERPO =====

/**
 * Envuelve el cuerpo para que el script lo lea como texto o como JSON y pueda
 * sustituirlo. Se reserializa solo si el script lo tocó de verdad: si únicamente
 * lo leyó, el cuerpo original se reenvía byte a byte.
 */
function createBodyApi(rawText) {
    const state = {
        text: rawText == null ? '' : String(rawText),
        explicitlySet: false,
        jsonCache: undefined,
        jsonSnapshot: null,
        parseError: null
    };

    const api = {
        text() {
            return state.explicitlySet || state.jsonCache === undefined
                ? state.text
                : JSON.stringify(state.jsonCache);
        },
        json() {
            if (state.jsonCache === undefined) {
                try {
                    state.jsonCache = state.text === '' ? null : JSON.parse(state.text);
                    state.jsonSnapshot = JSON.stringify(state.jsonCache);
                } catch (e) {
                    state.jsonCache = null;
                    state.jsonSnapshot = 'null';
                    state.parseError = e.message;
                }
            }
            return state.jsonCache;
        },
        set(value) {
            state.explicitlySet = true;
            state.jsonCache = undefined;
            state.jsonSnapshot = null;
            if (value == null) {
                state.text = '';
            } else if (typeof value === 'string') {
                state.text = value;
            } else {
                state.text = JSON.stringify(value);
            }
            return api;
        },
        isJson() {
            api.json();
            return state.parseError === null && state.jsonCache !== null;
        }
    };

    // Devuelve el cuerpo final y si cambió respecto al original
    api.__resolve = () => {
        if (state.explicitlySet) {
            return { changed: true, text: state.text };
        }
        // Mutación en el objeto devuelto por json(): se detecta comparando
        if (state.jsonCache !== undefined) {
            const now = JSON.stringify(state.jsonCache);
            if (now !== state.jsonSnapshot) {
                return { changed: true, text: now === undefined ? '' : now };
            }
        }
        return { changed: false, text: state.text };
    };

    return api;
}

// ===== CONSOLA =====

function createConsole(logs) {
    const push = (level) => (...args) => {
        const message = args.map(a => {
            if (typeof a === 'string') return a;
            try {
                return JSON.stringify(a);
            } catch (e) {
                return String(a);
            }
        }).join(' ');
        // Un script en bucle no debe poder llenar la memoria del proceso
        if (logs.length < 100) {
            logs.push({ level, message: message.substring(0, 2000) });
        }
    };
    return { log: push('log'), info: push('info'), warn: push('warn'), error: push('error'), debug: push('log') };
}

/**
 * Ejecuta un script en el sandbox y normaliza el resultado
 */
function runInSandbox(script, sandbox, logs) {
    try {
        vm.runInContext(script, vm.createContext(sandbox), {
            timeout: SCRIPT_TIMEOUT_MS,
            displayErrors: false
        });
        return { success: true, logs };
    } catch (error) {
        if (error && error[SHORT_CIRCUIT]) {
            return { success: true, logs, shortCircuit: error.payload };
        }
        const message = error && error.message ? error.message : 'Error desconocido';
        return { success: false, error: message, logs };
    }
}

/**
 * Construye ms.respond / respond, que cortan la ejecución lanzando una marca
 */
function createResponder() {
    return function respond(code, body, headers) {
        const error = new Error('__short_circuit__');
        error[SHORT_CIRCUIT] = true;
        error.payload = {
            code: Number(code) || 200,
            body: body === undefined ? null : body,
            headers: headers && typeof headers === 'object' ? headers : {}
        };
        throw error;
    };
}

/**
 * Ejecuta el script de pre-request.
 *
 * ctx: { method, path, query, headers, bodyText, vars }
 * Devuelve { success, error, logs, shortCircuit?, result }
 */
function runRequestScript(script, ctx) {
    const validation = validateScript(script);
    if (!validation.valid) {
        return { success: false, error: validation.error, logs: [] };
    }
    if (validation.empty) {
        return { success: true, logs: [], result: null };
    }

    const headers = { ...(ctx.headers || {}) };
    const query = { ...(ctx.query || {}) };
    const vars = ctx.vars || {};
    const logs = [];
    const bodyApi = createBodyApi(ctx.bodyText);

    const state = {
        method: (ctx.method || 'GET').toUpperCase(),
        path: ctx.path || '/'
    };

    const consoleApi = createConsole(logs);
    const respond = createResponder();

    const ms = {
        request: {
            get method() { return state.method; },
            set method(v) { state.method = String(v || '').toUpperCase(); },
            get path() { return state.path; },
            set path(v) { state.path = String(v == null ? '' : v); },
            url: {
                get path() { return state.path; },
                set path(v) { state.path = String(v == null ? '' : v); },
                query: createKeyValueApi(query)
            },
            headers: createKeyValueApi(headers, { lowercase: true }),
            body: bodyApi
        },
        variables: createKeyValueApi(vars),
        respond,
        console: consoleApi
    };

    const sandbox = { ms, console: consoleApi, respond, atob, btoa };

    const outcome = runInSandbox(script, sandbox, logs);
    if (!outcome.success) return outcome;
    if (outcome.shortCircuit) return outcome;

    const body = bodyApi.__resolve();

    return {
        success: true,
        logs,
        result: {
            method: state.method,
            path: state.path,
            query,
            headers,
            body,
            vars
        }
    };
}

/**
 * Ejecuta el script de post-response.
 *
 * ctx: { status, headers, bodyText, request, vars }
 * Devuelve { success, error, logs, result }
 */
function runResponseScript(script, ctx) {
    const validation = validateScript(script);
    if (!validation.valid) {
        return { success: false, error: validation.error, logs: [] };
    }
    if (validation.empty) {
        return { success: true, logs: [], result: null };
    }

    const headers = { ...(ctx.headers || {}) };
    const vars = ctx.vars || {};
    const logs = [];
    const bodyApi = createBodyApi(ctx.bodyText);
    const state = { code: Number(ctx.status) || 200 };

    const consoleApi = createConsole(logs);
    const requestCtx = ctx.request || {};

    const ms = {
        response: {
            get code() { return state.code; },
            set code(v) { state.code = Number(v) || state.code; },
            get status() { return state.code; },
            set status(v) { state.code = Number(v) || state.code; },
            headers: createKeyValueApi(headers, { lowercase: true }),
            json: () => bodyApi.json(),
            text: () => bodyApi.text(),
            setBody: (v) => bodyApi.set(v),
            body: bodyApi
        },
        // La petición ya se envió: aquí es de solo lectura
        request: {
            method: requestCtx.method || 'GET',
            path: requestCtx.path || '/',
            headers: createKeyValueApi({ ...(requestCtx.headers || {}) }, { lowercase: true }),
            url: {
                path: requestCtx.path || '/',
                query: createKeyValueApi({ ...(requestCtx.query || {}) })
            }
        },
        variables: createKeyValueApi(vars),
        console: consoleApi
    };

    const sandbox = { ms, console: consoleApi, atob, btoa };

    const outcome = runInSandbox(script, sandbox, logs);
    if (!outcome.success) return outcome;

    const body = bodyApi.__resolve();

    return {
        success: true,
        logs,
        result: {
            status: state.code,
            headers,
            body,
            vars
        }
    };
}

/**
 * Aplica una lista declarativa [{action:'set'|'remove', name, value}] sobre un
 * objeto de cabeceras o de parámetros. Devuelve el número de cambios.
 */
function applyKeyValueRules(target, rules, { lowercase = false } = {}) {
    if (!rules) return 0;

    let parsed = rules;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch (e) {
            return 0;
        }
    }
    if (!Array.isArray(parsed)) return 0;

    let changes = 0;
    for (const rule of parsed) {
        if (!rule || !rule.name) continue;
        const name = lowercase ? String(rule.name).toLowerCase() : String(rule.name);
        if (rule.action === 'remove') {
            if (Object.prototype.hasOwnProperty.call(target, name)) {
                delete target[name];
                changes++;
            }
        } else if (rule.action === 'set') {
            target[name] = rule.value == null ? '' : String(rule.value);
            changes++;
        }
    }
    return changes;
}

/**
 * Documentación de la API disponible, para el modal de ayuda del panel.
 *
 * Solo devuelve la firma de cada llamada y la clave de traducción: el panel
 * está en tres idiomas y una tabla escrita aquí saldría siempre en el mismo.
 */
function getApiReference() {
    return {
        request: [
            { call: 'ms.request.method', key: 'apiReqMethod' },
            { call: 'ms.request.path', key: 'apiReqPath' },
            { call: 'ms.request.headers.get(k) / .has(k)', key: 'apiReqHeaderGet' },
            { call: 'ms.request.headers.add({key, value})', key: 'apiReqHeaderAdd' },
            { call: 'ms.request.headers.remove(k)', key: 'apiReqHeaderRemove' },
            { call: 'ms.request.headers.all() / .toObject()', key: 'apiReqHeaderAll' },
            { call: 'ms.request.url.query.add({key, value})', key: 'apiReqQueryAdd' },
            { call: 'ms.request.url.query.remove(k)', key: 'apiReqQueryRemove' },
            { call: 'ms.request.body.json()', key: 'apiReqBodyJson' },
            { call: 'ms.request.body.text()', key: 'apiReqBodyText' },
            { call: 'ms.request.body.set(v)', key: 'apiReqBodySet' },
            { call: 'ms.respond(code, body, headers)', key: 'apiRespond' }
        ],
        response: [
            { call: 'ms.response.code', key: 'apiResCode' },
            { call: 'ms.response.json()', key: 'apiResJson' },
            { call: 'ms.response.text()', key: 'apiResText' },
            { call: 'ms.response.setBody(v)', key: 'apiResSetBody' },
            { call: 'ms.response.headers.add({key, value})', key: 'apiResHeaderAdd' },
            { call: 'ms.response.headers.remove(k)', key: 'apiResHeaderRemove' },
            { call: 'ms.request.*', key: 'apiResRequest' }
        ],
        shared: [
            { call: 'ms.variables.set(k, v) / .get(k)', key: 'apiVariables' },
            { call: 'console.log(...)', key: 'apiConsole' },
            { call: 'atob() / btoa()', key: 'apiBase64' }
        ]
    };
}

module.exports = {
    validateScript,
    runRequestScript,
    runResponseScript,
    applyKeyValueRules,
    getApiReference,
    SCRIPT_TIMEOUT_MS,
    MAX_SCRIPT_LENGTH
};
