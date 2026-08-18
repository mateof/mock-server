/**
 * Scenario Service
 *
 * Escenarios con estado: que una ruta responda distinto según la vez que se
 * llame. Primera `pending`, segunda `processing`, tercera `done`.
 *
 * Es lo que hace falta para simular flujos con sondeo, que es justo donde más
 * duele no tener mocks: las condiciones solo miran la petición, y en un sondeo
 * todas las peticiones son idénticas.
 *
 * ## El contador vive en memoria
 *
 * A propósito. Un escenario es un concepto de sesión de pruebas, no
 * configuración: al reiniciar el servidor se empieza de cero, que es lo que se
 * espera. Guardarlo en la base de datos obligaría a acordarse de reiniciarlo a
 * mano cada vez, y a escribir en disco en cada petición.
 *
 * Va con el proceso: si algún día esto corre en varias instancias, cada una
 * llevaría su cuenta. Con un único proceso, que es como se despliega, no hay
 * diferencia observable.
 */

// route_id -> número de llamadas atendidas
const contadores = new Map();

/**
 * Suma una llamada y devuelve cuántas van, empezando por 1.
 *
 * Se llama una vez por petición atendida, no una por consulta: el número tiene
 * que ser el mismo durante toda la petición, o la condición y la plantilla
 * verían cosas distintas.
 */
function registrarLlamada(routeId) {
    const id = Number(routeId);
    const total = (contadores.get(id) || 0) + 1;
    contadores.set(id, total);
    return total;
}

function llamadas(routeId) {
    return contadores.get(Number(routeId)) || 0;
}

function reiniciar(routeId) {
    if (routeId === undefined || routeId === null) {
        const total = contadores.size;
        contadores.clear();
        return total;
    }
    const id = Number(routeId);
    const habia = contadores.has(id);
    contadores.delete(id);
    return habia ? 1 : 0;
}

/**
 * Estado de todos los escenarios en marcha, para enseñarlo en el panel
 */
function estado() {
    return Array.from(contadores.entries()).map(([routeId, calls]) => ({ route_id: routeId, calls }));
}

/**
 * Qué paso toca en esta llamada.
 *
 * Cada paso puede durar varias llamadas (`repeticiones`), que es lo que permite
 * un "processing" que se repite tres veces sin escribirlo tres veces.
 *
 * @param {Array} pasos   pasos activos, en orden
 * @param {number} numero número de llamada, empezando por 1
 * @param {string} modo   'stick' repite el último, 'loop' vuelve al principio
 * @returns {object|null} el paso, con su posición, o null si no hay pasos
 */
function pasoParaLlamada(pasos, numero, modo = 'stick') {
    if (!Array.isArray(pasos) || pasos.length === 0) return null;

    // Cada paso ocupa tantas posiciones como repeticiones tenga
    const tramos = [];
    for (let i = 0; i < pasos.length; i++) {
        const veces = Math.max(1, parseInt(pasos[i].repeticiones) || 1);
        for (let r = 0; r < veces; r++) tramos.push(i);
    }

    const indice = Math.max(0, numero - 1);

    if (indice < tramos.length) {
        const posicion = tramos[indice];
        return { paso: pasos[posicion], posicion, total: pasos.length, agotada: false };
    }

    if (modo === 'loop') {
        const posicion = tramos[indice % tramos.length];
        return { paso: pasos[posicion], posicion, total: pasos.length, agotada: false };
    }

    // 'stick': a partir de aquí se repite el último, que es lo que deja un
    // flujo terminado en su estado final en vez de volver a empezar solo
    const posicion = tramos[tramos.length - 1];
    return { paso: pasos[posicion], posicion, total: pasos.length, agotada: true };
}

module.exports = {
    registrarLlamada,
    llamadas,
    reiniciar,
    estado,
    pasoParaLlamada
};
