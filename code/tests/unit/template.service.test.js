// Las plantillas se prueban sobre todo por su comportamiento con JSON: la
// diferencia entre sustituir dentro o fuera de comillas es lo que decide si la
// respuesta sigue siendo JSON válido, y es donde se rompería sin darse cuenta.

const tpl = require('../../services/template.service');

const contexto = {
    body: { id: 42, nombre: 'Ana', activo: true, tags: ['a', 'b'], anidado: { hijo: 'valor' } },
    query: { page: '2', vacio: '' },
    params: { $1: '99', id: '7' },
    headers: { 'x-request-id': 'abc-123', 'content-type': 'application/json' },
    method: 'post',
    path: '/pedidos',
    url: '/pedidos?page=2'
};

describe('template.service: respuestas dinámicas', () => {

    describe('datos de la petición', () => {
        test('lee del cuerpo, la query, los params y las cabeceras', () => {
            expect(tpl.render('{{body.nombre}}', contexto)).toBe('Ana');
            expect(tpl.render('{{query.page}}', contexto)).toBe('2');
            expect(tpl.render('{{params.$1}}', contexto)).toBe('99');
            expect(tpl.render('{{headers.x-request-id}}', contexto)).toBe('abc-123');
            expect(tpl.render('{{method}}', contexto)).toBe('post');
            expect(tpl.render('{{path}}', contexto)).toBe('/pedidos');
        });

        test('baja por caminos anidados', () => {
            expect(tpl.render('{{body.anidado.hijo}}', contexto)).toBe('valor');
        });

        test('acepta corchetes para nombres con guiones', () => {
            expect(tpl.render("{{headers['x-request-id']}}", contexto)).toBe('abc-123');
        });

        test('encuentra la cabecera aunque se escriba con otras mayúsculas', () => {
            expect(tpl.render('{{headers.X-Request-Id}}', contexto)).toBe('abc-123');
        });

        test('lo que no existe queda vacío, no rompe ni escribe undefined', () => {
            expect(tpl.render('[{{body.noExiste}}]', contexto)).toBe('[]');
            expect(tpl.render('[{{body.a.b.c.d}}]', contexto)).toBe('[]');
        });

        test('un objeto o un array se serializan', () => {
            expect(tpl.render('{{body.tags}}', contexto)).toBe('["a","b"]');
        });

        test('el texto sin plantillas se devuelve tal cual', () => {
            expect(tpl.render('hola', contexto)).toBe('hola');
            expect(tpl.render('', contexto)).toBe('');
        });
    });

    describe('valores por defecto', () => {
        test('cae al valor por defecto cuando falta', () => {
            expect(tpl.render('{{body.noExiste ?? "anónimo"}}', contexto)).toBe('anónimo');
        });

        test('una cadena vacía cuenta como ausente', () => {
            // ?vacio= debe dar el defecto, no una cadena vacía que rompa el JSON
            expect(tpl.render('{{query.vacio ?? "sin valor"}}', contexto)).toBe('sin valor');
        });

        test('no se usa el defecto si el valor está', () => {
            expect(tpl.render('{{body.nombre ?? "anónimo"}}', contexto)).toBe('Ana');
        });

        test('un cero es un valor, no una ausencia', () => {
            expect(tpl.render('{{body.cero ?? 5}}', { body: { cero: 0 } })).toBe('0');
        });

        test('el defecto puede ser un generador', () => {
            const salida = tpl.render('{{body.noExiste ?? uuid()}}', contexto);
            expect(salida).toMatch(/^[0-9a-f-]{36}$/);
        });
    });

    describe('generadores', () => {
        test('uuid da un identificador distinto cada vez', () => {
            const a = tpl.render('{{uuid()}}', contexto);
            const b = tpl.render('{{uuid()}}', contexto);
            expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
            expect(a).not.toBe(b);
        });

        test('funcionan sin paréntesis', () => {
            expect(tpl.render('{{uuid}}', contexto)).toMatch(/^[0-9a-f]{8}-/);
        });

        test('randomInt se queda dentro del rango, extremos incluidos', () => {
            for (let i = 0; i < 50; i++) {
                const n = Number(tpl.render('{{randomInt(5,7)}}', contexto));
                expect(n).toBeGreaterThanOrEqual(5);
                expect(n).toBeLessThanOrEqual(7);
            }
        });

        test('pick elige entre las opciones dadas', () => {
            for (let i = 0; i < 20; i++) {
                expect(['alta', 'media', 'baja']).toContain(
                    tpl.render("{{pick('alta','media','baja')}}", contexto));
            }
        });

        test('pick respeta las comas dentro de comillas', () => {
            expect(tpl.render("{{pick('a,b')}}", contexto)).toBe('a,b');
        });

        test('now da una fecha ISO válida', () => {
            const salida = tpl.render('{{now()}}', contexto);
            expect(new Date(salida).toString()).not.toBe('Invalid Date');
        });

        test('now acepta desplazamientos relativos', () => {
            const manana = new Date(tpl.render("{{now('+1d')}}", contexto));
            const ahora = new Date(tpl.render('{{now()}}', contexto));
            const dias = (manana - ahora) / 86400000;
            expect(dias).toBeGreaterThan(0.99);
            expect(dias).toBeLessThan(1.01);
        });

        test('date da solo la fecha', () => {
            expect(tpl.render("{{date()}}", contexto)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });

        test('randomString respeta la longitud pedida', () => {
            expect(tpl.render('{{randomString(12)}}', contexto)).toHaveLength(12);
        });

        test('un generador mal escrito se deja tal cual, para que se vea', () => {
            // Vaciarlo dejaba el error invisible: salía un hueco y no había
            // forma de saber que la culpa era de una letra de más
            expect(tpl.render('[{{noExisteEsto()}}]', contexto)).toBe('[{{noExisteEsto()}}]');
        });
    });

    describe('lo que el motor no reconoce', () => {
        test('una raíz desconocida se deja intacta', () => {
            // Una plantilla de Handlebars servida como fixture no va dirigida
            // a este motor, y vaciarla destruía contenido ajeno
            expect(tpl.render('Hola {{nombre}}, tienes {{n}} mensajes', contexto))
                .toBe('Hola {{nombre}}, tienes {{n}} mensajes');
        });

        test('pero una raíz conocida sin dato sí se vacía', () => {
            // Aquí el motor sí sabe qué se le pide: el dato simplemente no vino
            expect(tpl.render('[{{body.noExiste}}]', contexto)).toBe('[]');
            expect(tpl.render('[{{query.noExiste}}]', contexto)).toBe('[]');
            expect(tpl.render('[{{headers.noExiste}}]', contexto)).toBe('[]');
        });

        test('un generador que sí existe sigue funcionando', () => {
            expect(tpl.render('{{uuid()}}', contexto)).toMatch(/^[0-9a-f]{8}-/);
        });

        test('escribir ?? es decir "esto es mío", y manda el defecto', () => {
            // Con un valor por defecto explícito no hay ambigüedad que respetar
            expect(tpl.render('{{nombre ?? "invitado"}}', contexto)).toBe('invitado');
            expect(tpl.render('{{malEscrito() ?? "x"}}', contexto)).toBe('x');
        });

        test('un defecto tampoco reconocido cuenta como ausente', () => {
            expect(tpl.render('[{{body.noExiste ?? tampoco}}]', contexto)).toBe('[]');
        });

        describe('en JSON', () => {
            const json = (plantilla, ctx = contexto) => tpl.render(plantilla, ctx, { json: true });

            test('dentro de comillas se respeta y el JSON sigue siendo válido', () => {
                const salida = json('{"plantilla": "Hola {{nombre}}"}');
                expect(JSON.parse(salida).plantilla).toBe('Hola {{nombre}}');
            });

            test('una expresión con comillas dentro no parte el documento', () => {
                // Al respetarla hay que escaparla igual, o la comilla cierra la
                // cadena. El generador tiene que ser uno inexistente: `pick` sí
                // existe y resolvería en vez de dejarse intacto
                const salida = json('{"x": "{{traducir(\'hola\')}}"}');
                expect(() => JSON.parse(salida)).not.toThrow();
                expect(JSON.parse(salida).x).toBe("{{traducir('hola')}}");
            });

            test('fuera de comillas se resuelve siempre, porque ahí no podría ser otra cosa', () => {
                // Un {{...}} suelto en posición de valor no sería JSON válido de
                // ninguna manera, así que solo puede ser una expresión nuestra
                const salida = json('{"x": {{nombre}}}');
                expect(salida).toBe('{"x": null}');
                expect(JSON.parse(salida).x).toBeNull();
            });
        });
    });

    describe('argumentos anidados y conversiones', () => {
        test('un argumento sin comillas se resuelve contra el contexto', () => {
            // La query llega como texto; sin esto no hay forma de meterla como número
            expect(tpl.render('{{number(query.page)}}', contexto)).toBe('2');
            expect(tpl.render('{{number(query.page)}}', contexto, { json: true })).toBe('2');
        });

        test('number produce un número de verdad en JSON, no un texto', () => {
            const salida = tpl.render('{"p": {{number(query.page)}}}', contexto, { json: true });
            expect(typeof JSON.parse(salida).p).toBe('number');
            // Sin convertir seguiría siendo texto, que es el fallo que esto evita
            const crudo = tpl.render('{"p": {{query.page}}}', contexto, { json: true });
            expect(typeof JSON.parse(crudo).p).toBe('string');
        });

        test('number con algo que no es número da null en vez de NaN', () => {
            const salida = tpl.render('{"p": {{number(body.nombre)}}}', contexto, { json: true });
            expect(JSON.parse(salida).p).toBeNull();
        });

        test('un argumento entre comillas sigue siendo literal', () => {
            expect(tpl.render("{{pick('solo')}}", contexto)).toBe('solo');
        });

        test('bool entiende las formas habituales de decir que sí', () => {
            expect(tpl.render('{{bool(query.f)}}', { query: { f: 'true' } })).toBe('true');
            expect(tpl.render('{{bool(query.f)}}', { query: { f: '1' } })).toBe('true');
            expect(tpl.render('{{bool(query.f)}}', { query: { f: 'no' } })).toBe('false');
        });

        test('length cuenta arrays, objetos y textos', () => {
            expect(tpl.render('{{length(body.tags)}}', contexto)).toBe('2');
            expect(tpl.render('{{length(body.nombre)}}', contexto)).toBe('3');
            expect(tpl.render('{{length(body.noExiste)}}', contexto)).toBe('0');
        });

        test('se puede anidar un generador dentro de otro', () => {
            // La coma de dentro no debe partir el argumento de fuera
            expect(tpl.render('{{string(randomInt(5,5))}}', contexto)).toBe('5');
        });

        test('una coma dentro de una llamada anidada no cuenta como separador', () => {
            expect(tpl.render("{{pick(randomInt(3,3))}}", contexto)).toBe('3');
        });
    });

    describe('desplazamientoAMs', () => {
        test('entiende las unidades', () => {
            expect(tpl.desplazamientoAMs('1d')).toBe(86400000);
            expect(tpl.desplazamientoAMs('-2h')).toBe(-7200000);
            expect(tpl.desplazamientoAMs('30m')).toBe(1800000);
            expect(tpl.desplazamientoAMs('500ms')).toBe(500);
        });

        test('sin unidad se entienden días', () => {
            expect(tpl.desplazamientoAMs('2')).toBe(172800000);
        });

        test('lo que no se entiende no desplaza nada', () => {
            expect(tpl.desplazamientoAMs('mañana')).toBe(0);
            expect(tpl.desplazamientoAMs(null)).toBe(0);
        });
    });

    describe('modo JSON', () => {
        const json = (plantilla, ctx = contexto) => tpl.render(plantilla, ctx, { json: true });

        test('dentro de comillas el valor entra como texto', () => {
            expect(json('{"nombre": "{{body.nombre}}"}')).toBe('{"nombre": "Ana"}');
        });

        test('fuera de comillas entra como número, y sigue siendo JSON válido', () => {
            const salida = json('{"id": {{body.id}}}');
            expect(salida).toBe('{"id": 42}');
            expect(JSON.parse(salida).id).toBe(42);
        });

        test('fuera de comillas un array entra como array', () => {
            const salida = json('{"tags": {{body.tags}}}');
            expect(JSON.parse(salida).tags).toEqual(['a', 'b']);
        });

        test('un booleano no se convierte en texto', () => {
            expect(JSON.parse(json('{"activo": {{body.activo}}}')).activo).toBe(true);
        });

        test('un texto con comillas dentro no rompe el JSON', () => {
            const salida = json('{"nombre": "{{body.nombre}}"}', { body: { nombre: 'Ana "la jefa"' } });
            expect(JSON.parse(salida).nombre).toBe('Ana "la jefa"');
        });

        test('un salto de línea tampoco', () => {
            const salida = json('{"texto": "{{body.t}}"}', { body: { t: 'una\ndos' } });
            expect(JSON.parse(salida).texto).toBe('una\ndos');
        });

        test('lo que falta fuera de comillas es null, no un hueco que rompa el JSON', () => {
            const salida = json('{"x": {{body.noExiste}}}');
            expect(salida).toBe('{"x": null}');
            expect(JSON.parse(salida).x).toBeNull();
        });

        test('lo que falta dentro de comillas es una cadena vacía', () => {
            expect(JSON.parse(json('{"x": "{{body.noExiste}}"}')).x).toBe('');
        });

        test('una respuesta entera con varios valores sigue siendo válida', () => {
            const salida = json(`{
                "id": {{body.id}},
                "nombre": "{{body.nombre}}",
                "trazaId": "{{headers.x-request-id}}",
                "pagina": {{query.page}},
                "tags": {{body.tags}}
            }`);
            const objeto = JSON.parse(salida);
            expect(objeto.id).toBe(42);
            expect(objeto.nombre).toBe('Ana');
            expect(objeto.trazaId).toBe('abc-123');
            expect(objeto.tags).toEqual(['a', 'b']);
        });

        test('una comilla escapada dentro del texto no confunde al escáner', () => {
            // Una sola comilla escapada, a propósito: con un número par el fallo
            // de no contar los escapes se compensaría solo y la prueba no valdría
            const salida = json('{"a": "di \\"hola a {{body.nombre}}"}');
            expect(JSON.parse(salida).a).toBe('di "hola a Ana');
        });
    });

    describe('posicionesDentroDeCadena', () => {
        test('distingue dentro y fuera', () => {
            const dentro = tpl.posicionesDentroDeCadena('{"a": "hola"}');
            expect(dentro[2]).toBe(true);   // la 'a', dentro de comillas
            expect(dentro[5]).toBe(false);  // el espacio tras los dos puntos
            expect(dentro[8]).toBe(true);   // la 'h' de hola
        });

        test('una comilla escapada no cierra la cadena', () => {
            // "a\"b" -> la comilla del medio es texto; la cadena acaba en la última
            const dentro = tpl.posicionesDentroDeCadena('"a\\"b" fuera');
            expect(dentro[2]).toBe(true);                    // la comilla escapada, aún dentro
            expect(dentro[4]).toBe(true);                    // la 'b', aún dentro
            expect(dentro[dentro.length - 1]).toBe(false);   // 'fuera', ya fuera
        });

        test('una barra escapada sí deja que la comilla cierre', () => {
            // "a\\" -> la barra está escapada, así que la comilla es el cierre
            const dentro = tpl.posicionesDentroDeCadena('"a\\\\" fuera');
            expect(dentro[dentro.length - 1]).toBe(false);
        });
    });

    describe('tienePlantilla', () => {
        test('detecta si merece la pena montar el contexto', () => {
            expect(tpl.tienePlantilla('hola {{body.x}}')).toBe(true);
            expect(tpl.tienePlantilla('hola')).toBe(false);
            expect(tpl.tienePlantilla(null)).toBe(false);
        });
    });
});
