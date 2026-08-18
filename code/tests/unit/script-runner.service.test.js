const scriptRunner = require('../../services/script-runner.service');

const { validateScript, runRequestScript, runResponseScript, applyKeyValueRules } = scriptRunner;

// Contexto base de petición, para no repetirlo en cada caso
const requestCtx = (overrides = {}) => ({
    method: 'GET',
    path: '/users',
    query: {},
    headers: { host: 'api.example.com' },
    bodyText: '',
    vars: {},
    ...overrides
});

const responseCtx = (overrides = {}) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    bodyText: '{}',
    request: {},
    vars: {},
    ...overrides
});

describe('script-runner.service', () => {

    describe('validateScript', () => {
        it('acepta un script vacío o nulo', () => {
            expect(validateScript(null)).toEqual({ valid: true, empty: true });
            expect(validateScript('')).toEqual({ valid: true, empty: true });
            expect(validateScript('   ')).toEqual({ valid: true, empty: true });
        });

        it('acepta un script correcto', () => {
            const result = validateScript("ms.request.headers.add({ key: 'x-a', value: '1' });");
            expect(result.valid).toBe(true);
            expect(result.empty).toBe(false);
        });

        it('rechaza errores de sintaxis', () => {
            const result = validateScript('if (');
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/sintaxis/i);
        });

        it('rechaza los patrones peligrosos e indica cuál', () => {
            const casos = [
                ["require('fs')", 'require'],
                ['process.exit(1)', 'process'],
                ["({}).constructor.constructor('return 1')()", 'constructor'],
                ['obj.__proto__ = {}', '__proto__'],
                ['eval("1+1")', 'eval']
            ];
            for (const [script, esperado] of casos) {
                const result = validateScript(script);
                expect(result.valid).toBe(false);
                expect(result.error.toLowerCase()).toContain(esperado.toLowerCase());
            }
        });

        it('rechaza scripts desmesurados', () => {
            const result = validateScript('const a = 1;'.repeat(3000));
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/límite/i);
        });

        it('permite regex.exec, que sí es legítimo', () => {
            expect(validateScript("/a(b)/.exec('ab')").valid).toBe(true);
        });
    });

    describe('runRequestScript: cabeceras', () => {
        it('añade, sustituye y elimina cabeceras', () => {
            const script = `
                ms.request.headers.add({ key: 'X-Trace', value: 'abc' });
                ms.request.headers.set('x-otro', 'valor');
                ms.request.headers.remove('host');
            `;
            const outcome = runRequestScript(script, requestCtx());

            expect(outcome.success).toBe(true);
            expect(outcome.result.headers['x-trace']).toBe('abc');
            expect(outcome.result.headers['x-otro']).toBe('valor');
            expect(outcome.result.headers.host).toBeUndefined();
        });

        it('trata las cabeceras sin distinguir mayúsculas', () => {
            const outcome = runRequestScript(
                "ms.request.headers.remove('AUTHORIZATION'); ms.variables.set('tenia', String(ms.request.headers.has('Authorization')));",
                requestCtx({ headers: { authorization: 'Bearer x' } })
            );

            expect(outcome.result.headers.authorization).toBeUndefined();
            expect(outcome.result.vars.tenia).toBe('false');
        });

        it('lee cabeceras existentes con get', () => {
            const outcome = runRequestScript(
                "ms.request.headers.add({ key: 'x-copia', value: ms.request.headers.get('x-origen') });",
                requestCtx({ headers: { 'x-origen': 'valor-origen' } })
            );

            expect(outcome.result.headers['x-copia']).toBe('valor-origen');
        });
    });

    describe('runRequestScript: parámetros de query', () => {
        it('añade y elimina parámetros', () => {
            const script = `
                ms.request.url.query.add({ key: 'limit', value: '10' });
                ms.request.url.query.remove('debug');
            `;
            const outcome = runRequestScript(script, requestCtx({ query: { debug: 'true', page: '2' } }));

            expect(outcome.result.query).toEqual({ page: '2', limit: '10' });
        });

        it('los parámetros sí distinguen mayúsculas', () => {
            const outcome = runRequestScript(
                "ms.request.url.query.add({ key: 'Token', value: 'A' });",
                requestCtx({ query: { token: 'b' } })
            );

            expect(outcome.result.query).toEqual({ token: 'b', Token: 'A' });
        });
    });

    describe('runRequestScript: cuerpo', () => {
        it('no marca el cuerpo como cambiado si solo se lee', () => {
            const outcome = runRequestScript(
                "ms.variables.set('nombre', ms.request.body.json().nombre);",
                requestCtx({ bodyText: '{"nombre":"ana","edad":30}' })
            );

            expect(outcome.result.vars.nombre).toBe('ana');
            expect(outcome.result.body.changed).toBe(false);
        });

        it('detecta la mutación del objeto devuelto por json()', () => {
            const outcome = runRequestScript(
                "const b = ms.request.body.json(); b.origen = 'mock'; delete b.interno;",
                requestCtx({ bodyText: '{"id":1,"interno":true}' })
            );

            expect(outcome.result.body.changed).toBe(true);
            expect(JSON.parse(outcome.result.body.text)).toEqual({ id: 1, origen: 'mock' });
        });

        it('sustituye el cuerpo con set(), tanto objeto como texto', () => {
            const conObjeto = runRequestScript(
                "ms.request.body.set({ nuevo: true });",
                requestCtx({ bodyText: '{"viejo":true}' })
            );
            expect(conObjeto.result.body.changed).toBe(true);
            expect(JSON.parse(conObjeto.result.body.text)).toEqual({ nuevo: true });

            const conTexto = runRequestScript(
                "ms.request.body.set('<xml>hola</xml>');",
                requestCtx({ bodyText: '<xml>adios</xml>' })
            );
            expect(conTexto.result.body.text).toBe('<xml>hola</xml>');
        });

        it('devuelve null en json() cuando el cuerpo no es JSON, sin romper', () => {
            const outcome = runRequestScript(
                "ms.variables.set('esNulo', String(ms.request.body.json() === null));",
                requestCtx({ bodyText: 'esto no es json' })
            );

            expect(outcome.success).toBe(true);
            expect(outcome.result.vars.esNulo).toBe('true');
            expect(outcome.result.body.changed).toBe(false);
        });
    });

    describe('runRequestScript: método y path', () => {
        it('permite reescribirlos', () => {
            const outcome = runRequestScript(
                "ms.request.method = 'post'; ms.request.path = '/v2' + ms.request.path;",
                requestCtx({ path: '/users' })
            );

            expect(outcome.result.method).toBe('POST');
            expect(outcome.result.path).toBe('/v2/users');
        });
    });

    describe('runRequestScript: cortocircuito', () => {
        it('ms.respond corta y devuelve la respuesta indicada', () => {
            const script = `
                if (!ms.request.headers.get('authorization')) {
                    ms.respond(401, { error: 'falta token' }, { 'x-motivo': 'sin-token' });
                }
                ms.request.headers.add({ key: 'x-no-deberia', value: 'llegar' });
            `;
            const outcome = runRequestScript(script, requestCtx());

            expect(outcome.success).toBe(true);
            expect(outcome.shortCircuit).toEqual({
                code: 401,
                body: { error: 'falta token' },
                headers: { 'x-motivo': 'sin-token' }
            });
            // Se cortó antes de seguir, así que no hay result
            expect(outcome.result).toBeUndefined();
        });

        it('respond también está disponible sin el prefijo ms', () => {
            const outcome = runRequestScript("respond(429, 'demasiadas peticiones');", requestCtx());
            expect(outcome.shortCircuit.code).toBe(429);
            expect(outcome.shortCircuit.body).toBe('demasiadas peticiones');
        });

        it('no corta cuando la condición no se cumple', () => {
            const outcome = runRequestScript(
                "if (!ms.request.headers.get('authorization')) { ms.respond(401, {}); }",
                requestCtx({ headers: { authorization: 'Bearer x' } })
            );

            expect(outcome.shortCircuit).toBeUndefined();
            expect(outcome.result).toBeDefined();
        });
    });

    describe('runRequestScript: errores y límites', () => {
        it('devuelve el error de ejecución sin lanzarlo', () => {
            const outcome = runRequestScript('noExiste.metodo();', requestCtx());

            expect(outcome.success).toBe(false);
            expect(outcome.error).toMatch(/noExiste/);
        });

        it('corta un bucle infinito por timeout', () => {
            const outcome = runRequestScript('while (true) {}', requestCtx());

            expect(outcome.success).toBe(false);
            expect(outcome.error).toMatch(/timed out|timeout/i);
        });

        it('rechaza el script prohibido antes de ejecutarlo', () => {
            const outcome = runRequestScript("require('fs').writeFileSync('/tmp/x','x');", requestCtx());

            expect(outcome.success).toBe(false);
            expect(outcome.error).toMatch(/require/);
        });

        it('no expone require ni process dentro del sandbox', () => {
            // Sin disparar la lista negra: se comprueba que el contexto está limpio
            const outcome = runRequestScript(
                "ms.variables.set('tipos', typeof requi" + "re + ',' + typeof proces" + "s);",
                requestCtx()
            );

            expect(outcome.success).toBe(true);
            expect(outcome.result.vars.tipos).toBe('undefined,undefined');
        });
    });

    describe('runRequestScript: consola', () => {
        it('recoge los console.log en vez de escribirlos por stdout', () => {
            const outcome = runRequestScript(
                "console.log('hola', { a: 1 }); console.error('mal');",
                requestCtx()
            );

            expect(outcome.logs).toEqual([
                { level: 'log', message: 'hola {"a":1}' },
                { level: 'error', message: 'mal' }
            ]);
        });

        it('no deja que un script llene la memoria a base de logs', () => {
            const outcome = runRequestScript(
                'for (let i = 0; i < 5000; i++) { console.log(i); }',
                requestCtx()
            );

            expect(outcome.logs.length).toBe(100);
        });
    });

    describe('runResponseScript', () => {
        it('cambia el código de estado', () => {
            const outcome = runResponseScript('ms.response.code = 418;', responseCtx());
            expect(outcome.result.status).toBe(418);
        });

        it('transforma el cuerpo mutando el json', () => {
            const outcome = runResponseScript(
                'const d = ms.response.json(); d.items = d.items.slice(0, 2); d.total = d.items.length;',
                responseCtx({ bodyText: '{"items":[1,2,3,4,5]}' })
            );

            expect(outcome.result.body.changed).toBe(true);
            expect(JSON.parse(outcome.result.body.text)).toEqual({ items: [1, 2], total: 2 });
        });

        it('sustituye el cuerpo con setBody', () => {
            const outcome = runResponseScript(
                "ms.response.setBody({ envuelto: ms.response.json() });",
                responseCtx({ bodyText: '{"id":7}' })
            );

            expect(JSON.parse(outcome.result.body.text)).toEqual({ envuelto: { id: 7 } });
        });

        it('añade y quita cabeceras de respuesta', () => {
            const outcome = runResponseScript(
                "ms.response.headers.add({ key: 'X-Servido-Por', value: 'mock' }); ms.response.headers.remove('x-powered-by');",
                responseCtx({ headers: { 'x-powered-by': 'Express' } })
            );

            expect(outcome.result.headers['x-servido-por']).toBe('mock');
            expect(outcome.result.headers['x-powered-by']).toBeUndefined();
        });

        it('da acceso de solo lectura a la petición enviada', () => {
            const outcome = runResponseScript(
                "ms.response.headers.add({ key: 'x-eco-path', value: ms.request.path });",
                responseCtx({ request: { method: 'POST', path: '/v2/users', headers: {}, query: {} } })
            );

            expect(outcome.result.headers['x-eco-path']).toBe('/v2/users');
        });

        it('deja el cuerpo intacto si el script no lo toca', () => {
            const outcome = runResponseScript(
                "ms.response.headers.add({ key: 'x-visto', value: '1' });",
                responseCtx({ bodyText: '{"a":  1}' })
            );

            expect(outcome.result.body.changed).toBe(false);
        });
    });

    describe('variables compartidas', () => {
        it('lo guardado en la petición llega a la respuesta', () => {
            const vars = {};
            runRequestScript("ms.variables.set('inicio', '12345');", requestCtx({ vars }));
            const outcome = runResponseScript(
                "ms.response.headers.add({ key: 'x-inicio', value: ms.variables.get('inicio') });",
                responseCtx({ vars })
            );

            expect(outcome.result.headers['x-inicio']).toBe('12345');
        });
    });

    describe('applyKeyValueRules', () => {
        it('aplica set y remove', () => {
            const target = { host: 'api.com', 'x-quitar': 'ya' };
            const cambios = applyKeyValueRules(target, [
                { action: 'set', name: 'X-Nuevo', value: 'valor' },
                { action: 'remove', name: 'X-Quitar' }
            ], { lowercase: true });

            expect(cambios).toBe(2);
            expect(target).toEqual({ host: 'api.com', 'x-nuevo': 'valor' });
        });

        it('acepta las reglas como texto JSON', () => {
            const target = {};
            applyKeyValueRules(target, '[{"action":"set","name":"a","value":"1"}]');
            expect(target).toEqual({ a: '1' });
        });

        it('ignora entradas inservibles sin romper', () => {
            const target = { a: '1' };
            expect(applyKeyValueRules(target, null)).toBe(0);
            expect(applyKeyValueRules(target, 'no es json')).toBe(0);
            expect(applyKeyValueRules(target, '{"no":"es una lista"}')).toBe(0);
            expect(applyKeyValueRules(target, [{ action: 'set' }])).toBe(0);
            expect(target).toEqual({ a: '1' });
        });

        it('respeta las mayúsculas cuando no se piden minúsculas', () => {
            const target = {};
            applyKeyValueRules(target, [{ action: 'set', name: 'Token', value: 'x' }]);
            expect(target).toEqual({ Token: 'x' });
        });
    });
});

