// La latencia y los fallos se prueban con azar controlado. Con Math.random de
// verdad, un "20% de fallos" daría una prueba que falla una de cada cinco
// ejecuciones, y una prueba así se acaba borrando en vez de arreglando.

const fault = require('../../services/fault.service');

// Devuelve siempre el mismo valor, para poder situarse a un lado u otro del umbral
const azar = (valor) => () => valor;

describe('fault.service: latencia y fallos provocados', () => {

    describe('configuracion', () => {
        test('una ruta sin nada configurado no hace nada', () => {
            const c = fault.configuracion({});
            expect(c.modo).toBe('none');
            expect(c.porcentajeFallo).toBe(0);
            expect(fault.estaActiva(c)).toBe(false);
        });

        test('rechaza modos y tipos que no existen en vez de propagarlos', () => {
            const c = fault.configuracion({ latency_mode: 'lentísimo', fault_type: 'explotar' });
            expect(c.modo).toBe('none');
            expect(c.tipoFallo).toBe('error');
        });

        test('acota el porcentaje al rango que tiene sentido', () => {
            expect(fault.configuracion({ fault_rate: 300 }).porcentajeFallo).toBe(100);
            expect(fault.configuracion({ fault_rate: -50 }).porcentajeFallo).toBe(0);
        });

        test('pone techo al retardo: una ruta colgada para siempre no simula nada', () => {
            const c = fault.configuracion({ latency_mode: 'fixed', latency_ms: 999999999 });
            expect(c.min).toBe(fault.RETARDO_MAXIMO_MS);
        });

        test('ordena el rango si lo configuraron al revés', () => {
            const c = fault.configuracion({ latency_mode: 'random', latency_ms: 900, latency_max_ms: 100 });
            expect(c.min).toBe(100);
            expect(c.max).toBe(900);
        });

        test('tolera basura donde debería haber números', () => {
            const c = fault.configuracion({ latency_ms: 'mucho', fault_rate: null });
            expect(c.min).toBe(0);
            expect(c.porcentajeFallo).toBe(0);
        });

        test('estaActiva detecta que hay algo puesto', () => {
            expect(fault.estaActiva(fault.configuracion({ latency_mode: 'fixed', latency_ms: 100 }))).toBe(true);
            expect(fault.estaActiva(fault.configuracion({ fault_rate: 5 }))).toBe(true);
            expect(fault.estaActiva(fault.configuracion({ latency_mode: 'none', fault_rate: 0 }))).toBe(false);
        });
    });

    describe('calcularRetardo', () => {
        test('el modo fijo devuelve siempre lo mismo', () => {
            const c = fault.configuracion({ latency_mode: 'fixed', latency_ms: 250 });
            expect(fault.calcularRetardo(c, azar(0))).toBe(250);
            expect(fault.calcularRetardo(c, azar(0.99))).toBe(250);
        });

        test('sin latencia no se espera nada', () => {
            expect(fault.calcularRetardo(fault.configuracion({ latency_ms: 500 }), azar(0.5))).toBe(0);
        });

        test('el modo aleatorio se queda dentro del rango, extremos incluidos', () => {
            const c = fault.configuracion({ latency_mode: 'random', latency_ms: 100, latency_max_ms: 200 });
            expect(fault.calcularRetardo(c, azar(0))).toBe(100);
            expect(fault.calcularRetardo(c, azar(0.999999))).toBe(200);
            expect(fault.calcularRetardo(c, azar(0.5))).toBeGreaterThanOrEqual(100);
            expect(fault.calcularRetardo(c, azar(0.5))).toBeLessThanOrEqual(200);
        });

        test('un rango de un solo valor no se va de madre', () => {
            const c = fault.configuracion({ latency_mode: 'random', latency_ms: 300, latency_max_ms: 300 });
            expect(fault.calcularRetardo(c, azar(0.9))).toBe(300);
        });
    });

    describe('tocaFallar', () => {
        test('con 0% no falla nunca, ni con el azar en su valor más bajo', () => {
            const c = fault.configuracion({ fault_rate: 0 });
            expect(fault.tocaFallar(c, azar(0))).toBe(false);
        });

        test('con 100% falla siempre, incluso con el azar casi en el tope', () => {
            const c = fault.configuracion({ fault_rate: 100 });
            expect(fault.tocaFallar(c, azar(0.999999))).toBe(true);
        });

        test('el umbral cae donde debe', () => {
            const c = fault.configuracion({ fault_rate: 30 });
            expect(fault.tocaFallar(c, azar(0.29))).toBe(true);
            expect(fault.tocaFallar(c, azar(0.30))).toBe(false);
            expect(fault.tocaFallar(c, azar(0.31))).toBe(false);
        });
    });

    describe('provocarFallo', () => {
        const respuestaFalsa = () => {
            const res = {
                statusCode: 200,
                headers: {},
                terminada: false,
                cuerpo: null,
                socket: { destruido: false, destroy() { this.destruido = true; } },
                setHeader(n, v) { this.headers[n] = v; },
                end(c) { this.terminada = true; this.cuerpo = c; }
            };
            return res;
        };

        test('el tipo error responde el código configurado y lo deja marcado', () => {
            const res = respuestaFalsa();
            fault.provocarFallo(fault.configuracion({ fault_rate: 100, fault_status: '503' }), res);

            expect(res.statusCode).toBe(503);
            expect(res.headers['X-Mock-Fault']).toBe('injected');
            expect(JSON.parse(res.cuerpo).status).toBe(503);
        });

        test('el tipo reset corta el socket: es lo que ve un cliente cuando el servidor se cae', () => {
            const res = respuestaFalsa();
            fault.provocarFallo(fault.configuracion({ fault_rate: 100, fault_type: 'reset' }), res);

            expect(res.socket.destruido).toBe(true);
            // Sin código ni cuerpo: no hay respuesta HTTP que valga
            expect(res.terminada).toBe(false);
        });

        test('el tipo empty responde el código sin cuerpo', () => {
            const res = respuestaFalsa();
            fault.provocarFallo(fault.configuracion({ fault_rate: 100, fault_type: 'empty', fault_status: '502' }), res);

            expect(res.statusCode).toBe(502);
            expect(res.terminada).toBe(true);
            expect(res.cuerpo).toBeUndefined();
        });

        test('un código de fallo sin sentido cae en 500 en vez de responder NaN', () => {
            const res = respuestaFalsa();
            fault.provocarFallo(fault.configuracion({ fault_rate: 100, fault_status: 'ochocientos' }), res);
            expect(res.statusCode).toBe(500);
        });
    });

    describe('esperar', () => {
        test('espera de verdad antes de resolver', async () => {
            const antes = Date.now();
            await fault.esperar(60);
            expect(Date.now() - antes).toBeGreaterThanOrEqual(50);
        });
    });
});
