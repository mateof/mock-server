const sqliteService = require('../services/sqlite.service');
const criteriaService = require('../services/criteria-evaluator.service');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { log } = require('../services/socket.service');

// Parsea el body de respuesta según el content-type
function parseResponseBody(buffer, contentType) {
    if (!buffer || buffer.length === 0) {
        return null;
    }

    try {
        const bodyStr = buffer.toString('utf8');

        // Limitar tamaño del body para el log (max 10KB)
        const maxSize = 10 * 1024;
        const truncated = bodyStr.length > maxSize;
        const limitedBody = truncated ? bodyStr.substring(0, maxSize) : bodyStr;

        // Si es JSON, intentar parsearlo
        if (contentType && contentType.includes('application/json')) {
            try {
                const parsed = JSON.parse(limitedBody);
                return { type: 'json', data: parsed, truncated };
            } catch (e) {
                return { type: 'text', data: limitedBody, truncated };
            }
        }

        // Si es XML/HTML
        if (contentType && (contentType.includes('xml') || contentType.includes('html'))) {
            return { type: 'xml', data: limitedBody, truncated };
        }

        // Texto plano u otro
        return { type: 'text', data: limitedBody, truncated };
    } catch (e) {
        return { type: 'error', data: `Error parsing body: ${e.message}` };
    }
}

// Almacena las configuraciones de proxy
let proxyConfigs = [];

async function loadProxyConfigs() {
    console.log('[PROXY] Cargando configuraciones de proxy desde BD...');
    const proxys = await sqliteService.getProxys();

    // Process each proxy config and load fallback conditions
    proxyConfigs = await Promise.all(proxys.map(async p => {
        let customHeaders = null;
        if (p.customHeaders) {
            try {
                customHeaders = JSON.parse(p.customHeaders);
            } catch (e) {
                console.error(`[PROXY] Error parseando customHeaders para ${p.ruta}: ${e.message}`);
            }
        }

        // Load conditions for each active fallback
        const activeFallbacks = (p.fallbacks || []).filter(f => f.activo === 1);
        const fallbacksWithConditions = await Promise.all(activeFallbacks.map(async f => {
            try {
                const conditions = await sqliteService.getFallbackConditions(f.id);
                return { ...f, conditions: conditions || [] };
            } catch (e) {
                console.error(`[PROXY] Error cargando condiciones para fallback ${f.id}: ${e.message}`);
                return { ...f, conditions: [] };
            }
        }));

        return {
            id: p.id,
            ruta: p.ruta,
            target: p.respuesta,
            isRegex: p.isRegex === 1,
            customHeaders,
            timeout: p.proxy_timeout || 30000,
            fallbacks: fallbacksWithConditions
        };
    }));

    console.log(`[PROXY] Configuraciones cargadas: ${proxyConfigs.length}`);
    proxyConfigs.forEach((config, i) => {
        const totalConditions = config.fallbacks.reduce((sum, f) => sum + (f.conditions?.length || 0), 0);
        console.log(`[PROXY]   ${i + 1}. ${config.ruta} -> ${config.target} (regex: ${config.isRegex}, timeout: ${config.timeout}ms, fallbacks: ${config.fallbacks.length}, conditions: ${totalConditions})`);
    });
}

// Determina el tipo de error para fallbacks
function getErrorType(err, statusCode) {
    if (err) {
        if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT' || err.message === 'TIMEOUT') {
            return 'timeout';
        }
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'EHOSTUNREACH') {
            return 'connection';
        }
    }
    if (statusCode && statusCode >= 500 && statusCode < 600) {
        return 'http5xx';
    }
    return null;
}

