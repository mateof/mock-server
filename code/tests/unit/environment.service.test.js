// La sustitución de variables se prueba aquí; lo que toca base de datos se
// cubre desde fuera, con dos backends de verdad y cambiando de entorno en
// caliente. Lo importante de esta parte es la regla de qué se sustituye y qué
// se respeta, que es la que evita destrozar respuestas ajenas.

const env = require('../../services/environment.service');

const vars = { BACKEND_URL: 'http://api.local', API_KEY: 'abc123', VACIA: '' };
const sustituir = (texto) => env.sustituir(texto, vars);

describe('environment.service: variables de entorno', () => {

    describe('sustituir', () => {
        test('cambia lo que está definido', () => {
            expect(sustituir('${BACKEND_URL}/v3').texto).toBe('http://api.local/v3');
        });

        test('cambia varias en el mismo texto', () => {
            const r = sustituir('{"url":"${BACKEND_URL}","key":"${API_KEY}"}');
            expect(r.texto).toBe('{"url":"http://api.local","key":"abc123"}');
        });

        test('la misma variable repetida se cambia en todas partes', () => {
            expect(sustituir('${API_KEY}-${API_KEY}').texto).toBe('abc123-abc123');
        });

        test('una variable definida como vacía sí se sustituye', () => {
            // Distinto de no estar: si la defines vacía, es que la quieres vacía
            const r = sustituir('[${VACIA}]');
            expect(r.texto).toBe('[]');
            expect(r.indefinidas).toEqual([]);
        });
    });

    describe('lo que no está definido se respeta', () => {
        test('se queda tal cual en vez de vaciarse', () => {
            // Vaciarlo destrozaría una respuesta que llevara ${...} por su cuenta
            expect(sustituir('${NO_EXISTE}').texto).toBe('${NO_EXISTE}');
        });

        test('y se informa de cuál faltaba', () => {
            const r = sustituir('${API_KEY} y ${FALTA} y ${OTRA}');
            expect(r.texto).toBe('abc123 y ${FALTA} y ${OTRA}');
            expect(r.indefinidas.sort()).toEqual(['FALTA', 'OTRA']);
        });

        test('no repite el nombre aunque aparezca varias veces', () => {
            expect(sustituir('${FALTA}${FALTA}').indefinidas).toEqual(['FALTA']);
        });

        test('lo definido se sustituye aunque en el mismo texto falte otra', () => {
            // Que falte una no puede impedir que funcionen las demás
            expect(sustituir('${BACKEND_URL}?k=${FALTA}').texto)
                .toBe('http://api.local?k=${FALTA}');
        });
    });

    describe('qué cuenta como variable', () => {
        test('admite guiones y guiones bajos', () => {
            const r = env.sustituir('${MI_VAR}-${OTRA-VAR}', { MI_VAR: 'a', 'OTRA-VAR': 'b' });
            expect(r.texto).toBe('a-b');
        });

        test('no confunde otras sintaxis parecidas', () => {
            // $VAR sin llaves y {{VAR}} de plantillas no son cosa nuestra
            expect(sustituir('$API_KEY y {{API_KEY}}').texto).toBe('$API_KEY y {{API_KEY}}');
        });

        test('un nombre que empieza por número no vale', () => {
            expect(env.sustituir('${1MALA}', { '1MALA': 'x' }).texto).toBe('${1MALA}');
        });

        test('el texto sin variables vuelve intacto', () => {
            expect(sustituir('nada que ver').texto).toBe('nada que ver');
            expect(sustituir('').texto).toBe('');
        });

        test('tolera null y undefined', () => {
            expect(env.sustituir(null).texto).toBeNull();
            expect(env.sustituir(undefined).texto).toBeUndefined();
        });
    });

    describe('variablesUsadas', () => {
        test('enumera las que aparecen, sin repetir', () => {
            expect(env.variablesUsadas('${A}${B}${A}').sort()).toEqual(['A', 'B']);
        });

        test('sin variables devuelve lista vacía', () => {
            expect(env.variablesUsadas('hola')).toEqual([]);
            expect(env.variablesUsadas(null)).toEqual([]);
        });

        test('encuentra las que no están definidas, que es para lo que sirve', () => {
            expect(env.variablesUsadas('${BACKEND_URL}/${NO_EXISTE}').sort())
                .toEqual(['BACKEND_URL', 'NO_EXISTE']);
        });
    });

    describe('tieneVariables', () => {
        test('detecta si merece la pena mirar', () => {
            expect(env.tieneVariables('a ${B} c')).toBe(true);
            expect(env.tieneVariables('sin nada')).toBe(false);
            expect(env.tieneVariables(null)).toBe(false);
        });
    });
});
