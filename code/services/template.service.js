/**
 * Template Service
 *
 * Respuestas dinámicas: que el cuerpo pueda hacer eco de la petición, meter
 * fechas relativas o valores aleatorios. Un mock que siempre devuelve el mismo
 * id se nota a la legua y rompe cualquier prueba que encadene llamadas.
 *
 * Va **desactivado salvo que se pida**, con una casilla por ruta. Es lo único
 * que se puede hacer sin romper lo que ya hay: una respuesta puede contener
 * `{{...}}` de forma legítima (una plantilla de Handlebars, un ejemplo de
 * documentación), y sustituirlo por sorpresa en rutas que llevan años
 * funcionando sería una trampa.
 *
 * ## Sintaxis
 *
 *   {{body.usuario.id}}        un dato de la petición
 *   {{uuid()}}                 un generador
 *   {{body.nombre ?? "anónimo"}}   valor por defecto si falta
 *
 * ## Comillas y JSON
 *
 * La regla es la del propio JSON: **si quieres un texto, pon las comillas**.
 *
 *   {"nombre": "{{body.nombre}}"}   ->  {"nombre": "Ana"}
 *   {"id": {{body.id}}}             ->  {"id": 42}
 *   {"tags": {{body.tags}}}         ->  {"tags": ["a","b"]}
 *
 * Dentro de comillas el valor se escapa como texto JSON, así que un nombre con
 * comillas o saltos de línea no rompe la respuesta. Fuera de comillas se
 * inserta su JSON, que es lo que hace que un número entre como número y un
 * array como array.
 */

const crypto = require('crypto');

// Cuánto se permite que crezca una plantilla, para que un dato de entrada
// enorme no acabe siendo una respuesta de cientos de megas
const MAX_SALIDA = 1024 * 1024;

const PATRON = /\{\{([^{}]+)\}\}/g;

// ===== GENERADORES =====

const GENERADORES = {
    uuid: () => crypto.randomUUID(),

    timestamp: () => Date.now(),

    /**
     * Fecha en ISO, opcionalmente desplazada: now('+1d'), now('-2h')
     */
    now: (desplazamiento) => {
        const fecha = new Date(Date.now() + desplazamientoAMs(desplazamiento));
        return fecha.toISOString();
    },

    /**
     * Solo la fecha, sin hora: date(), date('+7d')
     */
    date: (desplazamiento) => {
        const fecha = new Date(Date.now() + desplazamientoAMs(desplazamiento));
        return fecha.toISOString().split('T')[0];
    },

    randomInt: (min = 0, max = 100) => {
        const a = Math.ceil(Number(min));
        const b = Math.floor(Number(max));
        if (isNaN(a) || isNaN(b) || b < a) return a || 0;
        return a + Math.floor(Math.random() * (b - a + 1));
    },

    randomFloat: (min = 0, max = 1, decimales = 2) => {
        const a = Number(min), b = Number(max);
        if (isNaN(a) || isNaN(b)) return 0;
        const valor = a + Math.random() * (b - a);
        return Number(valor.toFixed(Math.max(0, Math.min(10, Number(decimales) || 0))));
    },

    randomString: (longitud = 8) => {
        const n = Math.max(1, Math.min(4096, Number(longitud) || 8));
        return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').substring(0, n);
    },

    randomBool: () => Math.random() < 0.5,

    /**
     * Uno de los valores dados: pick('alta','media','baja')
     */
    pick: (...opciones) => {
        if (!opciones.length) return '';
        return opciones[Math.floor(Math.random() * opciones.length)];
    },

    // Conversiones. La query y los params llegan siempre como texto, así que
    // sin esto no hay forma de que un `?page=5` entre en el JSON como número
    number: (valor) => {
        const n = Number(valor);
        return isNaN(n) ? null : n;
    },

    string: (valor) => (valor === undefined || valor === null) ? '' : String(valor),

    bool: (valor) => {
        if (typeof valor === 'boolean') return valor;
        const t = String(valor).trim().toLowerCase();
        return t === 'true' || t === '1' || t === 'yes' || t === 'si' || t === 'sí';
    },

    // Cuenta los elementos de un array, las claves de un objeto o las letras
    length: (valor) => {
        if (valor === undefined || valor === null) return 0;
        if (Array.isArray(valor) || typeof valor === 'string') return valor.length;
        if (typeof valor === 'object') return Object.keys(valor).length;
        return 0;
    }
};

