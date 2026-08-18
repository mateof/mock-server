/**
 * SSE Service
 *
 * Respuestas `text/event-stream`. Ya había WebSocket completo y esto no, y hoy
 * se usa para notificaciones y para el streaming de los modelos de lenguaje.
 *
 * La mecánica es la de los mensajes periódicos del WebSocket, pero por HTTP: se
 * abre la respuesta, se van escribiendo eventos con su retardo y no se cierra
 * hasta que se acaban o hasta que el cliente se va.
 *
 * ## Lo que se configura
 *
 * El cuerpo de la ruta es la lista de eventos, en JSON:
 *
 *   [
 *     { "data": { "estado": "pending" } },
 *     { "event": "progreso", "data": { "porcentaje": 50 }, "delay": 1000 },
 *     { "event": "fin", "data": "listo", "delay": 1000 }
 *   ]
 *
 * `delay` es lo que se espera ANTES de mandar ese evento, así que el primero
 * con delay 0 sale de inmediato.
 */

// Tope de eventos por respuesta, para que un bucle mal puesto no deje una
// conexión escribiendo para siempre contra un cliente que ya no mira
const MAX_EVENTOS = 10000;

// Retardo máximo entre eventos: más allá, el cliente da la conexión por muerta
const MAX_RETARDO_MS = 300000;

/**
 * Interpreta la lista de eventos. Devuelve `{ ok, eventos, error }` en vez de
 * lanzar: una ruta mal configurada tiene que poder decir por qué.
 */
function parsearEventos(texto) {
    if (!texto || !String(texto).trim()) {
        return { ok: false, error: 'La ruta SSE no tiene eventos configurados' };
    }

    let crudo;
    try {
        crudo = JSON.parse(texto);
    } catch (e) {
        return { ok: false, error: `Los eventos SSE no son JSON válido: ${e.message}` };
    }

    // Un solo evento suelto también vale, sin obligar a envolverlo en un array
    const lista = Array.isArray(crudo) ? crudo : [crudo];
    if (lista.length === 0) {
        return { ok: false, error: 'La lista de eventos SSE está vacía' };
    }

    const eventos = lista.slice(0, MAX_EVENTOS).map((e, i) => {
        // Una entrada que no es objeto se toma como el dato en sí: una lista de
        // textos es la forma más corta de escribir un stream sencillo
        if (e === null || typeof e !== 'object' || Array.isArray(e)) {
            return { data: e, delay: i === 0 ? 0 : 1000 };
        }
        return {
            event: e.event || e.evento || null,
            id: e.id === undefined ? null : String(e.id),
            retry: e.retry === undefined ? null : parseInt(e.retry),
            data: e.data === undefined ? '' : e.data,
            delay: Math.max(0, Math.min(MAX_RETARDO_MS, parseInt(e.delay) || 0))
        };
    });

    return { ok: true, eventos };
}

/**
 * Da formato a un evento según el protocolo. Los objetos van en JSON, y el
 * texto con saltos de línea se parte en varias líneas `data:`, que es lo que
 * manda la especificación: un salto suelto cortaría el evento.
 */
function formatearEvento(evento) {
    const lineas = [];

    if (evento.event) lineas.push(`event: ${evento.event}`);
    if (evento.id) lineas.push(`id: ${evento.id}`);
    if (evento.retry) lineas.push(`retry: ${evento.retry}`);

    const texto = typeof evento.data === 'string' ? evento.data : JSON.stringify(evento.data);
    for (const linea of String(texto === undefined ? '' : texto).split('\n')) {
        lineas.push(`data: ${linea}`);
    }

    // La línea en blanco del final es lo que cierra el evento
    return lineas.join('\n') + '\n\n';
}

/**
 * Abre el stream y va mandando los eventos.
 *
 * @param {object} opciones  eventos, loop, onEvent, onEnd
 * @returns {function} para cortarlo desde fuera
 */
function transmitir(req, res, opciones = {}) {
    const eventos = opciones.eventos || [];
    const enBucle = !!opciones.loop;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        // Sin esto, nginx y compañía guardan el stream en un búfer y no llega
        // nada hasta que se cierra, que es justo lo contrario de lo que se quiere
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': req.headers.origin || '*'
    });
    if (res.flushHeaders) res.flushHeaders();

    let indice = 0;
    let enviados = 0;
    let temporizador = null;
    let cerrado = false;

    const cerrar = (motivo) => {
        if (cerrado) return;
        cerrado = true;
        if (temporizador) clearTimeout(temporizador);
        if (!res.writableEnded) res.end();
        if (opciones.onEnd) opciones.onEnd({ sent: enviados, reason: motivo });
    };

    const siguiente = () => {
        if (cerrado) return;

        if (indice >= eventos.length) {
            if (!enBucle) return cerrar('completed');
            indice = 0;
        }

        // Sin tope, un bucle deja la conexión escribiendo para siempre
        if (enviados >= MAX_EVENTOS) return cerrar('limit');

        const evento = eventos[indice++];
        temporizador = setTimeout(() => {
            if (cerrado || res.writableEnded) return;
            try {
                res.write(formatearEvento(evento));
                enviados++;
                if (opciones.onEvent) opciones.onEvent(evento, enviados);
            } catch (e) {
                return cerrar('error');
            }
            siguiente();
        }, evento.delay || 0);

        // No debe impedir que el proceso termine
        if (temporizador.unref) temporizador.unref();
    };

    // Si el cliente se va hay que parar los temporizadores, o seguirían
    // disparando contra una respuesta muerta hasta agotar la lista
    req.on('close', () => cerrar('client-closed'));
    req.on('aborted', () => cerrar('client-aborted'));

    siguiente();

    return cerrar;
}

module.exports = {
    parsearEventos,
    formatearEvento,
    transmitir,
    MAX_EVENTOS,
    MAX_RETARDO_MS
};