// Busca un fallback que coincida con el path y tipo de error
function findMatchingFallback(config, subPath, errorType) {
    if (!config.fallbacks || config.fallbacks.length === 0) {
        return null;
    }

    console.log(`[PROXY] Buscando fallback para path="${subPath}", errorType="${errorType}"`);

    for (const fallback of config.fallbacks) {
        // Parsear error_types si es string
        let errorTypes = fallback.error_types;
        if (typeof errorTypes === 'string') {
            try {
                errorTypes = JSON.parse(errorTypes);
            } catch (e) {
                errorTypes = [];
            }
        }

        // Verificar si el tipo de error coincide
        if (!errorTypes.includes(errorType) && !errorTypes.includes('all')) {
            continue;
        }

        // Verificar si el path coincide con el patrón regex
        try {
            const regex = new RegExp(fallback.path_pattern);
            if (regex.test(subPath)) {
                console.log(`[PROXY] Fallback encontrado: "${fallback.nombre}" (pattern: ${fallback.path_pattern})`);
                return fallback;
            }
        } catch (e) {
            console.error(`[PROXY] Error en regex de fallback: ${e.message}`);
        }
    }

    console.log(`[PROXY] No se encontró fallback coincidente`);
    return null;
}

// Envía la respuesta de fallback
function sendFallbackResponse(res, fallback, req, requestPath, proxyConfig, errorType, requestStart) {
    // Start with fallback defaults
    let responseCode = parseInt(fallback.codigo) || 200;
    let responseType = fallback.tiporespuesta || 'json';
    let responseBody = fallback.respuesta || '';
    let responseHeadersJson = fallback.customHeaders;
    let matchedCondition = null;

    // Evaluate fallback conditions if any
    if (fallback.conditions && fallback.conditions.length > 0) {
        console.log(`[PROXY] Evaluando ${fallback.conditions.length} condiciones del fallback...`);

        // Build context for evaluation
        const evalContext = {
            headers: req.headers || {},
            body: req.body || {},
            path: req.path || requestPath,
            query: req.query || {},
            params: {},
            method: (req.method || 'GET').toLowerCase(),
            errorType: errorType
        };

        // Evaluate conditions in order (first match wins)
        for (const condition of fallback.conditions) {
            if (!condition.activo) continue;

            const evalResult = criteriaService.evaluateCriteria(condition.criteria, evalContext);
            if (evalResult.success && evalResult.result) {
                console.log(`[PROXY] Condición matched: "${condition.nombre || condition.id}"`);
                matchedCondition = condition;

                // Apply overrides from condition
                if (condition.codigo) {
                    responseCode = parseInt(condition.codigo);
                    console.log(`[PROXY]   → Código: ${responseCode}`);
                }
                if (condition.tiporespuesta) {
                    responseType = condition.tiporespuesta;
                    console.log(`[PROXY]   → Tipo: ${responseType}`);
                }
                if (condition.respuesta !== null && condition.respuesta !== undefined && condition.respuesta !== '') {
                    responseBody = condition.respuesta;
                    console.log(`[PROXY]   → Respuesta personalizada`);
                }
                if (condition.customHeaders) {
                    responseHeadersJson = condition.customHeaders;
                    console.log(`[PROXY]   → Headers personalizados`);
                }
                break; // First matching condition wins
            }
        }
    }

    // Parse custom headers
    let customHeaders = {};
    if (responseHeadersJson) {
        try {
            let headers = responseHeadersJson;
            if (typeof headers === 'string') {
                headers = JSON.parse(headers);
            }
            if (Array.isArray(headers)) {
                headers.forEach(h => {
                    if (h.action === 'set' && h.name) {
                        customHeaders[h.name.toLowerCase()] = h.value || '';
                    }
                });
            }
        } catch (e) {
            console.error(`[PROXY] Error parseando customHeaders de fallback: ${e.message}`);
        }
    }

    // Determine content-type
    const contentTypes = {
        'json': 'application/json; charset=utf-8',
        'xml': 'application/xml; charset=utf-8',
        'text': 'text/plain; charset=utf-8',
        'html': 'text/html; charset=utf-8'
    };
    const contentType = contentTypes[responseType] || 'text/plain; charset=utf-8';

    const responseHeaders = {
        'Content-Type': contentType,
        'X-Mock-Fallback': 'true',
        'X-Mock-Fallback-Name': fallback.nombre || 'unnamed',
        'X-Mock-Error-Type': errorType,
        ...(matchedCondition ? { 'X-Mock-Fallback-Condition': matchedCondition.nombre || matchedCondition.id } : {}),
        ...customHeaders
    };

    res.writeHead(responseCode, responseHeaders);
    res.end(responseBody);

    const duration = Date.now() - requestStart;
    console.log(`[PROXY] Fallback enviado: ${responseCode} en ${duration}ms (${fallback.nombre}${matchedCondition ? ` → ${matchedCondition.nombre}` : ''})`);

    // Log para el panel
    log.proxyDetailed({
        method: req.method,
        url: requestPath,
        target: proxyConfig.target,
        targetFull: `FALLBACK: ${fallback.nombre || 'unnamed'}${matchedCondition ? ` (${matchedCondition.nombre})` : ''}`,
        statusCode: responseCode,
        duration,
        requestHeaders: {},
        requestBody: null,
        responseHeaders,
        responseBody: { type: 'fallback', data: responseBody, errorType, condition: matchedCondition?.nombre }
    });
}

