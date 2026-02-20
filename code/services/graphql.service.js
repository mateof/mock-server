const { parse } = require('graphql');

// ===== QUERY PARSING =====

/**
 * Parsea una query GraphQL string a sus componentes
 * @param {string} queryString - La query GraphQL
 * @returns {{ operationType: string, operationName: string|null, selectionSet: object, document: object }}
 */
function parseGraphQLQuery(queryString) {
    const document = parse(queryString);
    const definition = document.definitions[0];

    if (!definition || definition.kind !== 'OperationDefinition') {
        throw new Error('No valid operation definition found');
    }

    return {
        operationType: definition.operation, // 'query' | 'mutation'
        operationName: definition.name ? definition.name.value : null,
        selectionSet: definition.selectionSet,
        document
    };
}

// ===== OPERATION MATCHING =====

/**
 * Busca la operación que matchea con la query entrante
 * @param {string} operationType - 'query' o 'mutation'
 * @param {string|null} operationName - Nombre de la operación (puede ser null)
 * @param {Array} operations - Operaciones almacenadas en BD
 * @returns {object|null} - La operación que matchea o null
 */
function matchOperation(operationType, operationName, operations) {
    const activeOps = operations.filter(op => op.activo !== 0 && op.activo !== false);

    // 1. Match exacto por tipo + nombre de operación
    if (operationName) {
        const match = activeOps.find(op =>
            op.operationType === operationType &&
            op.operationName === operationName
        );
        if (match) return match;
    }

    return null;
}

/**
 * Busca operación por nombre del campo raíz (para queries sin nombre)
 * @param {string} operationType
 * @param {string} rootFieldName
 * @param {Array} operations
 * @returns {object|null}
 */
function matchOperationByRootField(operationType, rootFieldName, operations) {
    const activeOps = operations.filter(op => op.activo !== 0 && op.activo !== false);
    return activeOps.find(op =>
        op.operationType === operationType &&
        op.operationName === rootFieldName
    ) || null;
}

// ===== SELECTION SET FILTERING =====

/**
 * Filtra un objeto JSON para devolver solo los campos solicitados en el selection set
 * @param {*} data - Los datos a filtrar
 * @param {object} selectionSet - El AST del selection set
 * @returns {*} - Los datos filtrados
 */
function filterResponseBySelectionSet(data, selectionSet) {
    if (!selectionSet || !selectionSet.selections) return data;
    if (data === null || data === undefined) return data;

    // Arrays: filtrar cada elemento
    if (Array.isArray(data)) {
        return data.map(item => filterResponseBySelectionSet(item, selectionSet));
    }

    // Primitivos: devolver tal cual
    if (typeof data !== 'object') return data;

    const result = {};
    for (const selection of selectionSet.selections) {
        if (selection.kind === 'Field') {
            const fieldName = selection.name.value;

            // Ignorar campos de introspección en filtrado normal
            if (fieldName.startsWith('__')) continue;

            const alias = selection.alias ? selection.alias.value : fieldName;

            if (fieldName in data) {
                if (selection.selectionSet) {
                    result[alias] = filterResponseBySelectionSet(data[fieldName], selection.selectionSet);
                } else {
                    result[alias] = data[fieldName];
                }
            }
        }
        // InlineFragment: expandir sus selections
        if (selection.kind === 'InlineFragment' && selection.selectionSet) {
            const inlineResult = filterResponseBySelectionSet(data, selection.selectionSet);
            Object.assign(result, inlineResult);
        }
    }
    return result;
}

// ===== INTROSPECTION =====

/**
 * Genera una respuesta de introspección básica basada en las operaciones almacenadas
 * @param {Array} operations - Operaciones almacenadas
 * @param {object} parsed - Query parseada
 * @returns {{ data: object }}
 */
