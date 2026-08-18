// El formato de SSE es más quisquilloso de lo que parece: un salto de línea
// suelto dentro de un dato corta el evento en dos, y la línea en blanco final
// es lo único que lo da por terminado. Eso es lo que se cubre aquí.

const sse = require('../../services/sse.service');

describe('sse.service: eventos en streaming', () => {

    describe('parsearEventos', () => {
        test('lee una lista de eventos', () => {
            const { ok, eventos } = sse.parsearEventos(
                '[{"event":"a","data":{"x":1}},{"data":"hola","delay":500}]');

            expect(ok).toBe(true);
            expect(eventos).toHaveLength(2);
            expect(eventos[0].event).toBe('a');
            expect(eventos[1].delay).toBe(500);
        });

        test('un evento suelto no hace falta envolverlo en un array', () => {
            const { ok, eventos } = sse.parsearEventos('{"data":"solo"}');
            expect(ok).toBe(true);
            expect(eventos).toHaveLength(1);
            expect(eventos[0].data).toBe('solo');
        });

        test('una lista de textos es la forma corta de un stream sencillo', () => {
            const { eventos } = sse.parsearEventos('["uno","dos","tres"]');
            expect(eventos.map(e => e.data)).toEqual(['uno', 'dos', 'tres']);
            // El primero sale ya; los demás se espacian solos
            expect(eventos[0].delay).toBe(0);
            expect(eventos[1].delay).toBe(1000);
        });

        test('sin eventos lo dice, en vez de abrir un stream vacío', () => {
            expect(sse.parsearEventos('').ok).toBe(false);
            expect(sse.parsearEventos('[]').ok).toBe(false);
        });

        test('el JSON roto se explica en vez de reventar', () => {
            const salida = sse.parsearEventos('[{roto}]');
            expect(salida.ok).toBe(false);
            expect(salida.error).toMatch(/JSON/);
        });

        test('acota el retardo para que el cliente no dé la conexión por muerta', () => {
            const { eventos } = sse.parsearEventos('[{"data":"x","delay":99999999}]');
            expect(eventos[0].delay).toBe(sse.MAX_RETARDO_MS);
        });

        test('un retardo negativo no viaja al pasado', () => {
            const { eventos } = sse.parsearEventos('[{"data":"x","delay":-500}]');
            expect(eventos[0].delay).toBe(0);
        });

        test('acepta el nombre del evento en español o en inglés', () => {
            const { eventos } = sse.parsearEventos('[{"evento":"progreso","data":1}]');
            expect(eventos[0].event).toBe('progreso');
        });
    });

    describe('formatearEvento', () => {
        test('un dato de texto sale en una línea data:', () => {
            expect(sse.formatearEvento({ data: 'hola' })).toBe('data: hola\n\n');
        });

        test('un objeto va en JSON', () => {
            expect(sse.formatearEvento({ data: { x: 1 } })).toBe('data: {"x":1}\n\n');
        });

        test('el nombre y el id van en sus propias líneas, antes del dato', () => {
            const salida = sse.formatearEvento({ event: 'progreso', id: '7', data: 'x' });
            expect(salida).toBe('event: progreso\nid: 7\ndata: x\n\n');
        });

        test('un texto con saltos se parte en varias líneas data:', () => {
            // Un salto suelto cortaría el evento por la mitad
            expect(sse.formatearEvento({ data: 'una\ndos' })).toBe('data: una\ndata: dos\n\n');
        });

        test('siempre acaba en línea en blanco, que es lo que cierra el evento', () => {
            expect(sse.formatearEvento({ data: 'x' }).endsWith('\n\n')).toBe(true);
            expect(sse.formatearEvento({ event: 'a', id: '1', retry: 5000, data: '' }).endsWith('\n\n')).toBe(true);
        });

        test('retry sale como su propia línea', () => {
            expect(sse.formatearEvento({ retry: 3000, data: 'x' })).toContain('retry: 3000\n');
        });

        test('un dato vacío sigue siendo un evento válido', () => {
            expect(sse.formatearEvento({ event: 'ping', data: '' })).toBe('event: ping\ndata: \n\n');
        });
    });

    describe('transmitir', () => {
        // Respuesta y petición de mentira, con lo justo que usa el servicio
        const dobles = () => {
            const escrito = [];
            const oyentes = {};
            const req = {
                headers: {},
                on(evento, fn) { oyentes[evento] = fn; },
                disparar(evento) { if (oyentes[evento]) oyentes[evento](); }
            };
            const res = {
                writableEnded: false,
                cabeceras: null,
                codigo: null,
                writeHead(codigo, cabeceras) { this.codigo = codigo; this.cabeceras = cabeceras; },
                write(texto) { escrito.push(texto); },
                end() { this.writableEnded = true; }
            };
            return { req, res, escrito };
        };

        test('abre el stream con las cabeceras del protocolo', () => {
            const { req, res } = dobles();
            sse.transmitir(req, res, { eventos: [{ data: 'x', delay: 0 }] });

            expect(res.codigo).toBe(200);
            expect(res.cabeceras['Content-Type']).toBe('text/event-stream');
            expect(res.cabeceras['Cache-Control']).toContain('no-cache');
            // Sin esto un proxy delante guarda el stream en un búfer y no llega nada
            expect(res.cabeceras['X-Accel-Buffering']).toBe('no');
        });

        test('manda los eventos y cierra al acabar', async () => {
            const { req, res, escrito } = dobles();
            const fin = new Promise(resolve => {
                sse.transmitir(req, res, {
                    eventos: [{ data: 'uno', delay: 0 }, { data: 'dos', delay: 10 }],
                    onEnd: resolve
                });
            });

            const resultado = await fin;
            expect(escrito).toEqual(['data: uno\n\n', 'data: dos\n\n']);
            expect(resultado.sent).toBe(2);
            expect(resultado.reason).toBe('completed');
            expect(res.writableEnded).toBe(true);
        });

        test('si el cliente se va, deja de escribir', async () => {
            const { req, res, escrito } = dobles();
            const fin = new Promise(resolve => {
                sse.transmitir(req, res, {
                    eventos: [{ data: 'uno', delay: 0 }, { data: 'dos', delay: 200 }],
                    onEnd: resolve
                });
            });

            // Cerrar antes de que salga el segundo
            await new Promise(r => setTimeout(r, 30));
            req.disparar('close');

            const resultado = await fin;
            expect(resultado.reason).toBe('client-closed');
            expect(escrito).toEqual(['data: uno\n\n']);

            // Y sigue sin escribir después: los temporizadores quedaron parados
            await new Promise(r => setTimeout(r, 250));
            expect(escrito).toHaveLength(1);
        });

        test('en bucle vuelve a empezar en vez de cerrar', async () => {
            const { req, res, escrito } = dobles();
            sse.transmitir(req, res, {
                eventos: [{ data: 'a', delay: 0 }, { data: 'b', delay: 0 }],
                loop: true
            });

            await new Promise(r => setTimeout(r, 40));
            req.disparar('close');

            // Con dos eventos y bucle, en 40 ms tienen que haber salido más de dos
            expect(escrito.length).toBeGreaterThan(2);
            expect(escrito[0]).toBe('data: a\n\n');
            expect(escrito[2]).toBe('data: a\n\n');
        });
    });
});
