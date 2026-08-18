// Lo que se prueba aquí es la elección del paso: qué toca en la llamada N con
// repeticiones de por medio, y qué pasa cuando la secuencia se acaba. Es la
// parte con aritmética, y donde un fallo de uno arriba o abajo no se ve.

const escenario = require('../../services/scenario.service');

const pasos = (...nombres) => nombres.map(n => (typeof n === 'string' ? { nombre: n } : n));

describe('scenario.service: escenarios con estado', () => {

    beforeEach(() => escenario.reiniciar());

    describe('contador de llamadas', () => {
        test('la primera llamada es la 1, no la 0', () => {
            expect(escenario.registrarLlamada(7)).toBe(1);
        });

        test('va sumando', () => {
            escenario.registrarLlamada(7);
            escenario.registrarLlamada(7);
            expect(escenario.registrarLlamada(7)).toBe(3);
        });

        test('cada ruta lleva su propia cuenta', () => {
            escenario.registrarLlamada(1);
            escenario.registrarLlamada(1);
            escenario.registrarLlamada(2);
            expect(escenario.llamadas(1)).toBe(2);
            expect(escenario.llamadas(2)).toBe(1);
        });

        test('una ruta sin llamadas va por cero', () => {
            expect(escenario.llamadas(99)).toBe(0);
        });

        test('reiniciar una ruta no toca a las demás', () => {
            escenario.registrarLlamada(1);
            escenario.registrarLlamada(2);
            escenario.reiniciar(1);
            expect(escenario.llamadas(1)).toBe(0);
            expect(escenario.llamadas(2)).toBe(1);
        });

        test('reiniciar sin ruta las borra todas', () => {
            escenario.registrarLlamada(1);
            escenario.registrarLlamada(2);
            escenario.reiniciar();
            expect(escenario.llamadas(1)).toBe(0);
            expect(escenario.llamadas(2)).toBe(0);
        });

        test('el estado enseña lo que hay en marcha', () => {
            escenario.registrarLlamada(5);
            escenario.registrarLlamada(5);
            expect(escenario.estado()).toEqual([{ route_id: 5, calls: 2 }]);
        });
    });

    describe('pasoParaLlamada', () => {
        const tres = pasos('pending', 'processing', 'done');

        test('cada llamada avanza un paso', () => {
            expect(escenario.pasoParaLlamada(tres, 1).paso.nombre).toBe('pending');
            expect(escenario.pasoParaLlamada(tres, 2).paso.nombre).toBe('processing');
            expect(escenario.pasoParaLlamada(tres, 3).paso.nombre).toBe('done');
        });

        test('informa de la posición contando desde cero y del total', () => {
            const elegido = escenario.pasoParaLlamada(tres, 2);
            expect(elegido.posicion).toBe(1);
            expect(elegido.total).toBe(3);
            expect(elegido.agotada).toBe(false);
        });

        test('sin pasos no hay nada que elegir', () => {
            expect(escenario.pasoParaLlamada([], 1)).toBeNull();
            expect(escenario.pasoParaLlamada(null, 1)).toBeNull();
        });

        test('una llamada 0 o negativa no se sale por abajo', () => {
            expect(escenario.pasoParaLlamada(tres, 0).paso.nombre).toBe('pending');
            expect(escenario.pasoParaLlamada(tres, -5).paso.nombre).toBe('pending');
        });
    });

    describe('al agotarse la secuencia', () => {
        const tres = pasos('pending', 'processing', 'done');

        test('en modo stick se queda en el último', () => {
            expect(escenario.pasoParaLlamada(tres, 4, 'stick').paso.nombre).toBe('done');
            expect(escenario.pasoParaLlamada(tres, 40, 'stick').paso.nombre).toBe('done');
        });

        test('stick avisa de que la secuencia ya se agotó', () => {
            expect(escenario.pasoParaLlamada(tres, 3, 'stick').agotada).toBe(false);
            expect(escenario.pasoParaLlamada(tres, 4, 'stick').agotada).toBe(true);
        });

        test('en modo loop vuelve al principio', () => {
            expect(escenario.pasoParaLlamada(tres, 4, 'loop').paso.nombre).toBe('pending');
            expect(escenario.pasoParaLlamada(tres, 5, 'loop').paso.nombre).toBe('processing');
            expect(escenario.pasoParaLlamada(tres, 7, 'loop').paso.nombre).toBe('pending');
        });

        test('stick es lo que se hace si no se dice otra cosa', () => {
            expect(escenario.pasoParaLlamada(tres, 9).paso.nombre).toBe('done');
        });
    });

    describe('pasos que duran varias llamadas', () => {
        const conRepeticiones = [
            { nombre: 'pending', repeticiones: 1 },
            { nombre: 'processing', repeticiones: 3 },
            { nombre: 'done', repeticiones: 1 }
        ];

        test('el paso se mantiene tantas llamadas como diga', () => {
            expect(escenario.pasoParaLlamada(conRepeticiones, 1).paso.nombre).toBe('pending');
            expect(escenario.pasoParaLlamada(conRepeticiones, 2).paso.nombre).toBe('processing');
            expect(escenario.pasoParaLlamada(conRepeticiones, 3).paso.nombre).toBe('processing');
            expect(escenario.pasoParaLlamada(conRepeticiones, 4).paso.nombre).toBe('processing');
            expect(escenario.pasoParaLlamada(conRepeticiones, 5).paso.nombre).toBe('done');
        });

        test('la posición que informa es la del paso, no la de la llamada', () => {
            expect(escenario.pasoParaLlamada(conRepeticiones, 3).posicion).toBe(1);
            expect(escenario.pasoParaLlamada(conRepeticiones, 3).total).toBe(3);
        });

        test('el bucle cuenta las repeticiones, no los pasos', () => {
            // 5 llamadas cubren la secuencia entera; la sexta vuelve al principio
            expect(escenario.pasoParaLlamada(conRepeticiones, 6, 'loop').paso.nombre).toBe('pending');
            expect(escenario.pasoParaLlamada(conRepeticiones, 7, 'loop').paso.nombre).toBe('processing');
        });

        test('repeticiones raras se tratan como una', () => {
            const raro = [{ nombre: 'a', repeticiones: 0 }, { nombre: 'b', repeticiones: 'muchas' }];
            expect(escenario.pasoParaLlamada(raro, 1).paso.nombre).toBe('a');
            expect(escenario.pasoParaLlamada(raro, 2).paso.nombre).toBe('b');
        });
    });
});