function buildIntrospectionResponse(operations, parsed, storedSchema = null) {
    // Si hay schema almacenado (de import), devolverlo completo
    // GraphiQL envía queries con fragments que filterIntrospectionResponse no maneja,
    // así que retornamos el schema completo tal cual fue importado
    if (storedSchema) {
        try {
            const fullSchema = typeof storedSchema === 'string' ? JSON.parse(storedSchema) : storedSchema;
            if (fullSchema.data && fullSchema.data.__schema) {
                return { data: fullSchema.data };
            }
        } catch (e) {
            console.error('[GraphQL] Error parsing stored schema, falling back to generated:', e.message);
        }
    }

    const activeOps = operations.filter(op => op.activo !== 0 && op.activo !== false);
    const queries = activeOps.filter(op => op.operationType === 'query');
    const mutations = activeOps.filter(op => op.operationType === 'mutation');

    const schema = {
        __schema: {
            queryType: queries.length > 0 ? { name: 'Query' } : null,
            mutationType: mutations.length > 0 ? { name: 'Mutation' } : null,
            subscriptionType: null,
            types: [
                {
                    kind: 'OBJECT',
                    name: 'Query',
                    fields: queries.map(q => ({
                        name: q.operationName,
                        args: [],
                        type: { kind: 'SCALAR', name: 'JSON', ofType: null }
                    }))
                },
                {
                    kind: 'OBJECT',
                    name: 'Mutation',
                    fields: mutations.map(m => ({
                        name: m.operationName,
                        args: [],
                        type: { kind: 'SCALAR', name: 'JSON', ofType: null }
                    }))
                }
            ],
            directives: []
        },
        __type: null
    };

    // Si piden __type con argumento name, buscar el tipo específico
    const firstSelection = parsed.selectionSet?.selections?.[0];
    if (firstSelection?.name?.value === '__type') {
        const nameArg = firstSelection.arguments?.find(arg => arg.name.value === 'name');
        const typeName = nameArg?.value?.value;

        if (typeName === 'Query') {
            schema.__type = schema.__schema.types[0];
        } else if (typeName === 'Mutation') {
            schema.__type = schema.__schema.types[1];
        } else {
            schema.__type = { kind: 'SCALAR', name: typeName, fields: null };
        }
    }

    // Filtrar la respuesta según lo que pidan
    const filtered = filterIntrospectionResponse(schema, parsed.selectionSet);
    return { data: filtered };
}

/**
 * Filtra la respuesta de introspección por selection set
 */
function filterIntrospectionResponse(data, selectionSet) {
    if (!selectionSet || !selectionSet.selections) return data;
    if (data === null || data === undefined) return data;
    if (Array.isArray(data)) {
        return data.map(item => filterIntrospectionResponse(item, selectionSet));
    }
    if (typeof data !== 'object') return data;

    const result = {};
    for (const selection of selectionSet.selections) {
        if (selection.kind === 'Field') {
            const fieldName = selection.name.value;
            const alias = selection.alias ? selection.alias.value : fieldName;

            if (fieldName in data) {
                if (selection.selectionSet) {
                    result[alias] = filterIntrospectionResponse(data[fieldName], selection.selectionSet);
                } else {
                    result[alias] = data[fieldName];
                }
            }
        }
    }
    return result;
}

// ===== PROXY FORWARDING =====

/**
 * Reenvía una query GraphQL a un endpoint remoto
 * @param {string} proxyUrl - URL del endpoint GraphQL remoto
 * @param {object} requestBody - { query, variables, operationName }
 * @returns {Promise<object>} - Respuesta del servidor remoto
 */
