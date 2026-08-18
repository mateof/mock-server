const sqliteService = require('../services/sqlite.service');
const criteriaService = require('../services/criteria-evaluator.service');
const { log, sendData } = require('../services/socket.service');
const graphqlService = require('../services/graphql.service');
const semaphore = require('../services/semaphore.service');
const trace = require('../services/trace.service');
const faultService = require('../services/fault.service');
const templateService = require('../services/template.service');
const scenarioService = require('../services/scenario.service');
const scriptRunner = require('../services/script-runner.service');
const sseService = require('../services/sse.service');
const moment = require("moment");
const path = require("path");
const fs = require("fs");
const config = require('../services/paths');

// Directorio de archivos subidos
const UPLOADS_DIR = path.join(config.DATA_DIR, 'uploads');

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

/**
 * Las cabeceras de una ruta se guardan como reglas set/remove; el script las
 * espera como un objeto plano. Las de tipo remove no llegan: quitar algo que
 * todavía no se ha puesto no significa nada aquí.
 */
function cabecerasComoObjeto(customHeadersJson) {
    const resultado = {};
    const parsed = safeJsonParse(customHeadersJson, 'customHeaders para script');
    if (parsed.success && Array.isArray(parsed.data)) {
        parsed.data.forEach(h => {
            if (h.action === 'set' && h.name) resultado[h.name] = h.value || '';
        });
    }
    return resultado;
}

/**
 * El cuerpo tal cual llegó. Se usa rawBody si está, que es lo que evita que un
 * formulario o un cuerpo no-JSON lleguen al script convertidos en otra cosa.
 */
function cuerpoDePeticionComoTexto(req) {
    if (req.rawBody && req.rawBody.length) return req.rawBody.toString('utf8');
    if (req.body === undefined || req.body === null) return '';
    if (typeof req.body === 'string') return req.body;
    try {
        return Object.keys(req.body).length ? JSON.stringify(req.body) : '';
    } catch (e) {
        return '';
    }
}

