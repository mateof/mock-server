const sqliteService = require('../services/sqlite.service');
const criteriaService = require('../services/criteria-evaluator.service');
const { log, sendData } = require('../services/socket.service');
const semaphore = require('../services/semaphore.service');
const moment = require("moment");
const path = require("path");
const fs = require("fs");

// Directorio de archivos subidos
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

// ===== HELPERS =====

// Parsea JSON de forma segura, devuelve null si falla
function safeJsonParse(jsonString, context = '') {
    if (!jsonString || jsonString.trim() === '') {
        console.log(`[JSON] ${context}: String vacío o null`);
        return { success: false, data: null, error: 'Empty string' };
    }

    try {
        const data = JSON.parse(jsonString);
        console.log(`[JSON] ${context}: Parseado correctamente`);
        return { success: true, data, error: null };
    } catch (e) {
        console.error(`[JSON] ${context}: Error parseando - ${e.message}`);
        console.error(`[JSON] ${context}: Contenido recibido: "${jsonString.substring(0, 100)}${jsonString.length > 100 ? '...' : ''}"`);
        return { success: false, data: null, error: e.message };
    }
}

// Aplica headers personalizados a la respuesta
function applyCustomHeaders(res, customHeadersJson) {
    if (!customHeadersJson) {
        console.log('[HEADERS] No hay headers personalizados');
        return;
    }

    console.log('[HEADERS] Aplicando headers personalizados...');
    const result = safeJsonParse(customHeadersJson, 'customHeaders');

    if (!result.success || !Array.isArray(result.data)) {
        console.log('[HEADERS] Headers no válidos o no es array');
        return;
    }

    result.data.forEach(h => {
        if (h.action === 'set' && h.name) {
            console.log(`[HEADERS] SET: ${h.name} = ${h.value || ''}`);
            res.setHeader(h.name, h.value || '');
        } else if (h.action === 'remove' && h.name) {
            console.log(`[HEADERS] REMOVE: ${h.name}`);
            res.removeHeader(h.name);
        }
    });
    console.log('[HEADERS] Headers aplicados correctamente');
}

// Extrae parámetros de path para rutas regex (grupos de captura)
function extractPathParams(route, url) {
    if (!route.isRegex) return {};

    try {
        const regex = new RegExp(route.ruta);
        const urlPath = url.split('?')[0]; // Sin query params
        const match = urlPath.match(regex);

        if (!match) return {};

        // Si hay grupos nombrados
        if (match.groups) return match.groups;

        // Grupos numerados ($1, $2, etc.)
        const params = {};
        for (let i = 1; i < match.length; i++) {
            params[`$${i}`] = match[i];
        }
        return params;
    } catch (e) {
        console.error(`[ROUTE] Error extrayendo params: ${e.message}`);
        return {};
    }
}

// ===== MIDDLEWARE PRINCIPAL =====