function forwardGraphQLQuery(proxyUrl, requestBody) {
    const urlObj = new URL(proxyUrl);
    const fetchModule = urlObj.protocol === 'https:' ? require('https') : require('http');

    const postData = JSON.stringify(requestBody);

    const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    return new Promise((resolve, reject) => {
        const req = fetchModule.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                forwardGraphQLQuery(res.headers.location, requestBody).then(resolve).catch(reject);
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Invalid JSON response from proxy: ${e.message}`));
                }
            });
        });
        req.on('error', (e) => reject(new Error(`Proxy connection error: ${e.message}`)));
        req.setTimeout(30000, () => {
            req.destroy(new Error('Proxy timeout'));
        });
        req.write(postData);
        req.end();
    });
}

// ===== MAIN HANDLER =====

/**
 * Procesa una petición GraphQL completa (soporta proxy híbrido por operación)
 * @param {object} requestBody - { query, variables, operationName }
 * @param {Array} operations - Operaciones almacenadas en BD
 * @param {string|null} storedSchema - Schema de introspección almacenado
 * @param {string|null} proxyUrl - URL del endpoint GraphQL remoto para operaciones proxy
 * @returns {Promise<{ data: object } | { errors: Array, data: null }>}
 */
async function handleGraphQLRequest(requestBody, operations, storedSchema = null, proxyUrl = null) {
    const { query, operationName: reqOperationName } = requestBody || {};

    // Validar que hay query
    if (!query || typeof query !== 'string' || !query.trim()) {
        return {
            errors: [{ message: 'Must provide query string.' }],
            data: null
        };
    }

    // Parsear la query
    let parsed;
    try {
        parsed = parseGraphQLQuery(query);
    } catch (e) {
        return {
            errors: [{ message: `Syntax Error: ${e.message}` }],
            data: null
        };
    }

    // Detectar introspección
    const firstField = parsed.selectionSet?.selections?.[0]?.name?.value;
    if (firstField === '__schema' || firstField === '__type') {
        return buildIntrospectionResponse(operations, parsed, storedSchema);
    }

    // Determinar nombre de operación
    const effectiveOpName = reqOperationName || parsed.operationName;

    // 1. Buscar operación por nombre exacto
    const matched = matchOperation(parsed.operationType, effectiveOpName, operations);

    if (matched) {
        // Match exacto por nombre — si es proxy, reenviar al servidor remoto
        if (matched.useProxy && proxyUrl) {
            try {
                return await forwardGraphQLQuery(proxyUrl, requestBody);
            } catch (e) {
                return {
                    errors: [{ message: `Proxy error: ${e.message}` }],
                    data: null
                };
            }
        }

        // Comportamiento mock normal
        let responseData;
        try {
            responseData = JSON.parse(matched.respuesta || '{}');
        } catch (e) {
            return {
                errors: [{ message: `Invalid JSON in mock response for "${matched.operationName}"` }],
                data: null
            };
        }
        const filtered = filterResponseBySelectionSet(responseData, parsed.selectionSet);
        return { data: filtered };
    }

    // 2. Multi-root-field: iterar sobre cada campo raíz y combinar respuestas
    const rootSelections = parsed.selectionSet?.selections || [];
    const combinedData = {};
    const errors = [];
    const proxyFields = []; // Campos que deben reenviarse al proxy

    for (const selection of rootSelections) {
        if (selection.kind !== 'Field') continue;

        const fieldName = selection.name.value;
        const alias = selection.alias ? selection.alias.value : fieldName;

        // Ignorar campos de introspección inline
        if (fieldName.startsWith('__')) continue;

        const fieldMatch = matchOperationByRootField(parsed.operationType, fieldName, operations);

        if (fieldMatch) {
            if (fieldMatch.useProxy && proxyUrl) {
                // Acumular para reenviar al proxy
                proxyFields.push({ alias, fieldName });
            } else {
                // Mock normal
                try {
                    const fieldData = JSON.parse(fieldMatch.respuesta || '{}');
                    if (fieldName in fieldData) {
                        if (selection.selectionSet) {
                            combinedData[alias] = filterResponseBySelectionSet(fieldData[fieldName], selection.selectionSet);
                        } else {
                            combinedData[alias] = fieldData[fieldName];
                        }
                    } else {
                        if (selection.selectionSet) {
                            combinedData[alias] = filterResponseBySelectionSet(fieldData, selection.selectionSet);
                        } else {
                            combinedData[alias] = fieldData;
                        }
                    }
                } catch (e) {
                    errors.push({ message: `Invalid JSON in mock response for "${fieldMatch.operationName}"` });
                }
            }
        } else {
            errors.push({ message: `No mock found for ${parsed.operationType} "${fieldName}"` });
        }
    }

    // Si hay campos proxy, reenviar la query completa y extraer solo los campos proxy
    if (proxyFields.length > 0 && proxyUrl) {
        try {
            const proxyResponse = await forwardGraphQLQuery(proxyUrl, requestBody);
            if (proxyResponse.data) {
                for (const pf of proxyFields) {
                    if (pf.alias in proxyResponse.data) {
                        combinedData[pf.alias] = proxyResponse.data[pf.alias];
                    } else if (pf.fieldName in proxyResponse.data) {
                        combinedData[pf.alias] = proxyResponse.data[pf.fieldName];
                    }
                }
            }
            if (proxyResponse.errors) {
                errors.push(...proxyResponse.errors);
            }
        } catch (e) {
            for (const pf of proxyFields) {
                errors.push({ message: `Proxy error for "${pf.fieldName}": ${e.message}` });
            }
        }
    }

    if (Object.keys(combinedData).length === 0) {
        return {
            errors: errors.length > 0 ? errors : [{ message: `No mock found for ${parsed.operationType}` }],
            data: null
        };
    }

    const result = { data: combinedData };
    if (errors.length > 0) {
        result.errors = errors;
    }
    return result;
}

// ===== ERROR FORMATTER =====

function formatGraphQLError(message) {
    return {
        errors: [{ message }],
        data: null
    };
}

// ===== INTROSPECTION QUERY =====

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      subscriptionType { name }
      types {
        ...FullType
      }
      directives {
        name
        description
        locations
        args {
          ...InputValue
        }
      }
    }
  }

  fragment FullType on __Type {
    kind
    name
    description
    fields(includeDeprecated: true) {
      name
      description
      args {
        ...InputValue
      }
      type {
        ...TypeRef
      }
      isDeprecated
      deprecationReason
    }
    inputFields {
      ...InputValue
    }
    interfaces {
      ...TypeRef
    }
    enumValues(includeDeprecated: true) {
      name
      description
      isDeprecated
      deprecationReason
    }
    possibleTypes {
      ...TypeRef
    }
  }

  fragment InputValue on __InputValue {
    name
    description
    type {
      ...TypeRef
    }
    defaultValue
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ===== SCHEMA IMPORT =====

/**
 * Obtiene el schema de introspección desde un endpoint GraphQL remoto
 * @param {string} url - URL del endpoint GraphQL
 * @returns {Promise<object>} - Resultado de introspección { data: { __schema: ... } }
 */
function fetchIntrospectionFromUrl(url) {
    const urlObj = new URL(url);
    const fetchModule = urlObj.protocol === 'https:' ? require('https') : require('http');

    const postData = JSON.stringify({ query: INTROSPECTION_QUERY });

    const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    return new Promise((resolve, reject) => {
        const req = fetchModule.request(options, (res) => {
            // Seguir redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchIntrospectionFromUrl(res.headers.location).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} from GraphQL endpoint`));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.errors && !parsed.data) {
                        reject(new Error(`GraphQL errors: ${JSON.stringify(parsed.errors)}`));
                        return;
                    }
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`Invalid JSON response from endpoint: ${e.message}`));
                }
            });
        });
        req.on('error', (e) => reject(new Error(`Connection error: ${e.message}`)));
        req.setTimeout(15000, () => {
            req.destroy(new Error('Timeout fetching introspection from endpoint'));
        });
        req.write(postData);
        req.end();
    });
}

