const vm = require('vm');

// Funciones helper permitidas (whitelist)
const ALLOWED_HELPERS = {
    // Comparaciones de strings/arrays
    includes: (arr, val) => {
        if (arr == null) return false;
        return Array.isArray(arr) ? arr.includes(val) : String(arr).includes(val);
    },
    startsWith: (str, prefix) => str != null && String(str).startsWith(prefix),
    endsWith: (str, suffix) => str != null && String(str).endsWith(suffix),
    match: (str, regex) => {
        if (str == null) return false;
        try {
            return new RegExp(regex).test(String(str));
        } catch (e) {
            return false;
        }
    },

    // Comparaciones
    equals: (a, b) => a === b,
    notEquals: (a, b) => a !== b,
    gt: (a, b) => a > b,
    gte: (a, b) => a >= b,
    lt: (a, b) => a < b,
    lte: (a, b) => a <= b,

    // Verificaciones
    isEmpty: (val) => {
        if (val == null) return true;
        if (typeof val === 'string') return val.trim() === '';
        if (Array.isArray(val)) return val.length === 0;
        if (typeof val === 'object') return Object.keys(val).length === 0;
        return false;
    },
    isNotEmpty: (val) => {
        if (val == null) return false;
        if (typeof val === 'string') return val.trim() !== '';
        if (Array.isArray(val)) return val.length > 0;
        if (typeof val === 'object') return Object.keys(val).length > 0;
        return true;
    },
    hasKey: (obj, key) => obj != null && typeof obj === 'object' && key in obj,

    // Tipos
    isNumber: (val) => typeof val === 'number' && !isNaN(val),
    isString: (val) => typeof val === 'string',
    isArray: (val) => Array.isArray(val),
    isObject: (val) => val != null && typeof val === 'object' && !Array.isArray(val),
    isNull: (val) => val == null,

    // Conversiones seguras
    toNumber: (val) => {
        const n = Number(val);
        return isNaN(n) ? 0 : n;
    },
    toString: (val) => val == null ? '' : String(val),
    toLowerCase: (val) => val == null ? '' : String(val).toLowerCase(),
    toUpperCase: (val) => val == null ? '' : String(val).toUpperCase(),

    // Lógica
    and: (...args) => args.every(Boolean),
    or: (...args) => args.some(Boolean),
    not: (val) => !val,

    // Arrays
    length: (val) => {
        if (val == null) return 0;
        if (Array.isArray(val) || typeof val === 'string') return val.length;
        if (typeof val === 'object') return Object.keys(val).length;
        return 0;
    },
    first: (arr) => Array.isArray(arr) && arr.length > 0 ? arr[0] : null,
    last: (arr) => Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : null,
};

// Patrones peligrosos que no se permiten
const DANGEROUS_PATTERNS = [
    /require\s*\(/i,
    /import\s+/i,
    /import\s*\(/i,
    /eval\s*\(/i,
    /Function\s*\(/i,
    /setTimeout\s*\(/i,
    /setInterval\s*\(/i,
    /setImmediate\s*\(/i,
    /process\./i,
    /global\./i,
    /globalThis\./i,
    /this\./,
    /constructor/i,
    /__proto__/i,
    /prototype/i,
    /Reflect\./i,
    /Proxy/i,
    /\bfs\b/i,
    /\bchild_process\b/i,
    /\bexec\b/i,
    /\bspawn\b/i,
];

// Máxima longitud permitida para una expresión
const MAX_EXPRESSION_LENGTH = 2000;

/**
 * Valida una expresión de criterio sin ejecutarla
 */
function validateCriteria(expression) {
    if (!expression || typeof expression !== 'string') {
        return { valid: false, error: 'La expresión es requerida' };
    }

    const trimmed = expression.trim();

    if (trimmed.length === 0) {
        return { valid: false, error: 'La expresión está vacía' };
    }

    if (trimmed.length > MAX_EXPRESSION_LENGTH) {
        return { valid: false, error: `La expresión excede el límite de ${MAX_EXPRESSION_LENGTH} caracteres` };
    }

    // Verificar patrones peligrosos
    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { valid: false, error: 'La expresión contiene patrones no permitidos' };
        }
    }

    // Verificar sintaxis básica
    try {
        new Function('return ' + trimmed);
    } catch (e) {
        return { valid: false, error: `Error de sintaxis: ${e.message}` };
    }

    return { valid: true };
}

/**
 * Evalúa una expresión de criterio contra un contexto de request
 */
function evaluateCriteria(expression, context) {
    // Primero validar
    const validation = validateCriteria(expression);
    if (!validation.valid) {
        console.error(`[CRITERIA] Expresión inválida: ${validation.error}`);
        return { success: false, result: false, error: validation.error };
    }

    try {
        // Crear sandbox con helpers y contexto
        const sandbox = {
            ...ALLOWED_HELPERS,
            // Contexto de la request (read-only)
            headers: Object.freeze(context.headers || {}),
            body: context.body || {},
            path: context.path || '',
            query: Object.freeze(context.query || {}),
            params: Object.freeze(context.params || {}),
            method: (context.method || '').toLowerCase(),
        };

        // Crear contexto VM aislado
        const vmContext = vm.createContext(sandbox);

        // Ejecutar con timeout estricto (100ms)
        const result = vm.runInContext(expression, vmContext, {
            timeout: 100,
            displayErrors: false
        });

        return { success: true, result: Boolean(result) };
    } catch (error) {
        const errorMsg = error.message || 'Error desconocido';
        console.error(`[CRITERIA] Error evaluando expresión: ${errorMsg}`);
        return { success: false, result: false, error: errorMsg };
    }
}

/**
 * Obtiene la lista de helpers disponibles para mostrar en la UI
 */
function getAvailableHelpers() {
    return Object.keys(ALLOWED_HELPERS);
}

/**
 * Obtiene ejemplos de uso para la documentación
 */
function getExamples() {
    return [
        { expression: "headers['x-api-key'] === 'secret'", description: "Header específico" },
        { expression: "body.userId > 100", description: "Propiedad del body" },
        { expression: "query.debug === 'true'", description: "Query param" },
        { expression: "method === 'post'", description: "Método HTTP" },
        { expression: "hasKey(body, 'email') && isNotEmpty(body.email)", description: "Verificar campo existe y no vacío" },
        { expression: "match(path, '/users/\\\\d+')", description: "Path con regex" },
        { expression: "includes(headers['content-type'], 'json')", description: "Header contiene valor" },
        { expression: "body.items && length(body.items) > 0", description: "Array no vacío" },
    ];
}

module.exports = {
    evaluateCriteria,
    validateCriteria,
    getAvailableHelpers,
    getExamples,
    ALLOWED_HELPERS
};
