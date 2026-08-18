/**
 * Trace Context
 *
 * Guarda el identificador de traza de la petición que se está atendiendo, para
 * que cualquier línea de log que se escriba durante ella quede asociada sin
 * tener que pasar el id por parámetro a través de media aplicación.
 *
 * Usa AsyncLocalStorage, que mantiene el contexto a través de promesas y
 * callbacks. Va en un módulo propio y sin dependencias a propósito: lo
 * necesitan tanto log.service como trace.service, y si viviera en cualquiera
 * de los dos habría una dependencia circular entre ellos.
 */

const { AsyncLocalStorage } = require('async_hooks');

const almacen = new AsyncLocalStorage();

function run(contexto, fn) {
    return almacen.run(contexto, fn);
}

function actual() {
    return almacen.getStore() || null;
}

function traceId() {
    const contexto = actual();
    return contexto ? contexto.traceId : null;
}

/**
 * Ruta que está atendiendo la petición, si ya se sabe cuál es
 */
function routeId() {
    const contexto = actual();
    return contexto && contexto.routeId ? contexto.routeId : null;
}

/**
 * Número de orden dentro de la traza. Los pasos se emiten en el mismo
 * milisegundo con frecuencia, así que ordenar por tiempo no basta.
 */
function siguienteOrden() {
    const contexto = actual();
    if (!contexto) return null;
    contexto.seq = (contexto.seq || 0) + 1;
    return contexto.seq;
}

module.exports = { run, actual, traceId, routeId, siguienteOrden };