async function checkRoute(req, res, next) {
    const requestStart = Date.now();
    const { method, url } = req;

    console.log(`\n[ROUTE] ========== Nueva petición ==========`);
    console.log(`[ROUTE] ${method} ${url}`);
    console.log(`[ROUTE] Headers: ${JSON.stringify(req.headers).substring(0, 200)}...`);

    let rute = await sqliteService.getRuta(url, method.toLowerCase());
    console.log(`[ROUTE] Ruta encontrada en BD: ${rute ? 'SÍ' : 'NO'}`);

    // Si es tipo proxy, ignorar y pasar al middleware de proxy
    if (rute && rute.tiporespuesta === 'proxy') {
        console.log(`[ROUTE] Tipo proxy detectado, delegando al middleware de proxy...`);
        await next();
        const duration = Date.now() - requestStart;
        console.log(`[ROUTE] Proxy completado en ${duration}ms con status ${res.statusCode}`);
        return;
    }

    if (rute) {
        console.log(`[ROUTE] Configuración de ruta:`);
        console.log(`[ROUTE]   - ID: ${rute.id}`);
        console.log(`[ROUTE]   - Ruta: ${rute.ruta}`);
        console.log(`[ROUTE]   - Método: ${rute.tipo}`);
        console.log(`[ROUTE]   - Código: ${rute.codigo}`);
        console.log(`[ROUTE]   - Tipo respuesta: ${rute.tiporespuesta}`);
        console.log(`[ROUTE]   - Espera activa: ${rute.esperaActiva}`);
        console.log(`[ROUTE]   - Respuesta (primeros 100 chars): ${rute.respuesta ? rute.respuesta.substring(0, 100) : 'VACÍA'}`);

        // Valores por defecto de la ruta
        let responseCode = Number(rute.codigo);
        let responseType = rute.tiporespuesta;
        let responseBody = rute.respuesta;
        let responseHeaders = rute.customHeaders;

        // Evaluar condiciones ANTES de la espera activa (para mostrar la respuesta real en pending list)
        try {
            const conditions = await sqliteService.getConditionalResponses(rute.id);
            if (conditions && conditions.length > 0) {
                console.log(`[ROUTE] Evaluando ${conditions.length} condiciones...`);

                // Construir contexto para evaluación
                const evalContext = {
                    headers: req.headers || {},
                    body: req.body || {},
                    path: req.path || url,
                    query: req.query || {},
                    params: extractPathParams(rute, url),
                    method: method.toLowerCase()
                };

                // Evaluar condiciones en orden (primera que match gana)
                for (const condition of conditions) {
                    const evalResult = criteriaService.evaluateCriteria(condition.criteria, evalContext);
                    if (evalResult.success && evalResult.result) {
                        console.log(`[ROUTE] Condición matched: "${condition.nombre || condition.id}"`);

                        // Aplicar overrides de la condición
                        if (condition.codigo) {
                            responseCode = Number(condition.codigo);
                            console.log(`[ROUTE]   → Código: ${responseCode}`);
                        }
                        if (condition.tiporespuesta) {
                            responseType = condition.tiporespuesta;
                            console.log(`[ROUTE]   → Tipo: ${responseType}`);
                        }
                        if (condition.respuesta !== null && condition.respuesta !== undefined) {
                            responseBody = condition.respuesta;
                            console.log(`[ROUTE]   → Respuesta personalizada`);
                        }
                        if (condition.customHeaders) {
                            responseHeaders = condition.customHeaders;
                            console.log(`[ROUTE]   → Headers personalizados`);
                        }
                        break; // Primera condición que match gana
                    }
                }
            }
        } catch (condErr) {
            console.error(`[ROUTE] Error evaluando condiciones: ${condErr.message}`);
            // Continuar con respuesta por defecto
        }

        // Modo espera activa (ahora con los valores ya evaluados por criterios)
        let customResponse = null;
        let availableConditions = [];
        if (rute.esperaActiva === 1) {
            console.log(`[ROUTE] Modo espera activa ACTIVADO - esperando señal...`);
            log.wait(method, url);

            // Obtener condiciones disponibles para esta ruta (para selector en pending list)
            try {
                const allConditions = await sqliteService.getConditionalResponses(rute.id);
                if (allConditions && allConditions.length > 0) {
                    availableConditions = allConditions.map(c => ({
                        id: c.id,
                        nombre: c.nombre || `Condición ${c.id}`,
                        codigo: c.codigo,
                        tiporespuesta: c.tiporespuesta,
                        respuesta: c.respuesta,
                        customHeaders: c.customHeaders
                    }));
                }
            } catch (condErr) {
                console.error(`[ROUTE] Error obteniendo condiciones para pending list: ${condErr.message}`);
            }

            const itemLW = {
                id: semaphore.generateUUID(),
                sleep: true,
                url: rute.ruta,
                method: method,
                date: moment().format("MM/DD/YYYY HH:mm:ss:SSS"),
                defaultResponse: responseBody,      // Respuesta después de evaluar criterios
                tiporespuesta: responseType,        // Tipo después de evaluar criterios
                codigo: responseCode,               // Código después de evaluar criterios
                customHeaders: responseHeaders,     // Headers después de evaluar criterios
                requestHeaders: req.headers,
                conditions: availableConditions,    // Condiciones disponibles para seleccionar
                originalResponse: rute.respuesta,   // Respuesta original (sin criterios)
                originalCode: rute.codigo,          // Código original
                originalType: rute.tiporespuesta,   // Tipo original
                originalHeaders: rute.customHeaders // Headers originales
            };
            sendData('addItem', itemLW);
            await semaphore.addToListAndWait(itemLW);
            console.log(`[ROUTE] Señal recibida, continuando...`);
            // Guardar respuesta personalizada si existe
            if (itemLW.customResponse !== undefined && itemLW.customResponse !== null) {
                customResponse = itemLW.customResponse;
                console.log(`[ROUTE] Usando respuesta personalizada:`, JSON.stringify(customResponse).substring(0, 200));
            }
            sendData('deleteItem', itemLW.id);
            rute = await sqliteService.getRuta(url, method.toLowerCase());
            console.log(`[ROUTE] Ruta recargada después de espera`);
        }

        // Aplicar personalizaciones de espera activa (si existen)
        if (customResponse && typeof customResponse === 'object') {
            if (customResponse.code) {
                responseCode = Number(customResponse.code);
                console.log(`[ROUTE] Código personalizado: ${responseCode}`);
            }
            if (customResponse.type) {
                responseType = customResponse.type;
                console.log(`[ROUTE] Tipo personalizado: ${responseType}`);
            }
            if (customResponse.body) {
                responseBody = customResponse.body;
                console.log(`[ROUTE] Body personalizado: ${responseBody.substring(0, 100)}...`);
            }
            if (customResponse.headers) {
                responseHeaders = customResponse.headers;
                console.log(`[ROUTE] Headers personalizados desde UI`);
            }
        }

        res.statusCode = responseCode;
        res.status = responseCode;
        res.header('Access-Control-Allow-Origin', req.header('origin'));
        console.log(`[ROUTE] Status code establecido: ${res.statusCode}`);

        // Aplicar headers personalizados (pueden ser del customResponse o de la ruta)
        applyCustomHeaders(res, responseHeaders);

        // Aplicar headers inline si vienen como JSON object
        if (customResponse && customResponse.headers) {
            try {
                const inlineHeaders = JSON.parse(customResponse.headers);
                if (typeof inlineHeaders === 'object' && !Array.isArray(inlineHeaders)) {
                    Object.entries(inlineHeaders).forEach(([key, value]) => {
                        console.log(`[HEADERS] SET (inline): ${key} = ${value}`);
                        res.setHeader(key, value);
                    });
                }
            } catch (e) {
                console.log(`[HEADERS] Headers inline no es JSON válido, ignorando`);
            }
        }

        const duration = Date.now() - requestStart;

        // Redirect 301
        if (responseCode === 301) {
            console.log(`[ROUTE] Redirect 301 a: ${responseBody}`);
            res.redirect(301, responseBody);
            log.redirect(method, url, res.statusCode, duration);
            return;
        }

        // Respuestas con body
        if (responseType !== 'empty') {
            if (responseType === 'page') {
                console.log(`[ROUTE] Respuesta tipo PAGE`);
                res.render('default', { data: responseBody, layout: false });
                log.page(method, url, res.statusCode, duration);
                return;
            }
            if (responseType === 'file') {
                console.log(`[ROUTE] Respuesta tipo FILE`);
                const filePath = rute.filePath;
                const fileName = rute.fileName;
                const fileMimeType = rute.fileMimeType;

                if (!filePath) {
                    console.error(`[ROUTE] ERROR: No hay archivo configurado para ruta ${url}`);
                    res.status(500).json({ error: 'No file configured for this route' });
                    return;
                }

                const fullPath = path.join(UPLOADS_DIR, filePath);

                // Verificar que el archivo existe
                if (!fs.existsSync(fullPath)) {
                    console.error(`[ROUTE] ERROR: Archivo no encontrado: ${fullPath}`);
                    res.status(404).json({ error: 'File not found' });
                    return;
                }

                // Configurar headers
                if (fileMimeType) {
                    res.type(fileMimeType);
                }
                res.setHeader('Content-Disposition', `inline; filename="${fileName || 'file'}"`);

                // Enviar archivo
                res.sendFile(fullPath, (err) => {
                    if (err) {
                        console.error(`[ROUTE] ERROR enviando archivo: ${err.message}`);
                    } else {
                        console.log(`[ROUTE] Archivo enviado: ${fileName} en ${duration}ms`);
                    }
                });
                log.mock(method, url, res.statusCode, duration);
                return;
            }
            if (responseType === 'json') {
                console.log(`[ROUTE] Respuesta tipo JSON - parseando...`);
                const jsonResult = safeJsonParse(responseBody, `ruta ${url}`);

                if (jsonResult.success) {
                    console.log(`[ROUTE] JSON parseado correctamente, enviando respuesta`);
                    res.json(jsonResult.data);
                } else {
                    console.error(`[ROUTE] ERROR: JSON inválido para ruta ${url}`);
                    console.error(`[ROUTE] Enviando objeto vacío como fallback`);
                    res.json({});
                }
                res.end();
                log.mock(method, url, res.statusCode, duration);
                console.log(`[ROUTE] Respuesta enviada en ${duration}ms`);
                return;
            }
            // Texto, HTML, XML, SOAP
            if (responseType === 'text') {
                res.type('text/plain');
            } else if (responseType === 'html') {
                res.type('text/html');
            } else if (responseType === 'xml') {
                res.type('application/xml');
            } else if (responseType === 'soap') {
                res.type('text/xml');
                res.setHeader('SOAPAction', '""');
            }
            res.send(responseBody);
            log.mock(method, url, res.statusCode, duration);
            console.log(`[ROUTE] Respuesta ${responseType} enviada en ${duration}ms`);
            return;
        }

        // Respuesta vacía
        console.log(`[ROUTE] Respuesta tipo EMPTY`);
        res.end();
        log.empty(method, url, res.statusCode, duration);
        console.log(`[ROUTE] Respuesta vacía enviada en ${duration}ms`);
        return;
    }

    // Ruta no configurada, pasar al proxy
    console.log(`[ROUTE] Ruta NO configurada, pasando al proxy...`);
    await next();
    const duration = Date.now() - requestStart;
    console.log(`[ROUTE] Proxy completado en ${duration}ms con status ${res.statusCode}`);
    log.notConfigured(method, url, res.statusCode, duration);
}

exports.checkRoute = checkRoute;