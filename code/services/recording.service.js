/**
 * Recording Service
 *
 * Convierte tráfico real en rutas mock. Es el atajo para no escribir mocks a
 * mano: apuntas una ruta proxy al backend de verdad, dejas pasar tráfico y te
 * quedas con lo que respondió.
 *
 * Hay dos entradas, y no son intercambiables:
 *
 * 1. **Modo grabación** en una ruta proxy. El intercambio se convierte al
 *    vuelo, con el búfer de la respuesta todavía en memoria, así que el cuerpo
 *    es el completo.
 * 2. **"Guardar como mock"** desde una línea del log. Aquí solo se tiene lo que
 *    se guardó, y el log recorta los cuerpos a 10 KB. Un cuerpo recortado
 *    generaría un mock corrupto, así que se rechaza en vez de guardarlo a
 *    medias.
 *
 * Decisión que condiciona el resto: **lo grabado nace desactivado**. Los mocks
 * ganan a los proxys en prioridad, así que un mock activo creado en la primera
 * petición taparía al proxy y la grabación se quedaría en esa única llamada.
 * Se graba la sesión entera y luego se activa. Al guardar una línea suelta a
 * mano sí se activa, porque ahí la intención es explícita y es una sola ruta.
 */

const sqliteService = require('./sqlite.service');
const routesService = require('./routes.service');
const logService = require('./log.service');

// Tag con el que se marca todo lo grabado, para poder encontrarlo y activarlo
// en bloque después
const TAG_GRABADO = 'recorded';
const COLOR_TAG_GRABADO = '#f59e0b';

// Cabeceras que no tiene sentido copiar a un mock: o las recalcula Express al
// responder, o describen el transporte de aquella conexión y no la respuesta
const CABECERAS_IGNORADAS = new Set([
    'content-length',
    'content-encoding',
    'transfer-encoding',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'upgrade',
    'date',
    'server',
    'x-powered-by'
]);

// Modos ante una ruta que ya existe con el mismo método y camino
const MODOS = ['update', 'skip'];

/**
 * Tipo de respuesta del mock a partir del content-type del backend.
 * Devuelve null si es binario: no cabe en una columna de texto y un mock con
 * el cuerpo destrozado es peor que no tenerlo.
 */
function tipoRespuestaDesdeContentType(contentType, cuerpo) {
    const ct = String(contentType || '').toLowerCase();

    if (!cuerpo || cuerpo.length === 0) return 'empty';

    if (ct.includes('json')) return 'json';
    if (ct.includes('html')) return 'html';
    if (ct.includes('xml')) {
        // Un SOAP es XML con sobre; merece su propio tipo porque el mock le
        // pone el SOAPAction al responder
        return /<[a-z0-9]*:?envelope/i.test(cuerpo) ? 'soap' : 'xml';
    }
    if (ct.startsWith('text/') || ct.includes('javascript') || ct.includes('csv')) return 'text';
    if (!ct) {
        // Sin content-type: si parece JSON se trata como tal, y si no, texto
        const limpio = cuerpo.trim();
        if (limpio.startsWith('{') || limpio.startsWith('[')) return 'json';
        return 'text';
    }

    return null;
}

/**
 * Deja el cuerpo listo para guardarlo. El JSON se reindenta para que la ruta
 * grabada se pueda leer y editar en el panel, no como una línea kilométrica.
 */
function normalizarCuerpo(texto, tipo) {
    if (!texto) return '';
    if (tipo !== 'json') return texto;

    try {
        return JSON.stringify(JSON.parse(texto), null, 2);
    } catch (e) {
        return texto;
    }
}

function cabecerasParaMock(headers) {
    if (!headers || typeof headers !== 'object') return [];

    return Object.entries(headers)
        .filter(([nombre]) => {
            const n = nombre.toLowerCase();
            // Las x-mock-* las pone este servidor, no el backend
            return !CABECERAS_IGNORADAS.has(n) && !n.startsWith('x-mock-');
        })
        .map(([nombre, valor]) => ({
            action: 'set',
            name: nombre,
            value: Array.isArray(valor) ? valor.join(', ') : String(valor)
        }));
}

/**
 * Camino sin query. Las rutas exactas no miran la query al casar, así que
 * dejarla dentro solo conseguiría que el mock no casara nunca.
 */
function caminoDeUrl(url) {
    if (!url) return '/';
    const sinQuery = String(url).split('?')[0];
    return sinQuery.startsWith('/') ? sinQuery : `/${sinQuery}`;
}

/**
 * Traduce un intercambio a un payload de ruta.
 *
 * Devuelve `{ ok: false, reason }` en vez de lanzar, porque en una conversión
 * en bloque lo normal es que unas cuantas entradas no se puedan convertir y
 * eso no debe tumbar el resto.
 */