// Aplica headers personalizados a la respuesta del proxy
function applyCustomHeadersToResponse(responseHeaders, customHeaders) {
    if (!customHeaders || !Array.isArray(customHeaders)) {
        console.log('[PROXY] No hay headers personalizados para aplicar');
        return responseHeaders;
    }

    console.log('[PROXY] Aplicando headers personalizados a respuesta...');
    const modifiedHeaders = { ...responseHeaders };

    customHeaders.forEach(h => {
        const headerName = h.name.toLowerCase();
        if (h.action === 'set' && h.name) {
            console.log(`[PROXY]   SET: ${headerName} = ${h.value || ''}`);
            modifiedHeaders[headerName] = h.value || '';
        } else if (h.action === 'remove' && h.name) {
            console.log(`[PROXY]   REMOVE: ${headerName}`);
            delete modifiedHeaders[headerName];
        }
    });

    return modifiedHeaders;
}

function findMatchingProxy(requestUrl) {
    console.log(`[PROXY] Buscando proxy para: ${requestUrl}`);
    for (const config of proxyConfigs) {
        if (config.isRegex) {
            try {
                const regex = new RegExp(config.ruta);
                if (regex.test(requestUrl)) {
                    console.log(`[PROXY] Match encontrado (regex): ${config.ruta} -> ${config.target}`);
                    return config;
                }
            } catch (e) {
                console.error(`[PROXY] Regex inválido: ${config.ruta} - ${e.message}`);
            }
        } else {
            // Match por prefijo
            if (requestUrl.startsWith(config.ruta)) {
                console.log(`[PROXY] Match encontrado (prefijo): ${config.ruta} -> ${config.target}`);
                return config;
            }
        }
    }
    console.log(`[PROXY] No se encontró proxy para: ${requestUrl}`);
    return null;
}