// ===== MOCK GENERATION =====

/**
 * Genera operaciones mock desde un resultado de introspección
 * @param {object} introspectionResult - Resultado completo { data: { __schema: ... } }
 * @returns {{ operations: Array<{operationType, operationName, respuesta, activo}> }}
 */
function generateMockFromIntrospection(introspectionResult) {
    const schema = introspectionResult.data?.__schema;
    if (!schema) throw new Error('Invalid introspection result: no __schema found');

    // Mapa de tipos para lookup rápido
    const typeMap = {};
    (schema.types || []).forEach(type => {
        typeMap[type.name] = type;
    });

    const MAX_DEPTH = 5;

    // Resuelve un TypeRef anidado (NON_NULL, LIST wrappers)
    function resolveTypeRef(typeRef) {
        if (!typeRef) return { kind: 'SCALAR', name: 'String', isList: false };
        if (typeRef.kind === 'NON_NULL') {
            return resolveTypeRef(typeRef.ofType);
        }
        if (typeRef.kind === 'LIST') {
            const inner = resolveTypeRef(typeRef.ofType);
            return { ...inner, isList: true };
        }
        return { kind: typeRef.kind, name: typeRef.name, isList: false };
    }

    // Genera valor mock para un tipo resuelto
    function generateMockValue(resolved, depth, visiting) {
        if (depth > MAX_DEPTH) return null;

        const { kind, name, isList } = resolved;
        let value;

        if (kind === 'SCALAR') {
            switch (name) {
                case 'String': value = 'mock_string'; break;
                case 'Int': value = 42; break;
                case 'Float': value = 3.14; break;
                case 'Boolean': value = true; break;
                case 'ID': value = 'mock-id-1'; break;
                default: value = 'mock_value';
            }
        } else if (kind === 'ENUM') {
            const enumType = typeMap[name];
            value = enumType?.enumValues?.[0]?.name || 'UNKNOWN';
        } else if (kind === 'OBJECT' || kind === 'INTERFACE') {
            if (visiting.has(name)) {
                value = null;
            } else {
                const objectType = typeMap[name];
                if (!objectType || !objectType.fields) {
                    value = {};
                } else {
                    const newVisiting = new Set(visiting);
                    newVisiting.add(name);
                    value = {};
                    for (const field of objectType.fields) {
                        if (field.name.startsWith('__')) continue;
                        const fieldResolved = resolveTypeRef(field.type);
                        value[field.name] = generateMockValue(fieldResolved, depth + 1, newVisiting);
                    }
                }
            }
        } else if (kind === 'UNION') {
            const unionType = typeMap[name];
            if (unionType?.possibleTypes?.[0]) {
                const firstType = unionType.possibleTypes[0];
                value = generateMockValue({ kind: 'OBJECT', name: firstType.name, isList: false }, depth, visiting);
            } else {
                value = {};
            }
        } else {
            value = null;
        }

        if (isList && value !== undefined) {
            return [value];
        }
        return value;
    }

    const operations = [];

    // Procesar campos del tipo Query
    const queryTypeName = schema.queryType?.name;
    if (queryTypeName) {
        const queryType = typeMap[queryTypeName];
        if (queryType && queryType.fields) {
            for (const field of queryType.fields) {
                if (field.name.startsWith('__')) continue;
                const resolvedReturn = resolveTypeRef(field.type);
                const mockValue = generateMockValue(resolvedReturn, 0, new Set());
                operations.push({
                    operationType: 'query',
                    operationName: field.name,
                    respuesta: JSON.stringify({ [field.name]: mockValue }, null, 2),
                    activo: 1
                });
            }
        }
    }

    // Procesar campos del tipo Mutation
    const mutationTypeName = schema.mutationType?.name;
    if (mutationTypeName) {
        const mutationType = typeMap[mutationTypeName];
        if (mutationType && mutationType.fields) {
            for (const field of mutationType.fields) {
                if (field.name.startsWith('__')) continue;
                const resolvedReturn = resolveTypeRef(field.type);
                const mockValue = generateMockValue(resolvedReturn, 0, new Set());
                operations.push({
                    operationType: 'mutation',
                    operationName: field.name,
                    respuesta: JSON.stringify({ [field.name]: mockValue }, null, 2),
                    activo: 1
                });
            }
        }
    }

    return { operations };
}

module.exports = {
    parseGraphQLQuery,
    matchOperation,
    matchOperationByRootField,
    filterResponseBySelectionSet,
    buildIntrospectionResponse,
    handleGraphQLRequest,
    formatGraphQLError,
    forwardGraphQLQuery,
    fetchIntrospectionFromUrl,
    generateMockFromIntrospection,
    INTROSPECTION_QUERY
};
