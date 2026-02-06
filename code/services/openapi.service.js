const SwaggerParser = require('@apidevtools/swagger-parser');
const jsf = require('json-schema-faker');
const yaml = require('js-yaml');

// Configurar json-schema-faker
jsf.option({
    alwaysFakeOptionals: false,
    useExamplesValue: true,
    useDefaultValue: true,
    fillProperties: false,
    minItems: 1,
    maxItems: 1
});

/**
 * Parsea una especificación OpenAPI/Swagger desde texto
 */
async function parseSpec(content, format) {
    let specObject;

    if (format === 'yaml' || (format === 'auto' && !content.trim().startsWith('{'))) {
        specObject = yaml.load(content);
    } else {
        specObject = JSON.parse(content);
    }

    // Validar y dereferenciar (resuelve todos los $ref)
    const api = await SwaggerParser.dereference(specObject);
    return api;
}

/**
 * Convierte path params de OpenAPI ({id}) a regex
 */
function convertPathToRegex(path) {
    if (!path.includes('{')) {
        return { path, isRegex: false };
    }
    const regexPath = '^' + path.replace(/\{[^}]+\}/g, '[^/]+') + '$';
    return { path: regexPath, isRegex: true };
}

/**
 * Extrae la mejor respuesta de una operación y genera mock data
 */
function extractBestResponse(operation, isSwagger2) {
    const responses = operation.responses || {};

    // Prioridad: 200 > 201 > 202 > primer 2xx
    const priorityOrder = ['200', '201', '202'];
    let targetCode = null;
    let targetResponse = null;

    for (const code of priorityOrder) {
        if (responses[code]) {
            targetCode = code;
            targetResponse = responses[code];
            break;
        }
    }

    // Si no hay match, buscar primer 2xx
    if (!targetCode) {
        for (const [code, resp] of Object.entries(responses)) {
            if (code.startsWith('2')) {
                targetCode = code;
                targetResponse = resp;
                break;
            }
        }
    }

    // Fallback
    if (!targetCode) {
        return { statusCode: 200, responseBody: '{}' };
    }

    // 204 No Content
    if (targetCode === '204') {
        return { statusCode: 204, responseBody: '' };
    }

    // Extraer schema y examples
    let schema = null;
    let example = null;

    if (isSwagger2) {
        schema = targetResponse.schema;
        example = targetResponse.examples && targetResponse.examples['application/json'];
    } else {
        const content = targetResponse.content;
        if (content) {
            const jsonContent = content['application/json']
                || content['*/*']
                || Object.values(content)[0];
            if (jsonContent) {
                schema = jsonContent.schema;
                example = jsonContent.example
                    || (jsonContent.examples && Object.values(jsonContent.examples)[0]?.value);
            }
        }
    }

    // Generar mock
    let responseBody = '{}';

    if (example) {
        responseBody = JSON.stringify(example, null, 2);
    } else if (schema) {
        try {
            const mockData = jsf.generate(schema);
            responseBody = JSON.stringify(mockData, null, 2);
        } catch (e) {
            console.error(`[OPENAPI] Error generando mock desde schema: ${e.message}`);
            responseBody = '{}';
        }
    }

    return { statusCode: parseInt(targetCode), responseBody };
}

/**
 * Genera array de rutas desde una spec parseada
 */
function generateRoutes(spec, basePath) {
    const routes = [];
    const isSwagger2 = !!(spec.swagger && spec.swagger.startsWith('2'));

    // Normalizar base path
    let prefix = basePath || '';
    if (prefix && !prefix.startsWith('/')) prefix = '/' + prefix;
    if (prefix.endsWith('/')) prefix = prefix.slice(0, -1);

    // Base path de la spec
    let specBasePath = '';
    if (isSwagger2) {
        specBasePath = spec.basePath || '';
    } else if (spec.servers && spec.servers.length > 0) {
        try {
            const serverUrl = new URL(spec.servers[0].url);
            specBasePath = serverUrl.pathname;
        } catch (e) {
            specBasePath = spec.servers[0].url || '';
        }
    }
    if (specBasePath === '/') specBasePath = '';

    const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];

    for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
        for (const method of httpMethods) {
            const operation = pathItem[method];
            if (!operation) continue;

            const fullPath = prefix + specBasePath + pathKey;
            const { path: finalPath, isRegex } = convertPathToRegex(fullPath);
            const { statusCode, responseBody } = extractBestResponse(operation, isSwagger2);

            // Extract tags from operation (OpenAPI tags)
            const operationTags = operation.tags || [];

            routes.push({
                tipo: method,
                ruta: finalPath,
                codigo: String(statusCode),
                tiporespuesta: statusCode === 204 ? 'empty' : 'json',
                respuesta: responseBody,
                isRegex: isRegex ? 1 : 0,
                activo: 1,
                esperaActiva: 0,
                operationId: operation.operationId || null,
                summary: operation.summary || null,
                description: operation.description || null,
                openApiTags: operationTags, // Tags from OpenAPI spec
                _conflict: false,
                _existingId: null
            });
        }
    }

    return routes;
}

/**
 * Extrae info general de la spec
 */
function getSpecInfo(spec) {
    const isSwagger2 = !!(spec.swagger && spec.swagger.startsWith('2'));
    return {
        title: spec.info?.title || 'Unknown',
        version: spec.info?.version || 'Unknown',
        format: isSwagger2 ? `swagger-${spec.swagger}` : `openapi-${spec.openapi}`,
        pathCount: Object.keys(spec.paths || {}).length
    };
}

module.exports = {
    parseSpec,
    generateRoutes,
    getSpecInfo
};