// El script de respuesta puede leer la petición. Vale tanto para el post-script
// de un proxy como para el script de una ruta mock, que usa el mismo motor.
describe('script de respuesta: leer la petición', () => {
    test('el script puede ver el cuerpo que se envió', () => {
        const salida = scriptRunner.runResponseScript(
            'const p = ms.request.json(); const r = ms.response.json(); r.eco = p.nombre; ms.response.setBody(r);',
            {
                status: 200,
                headers: {},
                bodyText: '{"ok":true}',
                request: { method: 'POST', path: '/x', bodyText: '{"nombre":"Ana"}' }
            });

        expect(salida.success).toBe(true);
        expect(JSON.parse(salida.result.body.text).eco).toBe('Ana');
    });

    test('también se puede leer como texto', () => {
        const salida = scriptRunner.runResponseScript(
            'ms.response.setBody({ recibido: ms.request.text() });',
            { status: 200, headers: {}, bodyText: '{}', request: { bodyText: 'hola' } });

        expect(JSON.parse(salida.result.body.text).recibido).toBe('hola');
    });

    test('sin cuerpo en la petición no revienta', () => {
        const salida = scriptRunner.runResponseScript(
            'ms.response.setBody({ vacio: ms.request.json() === null });',
            { status: 200, headers: {}, bodyText: '{}', request: {} });

        expect(salida.success).toBe(true);
        expect(JSON.parse(salida.result.body.text).vacio).toBe(true);
    });

    test('el cuerpo no se reserializa si el script no lo toca', () => {
        // Importante: si no, un JSON escrito a mano perdería su formato solo
        // por pasar por un script que únicamente mira cabeceras
        const salida = scriptRunner.runResponseScript(
            'ms.response.headers.set("x-visto", "1");',
            { status: 200, headers: {}, bodyText: '{\n  "a": 1\n}', request: {} });

        expect(salida.result.body.changed).toBe(false);
    });
});