async function configureProxy(app) {
    console.log('[PROXY] ========== Configurando Proxy ==========');
    await loadProxyConfigs();

    if (proxyConfigs.length === 0) {
        console.log('[PROXY] No existen proxys en la base de datos (se cargarán dinámicamente)');
    }

    // Middleware de proxy personalizado (siempre activo, usa proxyConfigs dinámicamente)
    const proxyHandler = async (req, res, next) => {
        // Si no hay configuraciones de proxy, pasar al siguiente middleware
        if (proxyConfigs.length === 0) {
            return next();
        }
        const requestStart = Date.now();
        const requestPath = req.url;

        console.log(`\n[PROXY] ========== Petición entrante ==========`);
        console.log(`[PROXY] ${req.method} ${requestPath}`);

        // Buscar configuración de proxy que coincida
        const proxyConfig = findMatchingProxy(requestPath);

        if (!proxyConfig) {
            console.log(`[PROXY] Sin proxy configurado, pasando al siguiente middleware`);
            return next();
        }

        try {
            const targetUrl = new URL(proxyConfig.target);
            const isHttps = targetUrl.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            console.log(`[PROXY] Target URL: ${proxyConfig.target}`);
            console.log(`[PROXY] Protocolo: ${isHttps ? 'HTTPS' : 'HTTP'}`);

            // Construir la URL de destino
            let targetPath = requestPath;

            if (proxyConfig.isRegex) {
                // Con regex: extraer la parte que viene DESPUÉS del match
                // Ej: ruta=/cola.*, request=/cola/index.html -> capturar /index.html
                try {
                    const regex = new RegExp(proxyConfig.ruta);
                    const match = requestPath.match(regex);
                    if (match) {
                        // Remover la parte que matchea y quedarnos con el resto
                        const matchedPart = match[0];
                        targetPath = requestPath.substring(matchedPart.length);
                        console.log(`[PROXY] Regex match: "${matchedPart}", resto: "${targetPath}"`);
                    }
                } catch (e) {
                    console.error(`[PROXY] Error procesando regex: ${e.message}`);
                }
            } else {
                // Sin regex: remover el prefijo de la ruta configurada
                if (requestPath.startsWith(proxyConfig.ruta)) {
                    targetPath = requestPath.substring(proxyConfig.ruta.length);
                    console.log(`[PROXY] Prefijo removido: ${proxyConfig.ruta}`);
                }
            }

            // Asegurar que empiece con /
            if (!targetPath.startsWith('/')) {
                targetPath = '/' + targetPath;
            }

            // Si el target tiene path (ej: https://api.com/v1), concatenarlo
            if (targetUrl.pathname && targetUrl.pathname !== '/') {
                const basePath = targetUrl.pathname.endsWith('/')
                    ? targetUrl.pathname.slice(0, -1)
                    : targetUrl.pathname;
                targetPath = basePath + targetPath;
                console.log(`[PROXY] Path base del target: ${basePath}`);
            }

            console.log(`[PROXY] Path final: ${targetPath}`);

            // Log prominente de la URL destino completa
            const fullTargetUrl = `${targetUrl.protocol}//${targetUrl.host}${targetPath}`;
            console.log(`[PROXY] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
            console.log(`[PROXY] >>> PROXY: ${req.method} ${requestPath}`);
            console.log(`[PROXY] >>> DESTINO: ${fullTargetUrl}`);
            console.log(`[PROXY] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);

            const options = {
                hostname: targetUrl.hostname,
                port: targetUrl.port || (isHttps ? 443 : 80),
                path: targetPath,
                method: req.method,
                headers: {
                    ...req.headers,
                    host: targetUrl.host,
                    // Aceptar compresión que podemos manejar
                    'accept-encoding': 'gzip, deflate, br'
                },
                // Para HTTPS: no verificar certificados (útil para desarrollo)
                rejectUnauthorized: false
            };

            console.log(`[PROXY] Opciones de conexión:`);
            console.log(`[PROXY]   - Host: ${options.hostname}:${options.port}`);
            console.log(`[PROXY]   - Método: ${options.method}`);
            console.log(`[PROXY]   - Path: ${options.path}`);

            // Eliminar headers problemáticos para proxy
            delete options.headers['content-length'];
            delete options.headers['connection']; // Evitar keep-alive issues

            console.log(`[PROXY] Iniciando petición al servidor destino...`);
            console.log(`[PROXY] Timeout configurado: ${proxyConfig.timeout}ms`);

            // Capturar request body para el log
            let requestBodyForLog = null;
            if (req.body && Object.keys(req.body).length > 0) {
                requestBodyForLog = req.body;
            }

            // Capturar request headers para el log (limpiar headers sensibles)
            const requestHeadersForLog = { ...options.headers };
            delete requestHeadersForLog['authorization'];
            delete requestHeadersForLog['cookie'];

            // Calcular subPath para fallback matching
            const subPath = targetPath;

            // Control de timeout
            let timeoutTriggered = false;
            let timeoutId = null;

            const proxyReq = httpModule.request(options, (proxyRes) => {
                // Limpiar timeout si la respuesta llegó
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }

                console.log(`[PROXY] Respuesta recibida: ${proxyRes.statusCode}`);
                console.log(`[PROXY] Content-Encoding: ${proxyRes.headers['content-encoding'] || 'none'}`);
                console.log(`[PROXY] Headers de respuesta: ${JSON.stringify(proxyRes.headers).substring(0, 300)}...`);

                // Verificar si es HTTP 5xx y buscar fallback
                if (proxyRes.statusCode >= 500 && proxyRes.statusCode < 600) {
                    const errorType = getErrorType(null, proxyRes.statusCode);
                    const fallback = findMatchingFallback(proxyConfig, subPath, errorType);
                    if (fallback) {
                        console.log(`[PROXY] HTTP ${proxyRes.statusCode} - Usando fallback: ${fallback.nombre}`);
                        // Consumir y descartar la respuesta del proxy
                        proxyRes.resume();
                        sendFallbackResponse(res, fallback, req, requestPath, proxyConfig, errorType, requestStart);
                        return;
                    }
                }

                // Copiar headers de respuesta
                let responseHeaders = { ...proxyRes.headers };
                delete responseHeaders['transfer-encoding'];

                // Detectar encoding para descomprimir
                const contentEncoding = proxyRes.headers['content-encoding'];

                // Aplicar headers personalizados (set/remove)
                responseHeaders = applyCustomHeadersToResponse(responseHeaders, proxyConfig.customHeaders);

                // Buffer para capturar el body de la respuesta
                const responseChunks = [];

                // Si está comprimido, descomprimirlo y quitar el header
                if (contentEncoding === 'gzip' || contentEncoding === 'deflate' || contentEncoding === 'br') {
                    console.log(`[PROXY] Descomprimiendo respuesta (${contentEncoding})...`);
                    delete responseHeaders['content-encoding'];
                    delete responseHeaders['content-length']; // El tamaño cambiará

                    let decompressor;
                    if (contentEncoding === 'gzip') {
                        decompressor = zlib.createGunzip();
                    } else if (contentEncoding === 'deflate') {
                        decompressor = zlib.createInflate();
                    } else if (contentEncoding === 'br') {
                        decompressor = zlib.createBrotliDecompress();
                    }

                    res.writeHead(proxyRes.statusCode, responseHeaders);

                    // Capturar body descomprimido
                    decompressor.on('data', (chunk) => {
                        responseChunks.push(chunk);
                    });

                    proxyRes.pipe(decompressor).pipe(res);

                    decompressor.on('error', (err) => {
                        console.error(`[PROXY] Error descomprimiendo: ${err.message}`);
                    });

                    decompressor.on('end', () => {
                        const duration = Date.now() - requestStart;
                        console.log(`[PROXY] Respuesta descomprimida y enviada en ${duration}ms`);

                        // Parsear body de respuesta para el log
                        const responseBody = parseResponseBody(Buffer.concat(responseChunks), proxyRes.headers['content-type']);

                        // Enviar log detallado
                        log.proxyDetailed({
                            method: req.method,
                            url: requestPath,
                            target: proxyConfig.target,
                            targetFull: `${proxyConfig.target}${targetPath}`,
                            statusCode: proxyRes.statusCode,
                            duration,
                            requestHeaders: requestHeadersForLog,
                            requestBody: requestBodyForLog,
                            responseHeaders: responseHeaders,
                            responseBody: responseBody
                        });
                    });
                } else {
                    // Sin compresión, capturar y enviar
                    res.writeHead(proxyRes.statusCode, responseHeaders);

                    proxyRes.on('data', (chunk) => {
                        responseChunks.push(chunk);
                        res.write(chunk);
                    });

                    proxyRes.on('end', () => {
                        res.end();
                        const duration = Date.now() - requestStart;
                        console.log(`[PROXY] Respuesta completa en ${duration}ms`);

                        // Parsear body de respuesta para el log
                        const responseBody = parseResponseBody(Buffer.concat(responseChunks), proxyRes.headers['content-type']);

                        // Enviar log detallado
                        log.proxyDetailed({
                            method: req.method,
                            url: requestPath,
                            target: proxyConfig.target,
                            targetFull: `${proxyConfig.target}${targetPath}`,
                            statusCode: proxyRes.statusCode,
                            duration,
                            requestHeaders: requestHeadersForLog,
                            requestBody: requestBodyForLog,
                            responseHeaders: responseHeaders,
                            responseBody: responseBody
                        });
                    });
                }
            });

            // Configurar timeout
            timeoutId = setTimeout(() => {
                if (!res.headersSent) {
                    timeoutTriggered = true;
                    console.log(`[PROXY] TIMEOUT después de ${proxyConfig.timeout}ms`);
                    proxyReq.destroy();

                    // Buscar fallback para timeout
                    const errorType = 'timeout';
                    const fallback = findMatchingFallback(proxyConfig, subPath, errorType);
                    if (fallback) {
                        console.log(`[PROXY] Timeout - Usando fallback: ${fallback.nombre}`);
                        sendFallbackResponse(res, fallback, req, requestPath, proxyConfig, errorType, requestStart);
                    } else {
                        log.proxyError(req.method, requestPath, proxyConfig.target, `Timeout after ${proxyConfig.timeout}ms`);
                        res.status(504).json({ error: 'Gateway Timeout', message: `Request timed out after ${proxyConfig.timeout}ms` });
                    }
                }
            }, proxyConfig.timeout);

            proxyReq.on('error', (err) => {
                // Limpiar timeout
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }

                // Si ya se disparó el timeout, no hacer nada más
                if (timeoutTriggered) {
                    return;
                }

                console.error(`[PROXY] ERROR: ${err.message}`);
                console.error(`[PROXY] Stack: ${err.stack}`);

                // Determinar tipo de error y buscar fallback
                const errorType = getErrorType(err, null);
                if (errorType) {
                    const fallback = findMatchingFallback(proxyConfig, subPath, errorType);
                    if (fallback) {
                        console.log(`[PROXY] Error ${errorType} - Usando fallback: ${fallback.nombre}`);
                        if (!res.headersSent) {
                            sendFallbackResponse(res, fallback, req, requestPath, proxyConfig, errorType, requestStart);
                        }
                        return;
                    }
                }

                log.proxyError(req.method, requestPath, proxyConfig.target, err.message);
                if (!res.headersSent) {
                    res.status(502).json({ error: 'Bad Gateway', message: err.message });
                }
            });

            // Transmitir el body de la petición
            if (req.body && Object.keys(req.body).length > 0) {
                const bodyData = JSON.stringify(req.body);
                console.log(`[PROXY] Enviando body: ${bodyData.substring(0, 200)}${bodyData.length > 200 ? '...' : ''}`);
                proxyReq.setHeader('Content-Type', req.headers['content-type'] || 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
                proxyReq.end();
            } else {
                console.log(`[PROXY] Sin body, haciendo pipe del request`);
                req.pipe(proxyReq);
            }

        } catch (err) {
            console.error(`[PROXY] ERROR de configuración: ${err.message}`);
            console.error(`[PROXY] Stack: ${err.stack}`);
            log.error(`Error configuración proxy: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Proxy configuration error', message: err.message });
            }
        }
    };

    // Registrar el handler en el app
    if (app.setProxyHandler) {
        app.setProxyHandler(proxyHandler);
        console.log('[PROXY] Middleware de proxy configurado correctamente via setProxyHandler');
    } else {
        // Fallback para compatibilidad
        app.use(proxyHandler);
        console.log('[PROXY] Middleware de proxy configurado correctamente via app.use');
    }
}

// Función para recargar la configuración de proxy sin reiniciar
async function reloadProxyConfigs() {
    console.log('[PROXY] Recargando configuraciones de proxy...');
    await loadProxyConfigs();
    console.log('[PROXY] Configuraciones de proxy recargadas exitosamente');
}

exports.configureProxy = configureProxy;
exports.reloadProxyConfigs = reloadProxyConfigs;