function intercambioAPayload(intercambio, opciones = {}) {
    const {
        method,
        url,
        status,
        responseHeaders,
        responseBody,
        truncated
    } = intercambio;

    if (truncated) {
        return { ok: false, reason: 'truncated' };
    }

    const contentType = buscarCabecera(responseHeaders, 'content-type');
    const tipo = tipoRespuestaDesdeContentType(contentType, responseBody);

    if (tipo === null) {
        return { ok: false, reason: 'binary' };
    }

    const camino = caminoDeUrl(url);
    if (routesService.isReservedRoute(camino)) {
        return { ok: false, reason: 'reserved' };
    }

    const tags = Array.isArray(opciones.tags) ? [...opciones.tags] : [];
    if (opciones.tag !== false && !tags.includes(TAG_GRABADO)) {
        tags.push(TAG_GRABADO);
    }

    return {
        ok: true,
        payload: {
            tipo: String(method || 'get').toLowerCase(),
            ruta: camino,
            codigo: String(status || 200),
            tiporespuesta: tipo,
            respuesta: tipo === 'empty' ? '' : normalizarCuerpo(responseBody, tipo),
            customHeaders: cabecerasParaMock(responseHeaders),
            esperaActiva: false,
            isRegex: false,
            activo: opciones.activo === undefined ? false : !!opciones.activo,
            tags,
            summary: opciones.summary || `Recorded from ${method} ${camino}`,
            description: opciones.description || null
        }
    };
}

function buscarCabecera(headers, nombre) {
    if (!headers) return null;
    const buscado = nombre.toLowerCase();
    for (const [clave, valor] of Object.entries(headers)) {
        if (clave.toLowerCase() === buscado) return valor;
    }
    return null;
}

/**
 * Busca una ruta mock que ya atienda ese método y camino, para no duplicar.
 * Se ignoran las proxy a propósito: la ruta proxy de la que sale la grabación
 * casa por prefijo y siempre "existiría".
 */
async function buscarMockExistente(camino, metodo) {
    const rutas = await routesService.listRoutes({});
    return rutas.find(r =>
        r.tiporespuesta !== 'proxy' &&
        r.ruta === camino &&
        String(r.tipo).toLowerCase() === String(metodo).toLowerCase() &&
        (r.isRegex || 0) === 0
    ) || null;
}

/**
 * Guarda un intercambio como ruta mock.
 *
 * @param {object} intercambio  method, url, status, responseHeaders, responseBody, truncated
 * @param {object} opciones     mode ('update' | 'skip'), activo, tags, summary
 * @returns {object} { action: 'created'|'updated'|'skipped', id, ruta, reason }
 */
async function guardarComoMock(intercambio, opciones = {}) {
    const modo = MODOS.includes(opciones.mode) ? opciones.mode : 'update';
    const traducido = intercambioAPayload(intercambio, opciones);

    if (!traducido.ok) {
        return { action: 'skipped', reason: traducido.reason, ruta: caminoDeUrl(intercambio.url) };
    }

    const payload = traducido.payload;
    await asegurarTag(payload.tags);
    const existente = await buscarMockExistente(payload.ruta, payload.tipo);

    if (existente) {
        if (modo === 'skip') {
            return { action: 'skipped', reason: 'exists', id: existente.id, ruta: payload.ruta };
        }
        // Se respeta si ya estaba activa: desactivar una ruta que alguien está
        // usando porque ha vuelto a pasar tráfico sería una sorpresa desagradable
        await routesService.updateRoute(existente.id, {
            ...payload,
            activo: existente.activo === 1 ? true : payload.activo
        });
        return { action: 'updated', id: existente.id, ruta: payload.ruta, tipo: payload.tipo };
    }

    const id = await routesService.createRoute(payload);
    return { action: 'created', id, ruta: payload.ruta, tipo: payload.tipo };
}

async function asegurarTag(tags) {
    if (!Array.isArray(tags) || !tags.includes(TAG_GRABADO)) return;
    try {
        await sqliteService.getOrCreateTag(TAG_GRABADO, COLOR_TAG_GRABADO);
    } catch (e) {
        // Que no exista el tag en el registro solo afecta al color
        console.log(`[REC] No se pudo registrar el tag ${TAG_GRABADO}: ${e.message}`);
    }
}

// ===== DESDE EL LOG =====

/**
 * Reconstruye el intercambio a partir de una entrada de log detallada.
 *
 * El log guarda el cuerpo ya parseado y con marca de recorte, y además recorta
 * el detalle entero a 20 KB: cuando eso pasa, `details` deja de ser un objeto y
 * llega como texto suelto. Los dos casos se detectan aquí.
 */
function intercambioDesdeEntrada(entrada) {
    if (!entrada) return { ok: false, reason: 'not-found' };

    if (typeof entrada.details === 'string' || !entrada.details) {
        return { ok: false, reason: 'truncated' };
    }

    const respuesta = entrada.details.response;
    if (!respuesta) {
        return { ok: false, reason: 'no-response' };
    }

    const cuerpo = respuesta.body;
    let texto = '';
    let truncado = false;

    if (cuerpo && typeof cuerpo === 'object' && 'data' in cuerpo) {
        truncado = !!cuerpo.truncated;
        texto = cuerpo.type === 'json'
            ? JSON.stringify(cuerpo.data, null, 2)
            : String(cuerpo.data ?? '');
    } else if (typeof cuerpo === 'string') {
        texto = cuerpo;
    }

    return {
        ok: true,
        intercambio: {
            method: entrada.method,
            url: entrada.url,
            status: entrada.status,
            responseHeaders: respuesta.headers || {},
            responseBody: texto,
            truncated: truncado
        }
    };
}

