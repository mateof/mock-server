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

    describe('sustituir dentro de código', () => {
        const conVars = { PORT: '8080', CLAVE: 'ab"c', SIMPLE: "a'b", SALTO: 'una\ndos' };
        const enCodigo = (texto) => env.sustituir(texto, conVars, { paraCodigo: true }).texto;

        test('un valor normal entra igual y sigue valiendo fuera de comillas', () => {
            // Escapar de más rompería `port === 8080`
            expect(enCodigo('port === ${PORT}')).toBe('port === 8080');
        });

        test('una comilla doble se escapa, o parte la cadena que la contiene', () => {
            // Sin esto, `"di "hola" y ya"` es un error de sintaxis, y aparece al
            // llegar la petición y no al guardar el script
            expect(enCodigo('const x = "${CLAVE}";')).toBe('const x = "ab\\"c";');
        });

        test('una comilla simple también', () => {
            expect(enCodigo("const x = '${SIMPLE}';")).toBe("const x = 'a\\'b';");
        });

        test('un salto de línea se escapa en vez de partir la línea', () => {
            expect(enCodigo('"${SALTO}"')).toBe('"una\\ndos"');
        });

        test('el escapado es solo para código: en un cuerpo el valor va crudo', () => {
            // Una respuesta JSON no quiere el valor escapado dos veces
            expect(env.sustituir('{"k":"${CLAVE}"}', conVars).texto).toBe('{"k":"ab"c"}');
        });

        test('lo indefinido se sigue respetando', () => {
            const r = env.sustituir('const x = "${NO_VA}";', conVars, { paraCodigo: true });
            expect(r.texto).toBe('const x = "${NO_VA}";');
            expect(r.indefinidas).toEqual(['NO_VA']);
        });
    });

    describe('escaparParaCodigo', () => {
        test('deja en paz lo que no hace daño', () => {
            expect(env.escaparParaCodigo('abc123')).toBe('abc123');
            expect(env.escaparParaCodigo('http://api.local/v3')).toBe('http://api.local/v3');
        });

        test('escapa la barra invertida antes que el resto', () => {
            // Al revés, la barra de escape recién puesta se volvería a escapar
            expect(env.escaparParaCodigo('a\\b')).toBe('a\\\\b');
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