// Cómo se cuenta el fallo en la consola del panel
function describirFallo(config) {
    if (config.tipoFallo === 'reset') return 'conexión cortada';
    if (config.tipoFallo === 'empty') return `respuesta vacía ${config.codigoFallo}`;
    return `error ${config.codigoFallo}`;
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

    if (rute) {
        trace.setRoute(rute.id);
        trace.step(trace.PASOS.ROUTE, {
            message: `Ruta ${rute.id} (${rute.tipo.toUpperCase()} ${rute.ruta})`,
            details: {
                route_id: rute.id, path: rute.ruta, method: rute.tipo,
                response_type: rute.tiporespuesta, status_code: rute.codigo,
                is_regex: rute.isRegex === 1
            }
        });
    } else {
        // Sin nivel de aviso: en una ruta proxy esto es lo normal, porque el
        // proxy casa por prefijo más adelante y no por esta búsqueda
        trace.step(trace.PASOS.ROUTE, {
            message: 'Ninguna ruta mock casa; sigue el proxy si hay alguno'
        });
    }

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

        // Una sola vez por petición: si se consultara en cada sitio, el criterio
        // y la plantilla verían números distintos dentro de la misma llamada
        const numeroLlamada = scenarioService.registrarLlamada(rute.id);

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
                    method: method.toLowerCase(),
                    // Número de esta llamada a la ruta, para condiciones que
                    // dependen de cuántas van y no de lo que trae la petición
                    callCount: numeroLlamada
                };

                // Evaluar condiciones en orden (primera que match gana)
                for (const condition of conditions) {
                    const evalResult = criteriaService.evaluateCriteria(condition.criteria, evalContext);
                    if (evalResult.success && evalResult.result) {
                        console.log(`[ROUTE] Condición matched: "${condition.nombre || condition.id}"`);
                        trace.step(trace.PASOS.CONDITION, {
                            message: `Condición "${condition.nombre || condition.id}"`,
                            details: {
                                condition_id: condition.id, name: condition.nombre,
                                criteria: condition.criteria,
                                overrides: {
                                    status_code: condition.codigo,
                                    response_type: condition.tiporespuesta,
                                    has_body: !!condition.respuesta
                                }
                            }
                        });

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
            trace.step(trace.PASOS.WAIT, {
                message: 'Espera activa: la petición queda retenida',
                level: 'warning'
            });

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
            trace.step(trace.PASOS.WAIT, {
                message: 'Espera activa liberada',
                details: { custom_response: !!itemLW.customResponse }
            });
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

        // Latencia y fallos provocados. Van después de las condiciones para que
        // la traza deje ver qué se iba a responder antes de romperlo
        const chaos = faultService.configuracion(rute);
        if (faultService.estaActiva(chaos)) {
            const retardo = faultService.calcularRetardo(chaos);
            if (retardo > 0) {
                trace.step(trace.PASOS.LATENCY, {
                    message: `Latencia provocada: ${retardo} ms`,
                    details: { mode: chaos.modo, delay_ms: retardo, min: chaos.min, max: chaos.max }
                });
                await faultService.esperar(retardo);
            }

            if (faultService.tocaFallar(chaos)) {
                trace.step(trace.PASOS.FAULT, {
                    message: `Fallo provocado (${chaos.tipoFallo})`,
                    level: 'error',
                    status: chaos.tipoFallo === 'reset' ? null : Number(chaos.codigoFallo),
                    details: { type: chaos.tipoFallo, rate: chaos.porcentajeFallo, status: chaos.codigoFallo }
                });
                faultService.provocarFallo(chaos, res);
                log.fault(method, url, chaos.tipoFallo === 'reset' ? null : Number(chaos.codigoFallo),
                    Date.now() - requestStart, describirFallo(chaos));
                return;
            }
        }

        // Escenario: el paso que toca según la vez que se llama. Va después de
        // las condiciones y gana sobre ellas: "a la tercera, done" es una regla
        // sobre el flujo entero, más de fuera que cualquier criterio de petición
        try {
            const pasos = await sqliteService.getRouteSequence(rute.id);
            if (pasos.length > 0) {
                const elegido = scenarioService.pasoParaLlamada(
                    pasos, numeroLlamada, rute.sequence_mode || 'stick');

                if (elegido) {
                    const paso = elegido.paso;
                    trace.step(trace.PASOS.SEQUENCE, {
                        message: `Paso ${elegido.posicion + 1}/${elegido.total}` +
                                 `${paso.nombre ? ` "${paso.nombre}"` : ''} (llamada ${numeroLlamada})`,
                        details: {
                            call: numeroLlamada,
                            step: elegido.posicion + 1,
                            steps: elegido.total,
                            name: paso.nombre,
                            mode: rute.sequence_mode || 'stick',
                            exhausted: elegido.agotada
                        }
                    });

                    if (paso.codigo) responseCode = Number(paso.codigo);
                    if (paso.tiporespuesta) responseType = paso.tiporespuesta;
                    if (paso.respuesta !== null && paso.respuesta !== undefined) responseBody = paso.respuesta;
                    if (paso.customHeaders) responseHeaders = paso.customHeaders;
                }
            }
        } catch (seqErr) {
            console.error(`[ROUTE] Error aplicando la secuencia: ${seqErr.message}`);
        }

        // Plantillas en el cuerpo y en las cabeceras. Va después de las
        // condiciones a propósito: la respuesta que se renderiza es la que
        // ganó, no la de por defecto
        if (rute.templating === 1) {
            const contexto = templateService.contextoDePeticion(req, extractPathParams(rute, url));
            contexto.callCount = numeroLlamada;
            const esJson = responseType === 'json';

            if (templateService.tienePlantilla(responseBody)) {
                responseBody = templateService.render(responseBody, contexto, { json: esJson });
                trace.step(trace.PASOS.TEMPLATE, {
                    message: 'Plantilla aplicada a la respuesta',
                    details: { response_type: responseType, json_mode: esJson }
                });
            }
            // Las cabeceras son un JSON, así que se renderizan en modo JSON
            // para que un valor con comillas no destroce el array
            if (templateService.tienePlantilla(responseHeaders)) {
                responseHeaders = templateService.render(responseHeaders, contexto, { json: true });
            }
        }

        // Script ms.*: el último en tocar la respuesta, así que ve el cuerpo
        // definitivo. Los tipos sin cuerpo de texto se saltan: no hay nada que
        // transformar en un fichero ni en una respuesta vacía
        if (rute.mock_script && !['file', 'empty', 'graphql'].includes(responseType)) {
            const salida = scriptRunner.runResponseScript(rute.mock_script, {
                status: responseCode,
                headers: cabecerasComoObjeto(responseHeaders),
                bodyText: responseBody === null || responseBody === undefined ? '' : String(responseBody),
                request: {
                    method: method,
                    path: (req.path || url).split('?')[0],
                    query: req.query || {},
                    headers: req.headers || {},
                    bodyText: cuerpoDePeticionComoTexto(req)
                }
            });

            (salida.logs || []).forEach(linea => log.info(`📜 ${linea}`));

            if (!salida.success) {
                console.error(`[ROUTE] Error en el script de la ruta: ${salida.error}`);
                trace.step(trace.PASOS.SCRIPT, {
                    message: `El script falló: ${salida.error}`,
                    level: 'error',
                    details: { error: salida.error }
                });
                res.status(500).json({ error: 'Mock script failed', message: salida.error });
                log.fault(method, url, 500, Date.now() - requestStart, `script: ${salida.error}`);
                return;
            }

            if (salida.result) {
                responseCode = salida.result.status;
                // El cuerpo solo se sustituye si el script lo tocó: igual que en
                // el proxy, así un script que solo lee cabeceras no reserializa
                // el JSON ni le cambia el formato al que lo escribió
                if (salida.result.body.changed) {
                    responseBody = salida.result.body.text;
                }
                responseHeaders = JSON.stringify(
                    Object.entries(salida.result.headers || {})
                        .map(([name, value]) => ({ action: 'set', name, value: String(value) }))
                );
                trace.step(trace.PASOS.SCRIPT, {
                    message: 'Script de la ruta aplicado',
                    details: {
                        status: responseCode,
                        body_changed: salida.result.body.changed,
                        logs: (salida.logs || []).length
                    }
                });
            }
        }

        res.statusCode = responseCode;
        // Aquí había un `res.status = responseCode` que machacaba el método
        // res.status() de Express con un número. Nadie lo leía, y dejaba
        // tirando abajo el proceso cualquier error posterior que respondiera
        // con res.status(...): el fichero sin configurar, el fichero que no
        // existe y, ahora, el SSE mal formado
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
            if (responseType === 'sse') {
                console.log(`[ROUTE] Respuesta tipo SSE`);
                const analisis = sseService.parsearEventos(responseBody);

                if (!analisis.ok) {
                    console.error(`[ROUTE] SSE mal configurado: ${analisis.error}`);
                    trace.step(trace.PASOS.RESPONSE, {
                        message: `SSE mal configurado: ${analisis.error}`,
                        level: 'error'
                    });
                    res.status(500).json({ error: 'Invalid SSE configuration', message: analisis.error });
                    log.error(`📡 ${method} ${url}: ${analisis.error}`);
                    return;
                }

                trace.step(trace.PASOS.RESPONSE, {
                    message: `Stream SSE abierto con ${analisis.eventos.length} eventos`,
                    status: 200,
                    details: { events: analisis.eventos.length, loop: rute.sse_loop === 1 }
                });

                sseService.transmitir(req, res, {
                    eventos: analisis.eventos,
                    loop: rute.sse_loop === 1,
                    onEnd: ({ sent, reason }) => {
                        log.request(method, url, 200, Date.now() - requestStart, 'mock');
                        console.log(`[ROUTE] SSE cerrado (${reason}) tras ${sent} eventos`);
                    }
                });
                return;
            }
            if (responseType === 'graphql') {
                console.log(`[ROUTE] Respuesta tipo GRAPHQL`);
                const operations = await sqliteService.getGraphQLOperations(rute.id);
                const result = await graphqlService.handleGraphQLRequest(req.body, operations, rute.graphql_schema, rute.graphql_proxy_url);
                res.json(result);
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