async function leerEntrada(id) {
    return new Promise((resolve, reject) => {
        sqliteService.getDatabase().get('SELECT * FROM logs WHERE id = ?', [Number(id)], (err, fila) => {
            if (err) return reject(err);
            if (!fila) return resolve(null);
            let details = fila.details;
            try {
                details = details ? JSON.parse(details) : null;
            } catch (e) {
                // Se deja como texto: es la señal de que el detalle venía recortado
            }
            resolve({ ...fila, details });
        });
    });
}

/**
 * Convierte una línea concreta del log en un mock
 */
async function desdeEntradaDeLog(id, opciones = {}) {
    const entrada = await leerEntrada(id);
    const traducido = intercambioDesdeEntrada(entrada);

    if (!traducido.ok) {
        return { action: 'skipped', reason: traducido.reason, id: Number(id) };
    }

    // A mano se activa: la intención es explícita y es una ruta sola
    return guardarComoMock(traducido.intercambio, { activo: true, ...opciones });
}

/**
 * Convierte en bloque todo lo que casa con unos filtros: "todo lo que ha
 * pasado por /pedidos en la última hora".
 *
 * Se queda con la última respuesta de cada método y camino. Trescientas
 * llamadas al mismo sitio deben dar un mock, no trescientas escrituras.
 */
async function desdeFiltrosDeLog(filtros = {}, opciones = {}) {
    const resultado = await logService.query({
        ...filtros,
        type: 'proxy-detailed',
        limit: Math.min(parseInt(filtros.limit) || 1000, 1000)
    });

    const porClave = new Map();
    // query() devuelve de más reciente a más antiguo, así que la primera que
    // se ve de cada clave es la que hay que quedarse
    for (const entrada of resultado.entries) {
        const clave = `${String(entrada.method || '').toUpperCase()} ${caminoDeUrl(entrada.url)}`;
        if (!porClave.has(clave)) porClave.set(clave, entrada);
    }

    const resumen = { created: 0, updated: 0, skipped: 0, results: [] };

    for (const entrada of porClave.values()) {
        const traducido = intercambioDesdeEntrada(entrada);
        let salida;

        if (!traducido.ok) {
            salida = {
                action: 'skipped',
                reason: traducido.reason,
                ruta: caminoDeUrl(entrada.url),
                method: entrada.method
            };
        } else {
            try {
                salida = await guardarComoMock(traducido.intercambio, opciones);
                salida.method = entrada.method;
            } catch (e) {
                salida = {
                    action: 'skipped',
                    reason: e.message,
                    ruta: caminoDeUrl(entrada.url),
                    method: entrada.method
                };
            }
        }

        resumen[salida.action] = (resumen[salida.action] || 0) + 1;
        resumen.results.push(salida);
    }

    resumen.examined = resultado.entries.length;
    resumen.unique = porClave.size;
    return resumen;
}

// ===== MODO GRABACIÓN =====

/**
 * Captura un intercambio vivo de una ruta proxy. Se llama con el búfer de la
 * respuesta todavía entero, así que aquí no hay recorte que valga.
 *
 * No espera al resultado quien la llama: la respuesta al cliente ya salió y un
 * fallo grabando no debe romper el proxy.
 */
async function grabarIntercambio(proxyConfig, datos) {
    const { method, url, status, headers, bodyBuffer } = datos;

    try {
        const texto = bodyBuffer && bodyBuffer.length ? bodyBuffer.toString('utf8') : '';
        const salida = await guardarComoMock({
            method,
            url,
            status,
            responseHeaders: headers,
            responseBody: texto,
            truncated: false
        }, {
            mode: proxyConfig.recordingMode || 'update',
            // Nace desactivado: si no, taparía al proxy y no habría más que grabar
            activo: false,
            summary: `Recorded from proxy ${proxyConfig.ruta}`
        });

        if (salida.action !== 'skipped') {
            console.log(`[REC] ${salida.action} ${method} ${salida.ruta} (ruta ${salida.id})`);
        }
        return salida;
    } catch (e) {
        console.error(`[REC] Error grabando ${method} ${url}: ${e.message}`);
        return { action: 'skipped', reason: e.message };
    }
}

module.exports = {
    intercambioAPayload,
    intercambioDesdeEntrada,
    guardarComoMock,
    desdeEntradaDeLog,
    desdeFiltrosDeLog,
    grabarIntercambio,
    tipoRespuestaDesdeContentType,
    cabecerasParaMock,
    caminoDeUrl,
    TAG_GRABADO,
    MODOS
};
