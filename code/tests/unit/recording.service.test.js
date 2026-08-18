// La grabación se prueba por sus piezas puras: la traducción de un intercambio
// a una ruta y la lectura de una entrada del log. Lo que toca base de datos se
// cubre desde fuera, con tráfico real contra un backend de prueba.

jest.mock('../../services/socket.service', () => ({
    log: { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn(), proxyDetailed: jest.fn() },
    sendData: jest.fn()
}));

const recording = require('../../services/recording.service');

describe('recording.service: de tráfico real a mock', () => {

    describe('tipoRespuestaDesdeContentType', () => {
        test('reconoce los tipos habituales', () => {
            expect(recording.tipoRespuestaDesdeContentType('application/json; charset=utf-8', '{"a":1}')).toBe('json');
            expect(recording.tipoRespuestaDesdeContentType('text/html', '<p>hola</p>')).toBe('html');
            expect(recording.tipoRespuestaDesdeContentType('text/plain', 'hola')).toBe('text');
            expect(recording.tipoRespuestaDesdeContentType('application/xml', '<a/>')).toBe('xml');
        });

        test('distingue SOAP de XML por el sobre', () => {
            const sobre = '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://x"><soap:Body/></soap:Envelope>';
            expect(recording.tipoRespuestaDesdeContentType('text/xml', sobre)).toBe('soap');
            expect(recording.tipoRespuestaDesdeContentType('text/xml', '<pedidos/>')).toBe('xml');
        });

        test('un cuerpo vacío es una respuesta vacía, sea cual sea el content-type', () => {
            expect(recording.tipoRespuestaDesdeContentType('application/json', '')).toBe('empty');
            expect(recording.tipoRespuestaDesdeContentType('image/png', '')).toBe('empty');
        });

        test('devuelve null en binario, que es lo que no se puede grabar', () => {
            expect(recording.tipoRespuestaDesdeContentType('image/png', '\x89PNG')).toBeNull();
            expect(recording.tipoRespuestaDesdeContentType('application/octet-stream', 'xx')).toBeNull();
            expect(recording.tipoRespuestaDesdeContentType('application/pdf', '%PDF')).toBeNull();
        });

        test('sin content-type se decide por el aspecto del cuerpo', () => {
            expect(recording.tipoRespuestaDesdeContentType(null, '{"a":1}')).toBe('json');
            expect(recording.tipoRespuestaDesdeContentType(null, '[1,2]')).toBe('json');
            expect(recording.tipoRespuestaDesdeContentType(null, 'hola')).toBe('text');
        });
    });

    describe('cabecerasParaMock', () => {
        test('conserva las del backend y descarta las del transporte', () => {
            const reglas = recording.cabecerasParaMock({
                'content-type': 'application/json',
                'content-length': '123',
                'content-encoding': 'gzip',
                'transfer-encoding': 'chunked',
                'connection': 'keep-alive',
                'date': 'Mon, 01 Jan 2024 00:00:00 GMT',
                'server': 'nginx',
                'etag': 'W/"abc"',
                'cache-control': 'no-cache'
            });

            const nombres = reglas.map(r => r.name);
            expect(nombres).toContain('content-type');
            expect(nombres).toContain('etag');
            expect(nombres).toContain('cache-control');
            // Estas las recalcula Express o describen aquella conexión
            expect(nombres).not.toContain('content-length');
            expect(nombres).not.toContain('content-encoding');
            expect(nombres).not.toContain('transfer-encoding');
            expect(nombres).not.toContain('date');
            expect(nombres).not.toContain('server');
        });

        test('no arrastra las cabeceras que pone este propio servidor', () => {
            const reglas = recording.cabecerasParaMock({
                'content-type': 'text/plain',
                'x-mock-trace-id': 'abc123',
                'x-mock-script': 'response'
            });
            expect(reglas.map(r => r.name)).toEqual(['content-type']);
        });

        test('junta los valores repetidos en vez de perderlos', () => {
            const reglas = recording.cabecerasParaMock({ 'set-cookie': ['a=1', 'b=2'] });
            expect(reglas[0]).toEqual({ action: 'set', name: 'set-cookie', value: 'a=1, b=2' });
        });

        test('el formato es el que ya entiende el panel', () => {
            const reglas = recording.cabecerasParaMock({ 'content-type': 'application/json' });
            expect(reglas[0]).toEqual({ action: 'set', name: 'content-type', value: 'application/json' });
        });
    });

    describe('caminoDeUrl', () => {
        test('quita la query, que las rutas exactas no miran al casar', () => {
            expect(recording.caminoDeUrl('/pedidos?page=2&size=10')).toBe('/pedidos');
        });

        test('normaliza la barra inicial', () => {
            expect(recording.caminoDeUrl('pedidos')).toBe('/pedidos');
            expect(recording.caminoDeUrl('/pedidos')).toBe('/pedidos');
        });
    });

    describe('intercambioAPayload', () => {
        const base = {
            method: 'GET',
            url: '/pedidos?page=1',
            status: 200,
            responseHeaders: { 'content-type': 'application/json' },
            responseBody: '{"id":1,"total":42}'
        };

        test('construye una ruta con lo que respondió el backend', () => {
            const { ok, payload } = recording.intercambioAPayload(base);

            expect(ok).toBe(true);
            expect(payload.tipo).toBe('get');
            expect(payload.ruta).toBe('/pedidos');
            expect(payload.codigo).toBe('200');
            expect(payload.tiporespuesta).toBe('json');
            expect(payload.isRegex).toBe(false);
            expect(payload.esperaActiva).toBe(false);
        });

        test('reindenta el JSON para que la ruta se pueda leer y editar', () => {
            const { payload } = recording.intercambioAPayload(base);
            expect(payload.respuesta).toBe('{\n  "id": 1,\n  "total": 42\n}');
        });

        test('deja el JSON corrupto tal cual en vez de perderlo', () => {
            const { payload } = recording.intercambioAPayload({ ...base, responseBody: '{roto' });
            expect(payload.respuesta).toBe('{roto');
        });

        test('nace desactivada, porque un mock activo taparía al proxy que la grabó', () => {
            const { payload } = recording.intercambioAPayload(base);
            expect(payload.activo).toBe(false);
        });

        test('se puede pedir activa de forma explícita', () => {
            const { payload } = recording.intercambioAPayload(base, { activo: true });
            expect(payload.activo).toBe(true);
        });

        test('marca lo grabado con su tag para poder encontrarlo después', () => {
            const { payload } = recording.intercambioAPayload(base);
            expect(payload.tags).toContain('recorded');
        });

        test('respeta los tags que le pasen y no duplica el suyo', () => {
            const { payload } = recording.intercambioAPayload(base, { tags: ['pagos', 'recorded'] });
            expect(payload.tags).toEqual(['pagos', 'recorded']);
        });

        test('rechaza un cuerpo recortado en vez de crear un mock corrupto', () => {
            const salida = recording.intercambioAPayload({ ...base, truncated: true });
            expect(salida.ok).toBe(false);
            expect(salida.reason).toBe('truncated');
        });

        test('rechaza el binario, que no cabe en una columna de texto', () => {
            const salida = recording.intercambioAPayload({
                ...base,
                responseHeaders: { 'content-type': 'image/png' },
                responseBody: '\x89PNG\r\n'
            });
            expect(salida.ok).toBe(false);
            expect(salida.reason).toBe('binary');
        });

        test('rechaza los prefijos reservados, que taparían el panel o el MCP', () => {
            expect(recording.intercambioAPayload({ ...base, url: '/api/rutas' }).reason).toBe('reserved');
            expect(recording.intercambioAPayload({ ...base, url: '/mcp' }).reason).toBe('reserved');
        });

        test('una respuesta sin cuerpo se graba como vacía', () => {
            const { payload } = recording.intercambioAPayload({
                ...base, status: 204, responseBody: '', responseHeaders: {}
            });
            expect(payload.tiporespuesta).toBe('empty');
            expect(payload.respuesta).toBe('');
            expect(payload.codigo).toBe('204');
        });

        test('conserva el código de error: grabar un 500 es grabar un 500', () => {
            const { payload } = recording.intercambioAPayload({ ...base, status: 500 });
            expect(payload.codigo).toBe('500');
        });
    });

    describe('intercambioDesdeEntrada', () => {
        const entrada = {
            method: 'POST',
            url: '/pedidos',
            status: 201,
            details: {
                request: { headers: {}, body: { total: 42 } },
                response: {
                    headers: { 'content-type': 'application/json' },
                    body: { type: 'json', data: { id: 7 }, truncated: false }
                }
            }
        };

        test('reconstruye el intercambio desde el detalle guardado', () => {
            const salida = recording.intercambioDesdeEntrada(entrada);
            expect(salida.ok).toBe(true);
            expect(salida.intercambio.method).toBe('POST');
            expect(salida.intercambio.status).toBe(201);
            expect(JSON.parse(salida.intercambio.responseBody)).toEqual({ id: 7 });
        });

        test('arrastra la marca de recorte del cuerpo', () => {
            const recortada = JSON.parse(JSON.stringify(entrada));
            recortada.details.response.body.truncated = true;
            expect(recording.intercambioDesdeEntrada(recortada).intercambio.truncated).toBe(true);
        });

        test('detecta el detalle recortado entero, que llega como texto suelto', () => {
            const salida = recording.intercambioDesdeEntrada({
                ...entrada,
                details: '{"request":{"headers"…(recortado)'
            });
            expect(salida.ok).toBe(false);
            expect(salida.reason).toBe('truncated');
        });

        test('una entrada sin respuesta no se puede convertir', () => {
            const salida = recording.intercambioDesdeEntrada({ ...entrada, details: { request: {} } });
            expect(salida.ok).toBe(false);
            expect(salida.reason).toBe('no-response');
        });

        test('una entrada que no existe se reporta, no revienta', () => {
            expect(recording.intercambioDesdeEntrada(null).reason).toBe('not-found');
        });

        test('acepta el cuerpo guardado como texto plano', () => {
            const texto = JSON.parse(JSON.stringify(entrada));
            texto.details.response.body = 'hola';
            expect(recording.intercambioDesdeEntrada(texto).intercambio.responseBody).toBe('hola');
        });
    });
});