/**
 * '+1d', '-2h', '30m'... a milisegundos. Sin sufijo se entienden días, que es
 * lo que se pide el noventa por ciento de las veces.
 */
function desplazamientoAMs(texto) {
    if (!texto) return 0;

    const m = String(texto).trim().match(/^([+-]?\d+(?:\.\d+)?)\s*([a-z]*)$/i);
    if (!m) return 0;

    const cantidad = parseFloat(m[1]);
    const unidades = {
        ms: 1,
        s: 1000,
        m: 60000,
        h: 3600000,
        d: 86400000,
        w: 604800000
    };
    const factor = unidades[(m[2] || 'd').toLowerCase()];
    return factor ? cantidad * factor : 0;
}

// ===== RESOLUCIÓN =====

/**
 * Recorre un camino con puntos. Los nombres con guiones o puntos raros se
 * escriben entre corchetes: headers['x-request-id']
 */
function leerCamino(contexto, camino) {
    const partes = camino
        .replace(/\[(['"]?)([^\]]+?)\1\]/g, '.$2')
        .split('.')
        .map(p => p.trim())
        .filter(p => p !== '');

    let valor = contexto;
    for (const parte of partes) {
        if (valor === null || valor === undefined) return undefined;
        // Las cabeceras llegan siempre en minúscula; buscarlas tal cual se
        // escribieron ahorra una sorpresa muy común
        if (typeof valor === 'object' && !(parte in valor)) {
            const enMinuscula = Object.keys(valor).find(k => k.toLowerCase() === parte.toLowerCase());
            if (enMinuscula === undefined) return undefined;
            valor = valor[enMinuscula];
            continue;
        }
        valor = valor[parte];
    }
    return valor;
}

/**
 * Trocea los argumentos de un generador respetando las comillas, para que
 * pick('a,b', 'c') sean dos opciones y no tres
 */
function trocearArgumentos(texto, conservarComillas = false) {
    if (!texto || !texto.trim()) return [];

    const argumentos = [];
    let actual = '';
    let comilla = null;
    // Los paréntesis se cuentan para no partir por la coma de una llamada
    // anidada: string(randomInt(5,9)) es un argumento, no dos
    let profundidad = 0;

    for (const caracter of texto) {
        if (comilla) {
            if (caracter === comilla) {
                comilla = null;
                // El resolutor necesita las comillas para distinguir un literal
                // de un camino: 'alta' es texto, body.alta es un dato
                if (conservarComillas) actual += caracter;
            } else {
                actual += caracter;
            }
        } else if (caracter === "'" || caracter === '"') {
            comilla = caracter;
            if (conservarComillas) actual += caracter;
        } else if (caracter === '(') {
            profundidad++;
            actual += caracter;
        } else if (caracter === ')') {
            profundidad--;
            actual += caracter;
        } else if (caracter === ',' && profundidad === 0) {
            argumentos.push(actual.trim());
            actual = '';
        } else {
            actual += caracter;
        }
    }
    argumentos.push(actual.trim());

    return argumentos.map(a => a === '' ? undefined : a);
}

/**
 * Resuelve una expresión: un generador, un camino, o un literal entre comillas
 */
function resolverExpresion(expresion, contexto) {
    const limpia = expresion.trim();

    // Literal entre comillas: lo que se usa en la parte derecha de ??
    const literal = limpia.match(/^(['"])(.*)\1$/s);
    if (literal) return literal[2];

    // Generador con o sin paréntesis: uuid, uuid(), randomInt(1,10)
    const llamada = limpia.match(/^([a-zA-Z_][\w]*)\s*(?:\((.*)\))?$/s);
    if (llamada && GENERADORES[llamada[1]]) {
        try {
            // Los argumentos se resuelven igual que cualquier otra expresión,
            // que es lo que permite anidar: number(query.page), pick(body.a,'b')
            const argumentos = trocearArgumentos(llamada[2], true)
                .map(a => a === undefined ? undefined : resolverExpresion(a, contexto));
            return GENERADORES[llamada[1]](...argumentos);
        } catch (e) {
            return undefined;
        }
    }

    // Número suelto, para el lado derecho de ??
    if (/^-?\d+(\.\d+)?$/.test(limpia)) return Number(limpia);
    if (limpia === 'true') return true;
    if (limpia === 'false') return false;
    if (limpia === 'null') return null;

    return leerCamino(contexto, limpia);
}

/**
 * Una expresión completa, con su valor por defecto si lo lleva
 */
function resolver(expresion, contexto) {
    const partes = expresion.split('??');
    const valor = resolverExpresion(partes[0], contexto);

    // Vacío cuenta como ausente: `{{query.page ?? 1}}` con ?page= debe dar 1,
    // no una cadena vacía que rompa el JSON
    const falta = valor === undefined || valor === null || valor === '';
    if (falta && partes.length > 1) {
        return resolverExpresion(partes.slice(1).join('??'), contexto);
    }
    return valor;
}

// ===== SUSTITUCIÓN =====

/**
 * Marca qué posiciones del texto caen dentro de una cadena JSON.
 *
 * Es lo que permite escapar el valor cuando va entre comillas y meter su JSON
 * cuando no. Se cuentan las barras invertidas seguidas para no confundir una
 * comilla escapada (\") con el final de la cadena, ni con una barra escapada
 * (\\) seguida de comilla que sí lo es.
 */
function posicionesDentroDeCadena(texto) {
    const dentro = new Array(texto.length).fill(false);
    let enCadena = false;

    for (let i = 0; i < texto.length; i++) {
        const c = texto[i];
        if (c === '"') {
            let barras = 0;
            for (let j = i - 1; j >= 0 && texto[j] === '\\'; j--) barras++;
            if (barras % 2 === 0) enCadena = !enCadena;
        }
        dentro[i] = enCadena;
    }
    return dentro;
}

function comoTextoPlano(valor) {
    if (valor === undefined || valor === null) return '';
    if (typeof valor === 'object') {
        try { return JSON.stringify(valor); } catch (e) { return ''; }
    }
    return String(valor);
}

/**
 * Aplica la plantilla.
 *
 * @param {string} plantilla
 * @param {object} contexto  body, query, params, headers, method, path, url
 * @param {object} opciones  json: escapar y serializar según el contexto JSON
 */
function render(plantilla, contexto = {}, opciones = {}) {
    if (!plantilla || typeof plantilla !== 'string' || plantilla.indexOf('{{') === -1) {
        return plantilla;
    }

    const esJson = !!opciones.json;
    const dentro = esJson ? posicionesDentroDeCadena(plantilla) : null;

    let resultado = '';
    let ultimo = 0;
    let coincidencia;

    PATRON.lastIndex = 0;
    while ((coincidencia = PATRON.exec(plantilla)) !== null) {
        const valor = resolver(coincidencia[1], contexto);
        let texto;

        if (esJson && !dentro[coincidencia.index]) {
            // Fuera de comillas: su JSON, para que un número entre como número
            texto = valor === undefined ? 'null' : JSON.stringify(valor);
        } else if (esJson) {
            // Dentro de comillas: escapado, sin las comillas exteriores
            const plano = comoTextoPlano(valor);
            texto = JSON.stringify(plano).slice(1, -1);
        } else {
            texto = comoTextoPlano(valor);
        }

        resultado += plantilla.slice(ultimo, coincidencia.index) + texto;
        ultimo = coincidencia.index + coincidencia[0].length;

        if (resultado.length > MAX_SALIDA) {
            console.log('[TPL] Plantilla descartada por tamaño');
            return plantilla;
        }
    }

    return resultado + plantilla.slice(ultimo);
}

/**
 * Contexto a partir de la petición. Se construye una sola vez por petición
 * aunque se rendericen cuerpo y cabeceras.
 */
function contextoDePeticion(req, params = {}) {
    return {
        body: req.body || {},
        query: req.query || {},
        params: params || {},
        headers: req.headers || {},
        method: (req.method || '').toLowerCase(),
        path: (req.path || req.url || '').split('?')[0],
        url: req.originalUrl || req.url || ''
    };
}

/**
 * ¿Merece la pena montar el contexto? Evita trabajo en la inmensa mayoría de
 * respuestas, que no llevan ninguna plantilla.
 */
function tienePlantilla(texto) {
    return typeof texto === 'string' && texto.indexOf('{{') !== -1;
}

module.exports = {
    render,
    contextoDePeticion,
    tienePlantilla,
    resolver,
    desplazamientoAMs,
    posicionesDentroDeCadena,
    GENERADORES,
    MAX_SALIDA
};
