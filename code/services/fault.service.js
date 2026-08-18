/**
 * Fault Service
 *
 * Latencia y fallos provocados por ruta. Es la mitad del trabajo de un mock
 * server que hasta ahora faltaba: sin poder tardar ni fallar, no se pueden
 * probar timeouts, reintentos ni degradación, que es justo lo que rompe en
 * producción.
 *
 * La espera activa no cubre esto: es manual, hay que liberarla a mano y vale
 * para una petición. Esto es automático y se queda puesto.
 *
 * `aleatorio` se pasa por parámetro en vez de llamar a Math.random dentro. Un
 * porcentaje de fallos probado con azar de verdad daría una prueba que falla
 * una de cada veinte veces, que es peor que no tenerla.
 */

// Cómo se calcula el retardo
const MODOS_LATENCIA = ['none', 'fixed', 'random'];

// Qué se hace cuando toca fallar
const TIPOS_FALLO = ['error', 'reset', 'empty'];

// Techo de retardo: un mock que tarda más de un minuto no simula nada, solo
// deja peticiones colgadas y agota el pool de conexiones de quien llama
const RETARDO_MAXIMO_MS = 60000;

/**
 * Normaliza lo que hay en la fila a algo con lo que se pueda operar sin
 * comprobar nulos en cada paso
 */
function configuracion(row = {}) {
    const modo = MODOS_LATENCIA.includes(row.latency_mode) ? row.latency_mode : 'none';
    const tipo = TIPOS_FALLO.includes(row.fault_type) ? row.fault_type : 'error';

    const min = acotar(row.latency_ms, 0, RETARDO_MAXIMO_MS);
    const max = acotar(row.latency_max_ms, 0, RETARDO_MAXIMO_MS);

    return {
        modo,
        // En aleatorio, un mínimo mayor que el máximo es un error de quien lo
        // configuró; se ordenan en vez de devolver un rango imposible
        min: modo === 'random' ? Math.min(min, max) : min,
        max: modo === 'random' ? Math.max(min, max) : min,
        porcentajeFallo: acotar(row.fault_rate, 0, 100),
        tipoFallo: tipo,
        codigoFallo: String(row.fault_status || '500')
    };
}

function acotar(valor, minimo, maximo) {
    const n = parseInt(valor);
    if (isNaN(n)) return minimo;
    return Math.max(minimo, Math.min(maximo, n));
}

/**
 * Milisegundos que hay que esperar antes de responder
 */
function calcularRetardo(config, aleatorio = Math.random) {
    if (config.modo === 'fixed') return config.min;
    if (config.modo === 'random') {
        if (config.max <= config.min) return config.min;
        return config.min + Math.floor(aleatorio() * (config.max - config.min + 1));
    }
    return 0;
}

/**
 * Si esta petición concreta tiene que fallar.
 *
 * Se compara con `<` y no con `<=`: con 0% el azar puede devolver 0 y no debe
 * fallar nunca, y con 100% el azar nunca llega a 1 y debe fallar siempre.
 */
function tocaFallar(config, aleatorio = Math.random) {
    if (!config.porcentajeFallo) return false;
    return aleatorio() * 100 < config.porcentajeFallo;
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rompe la petición según el tipo configurado.
 *
 * Devuelve true si ya respondió (o cortó), para que quien llama sepa que no
 * tiene que seguir.
 */
function provocarFallo(config, res) {
    if (config.tipoFallo === 'reset') {
        // Cortar el socket a pelo es lo que ve el cliente cuando el servidor se
        // cae de verdad: ECONNRESET, no un código de estado educado
        if (res.socket) {
            res.socket.destroy();
        } else {
            res.destroy();
        }
        return true;
    }

    if (config.tipoFallo === 'empty') {
        // Responder sin cuerpo ni cabeceras útiles: el cliente se queda
        // esperando un JSON que no llega
        res.statusCode = Number(config.codigoFallo) || 500;
        res.end();
        return true;
    }

    res.statusCode = Number(config.codigoFallo) || 500;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Mock-Fault', 'injected');
    res.end(JSON.stringify({
        error: 'Injected fault',
        message: `This route is configured to fail ${config.porcentajeFallo}% of the time`,
        status: res.statusCode
    }));
    return true;
}

/**
 * ¿Hay algo configurado? Sirve para no anotar pasos de traza ni tocar el
 * camino de respuesta en la inmensa mayoría de rutas, que no usan esto.
 */
function estaActiva(config) {
    return config.modo !== 'none' || config.porcentajeFallo > 0;
}

module.exports = {
    configuracion,
    calcularRetardo,
    tocaFallar,
    provocarFallo,
    esperar,
    estaActiva,
    MODOS_LATENCIA,
    TIPOS_FALLO,
    RETARDO_MAXIMO_MS
};
