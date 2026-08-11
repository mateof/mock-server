// El servidor MCP entero se prueba de punta a punta con un cliente real; aquí
// se cubren las piezas puras: la traducción entre el vocabulario de la API MCP
// y el de la tabla, y las reglas compartidas con el panel.

jest.mock('../../services/socket.service', () => ({
    log: { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() },
    sendData: jest.fn()
}));

const mcpService = require('../../services/mcp.service');
const routesService = require('../../services/routes.service');

describe('mcp.service: traducción de vocabularios', () => {

    describe('toPayload', () => {
        it('traduce los nombres de la API al de la tabla', () => {
            const payload = mcpService.toPayload({
                method: 'post',
                path: '/usuarios',
                status_code: '201',
                response_type: 'json',
                response: '{"ok":true}',
                is_regex: true,
                active: false,
                wait_mode: true,
                operation_id: 'crearUsuario',
                proxy_timeout: 5000
            });

            expect(payload).toMatchObject({
                tipo: 'post',
                ruta: '/usuarios',
                codigo: '201',
                tiporespuesta: 'json',
                respuesta: '{"ok":true}',
                isRegex: true,
                activo: false,
                esperaActiva: true,
                operationId: 'crearUsuario',
                proxyTimeout: 5000
            });
        });

        it('solo incluye lo que se pasa, para poder hacer parches', () => {
            const payload = mcpService.toPayload({ status_code: '404' });
            expect(Object.keys(payload)).toEqual(['codigo']);
        });

        it('parte de la base recibida y pisa solo lo indicado', () => {
            const base = { tipo: 'get', ruta: '/original', codigo: '200', respuesta: 'algo' };
            const payload = mcpService.toPayload({ status_code: '500' }, base);

            expect(payload).toEqual({ tipo: 'get', ruta: '/original', codigo: '500', respuesta: 'algo' });
        });

        it('traduce las condiciones al formato de la tabla', () => {
            const payload = mcpService.toPayload({
                conditions: [{ name: 'premium', criteria: "headers['x'] === '1'", status_code: '200', response: '{}' }]
            });

            expect(payload.conditions).toEqual([{
                nombre: 'premium',
                criteria: "headers['x'] === '1'",
                codigo: '200',
                tiporespuesta: null,
                respuesta: '{}',
                activo: 1
            }]);
        });
    });

    describe('toRouteView', () => {
        const fila = {
            id: 7,
            tipo: 'get',
            ruta: '/usuarios',
            codigo: '200',
            tiporespuesta: 'json',
            respuesta: '{"a":1}',
            isRegex: 0,
            activo: 1,
            esperaActiva: 0,
            orden: 3,
            tags: '[{"id":"t1","name":"demo"}]',
            customHeaders: '[{"action":"set","name":"x-a","value":"1"}]',
            summary: 'Listado'
        };

        it('devuelve una vista compacta por defecto', () => {
            const view = mcpService.toRouteView(fila);

            expect(view).toMatchObject({ id: 7, method: 'get', path: '/usuarios', status_code: '200', active: true, order: 3 });
            expect(view.tags).toEqual([{ id: 't1', name: 'demo' }]);
            // El cuerpo no viaja en los listados: puede ser enorme
            expect(view.response).toBeUndefined();
        });

        it('incluye cuerpo y cabeceras en la vista detallada', () => {
            const view = mcpService.toRouteView(fila, { detailed: true });

            expect(view.response).toBe('{"a":1}');
            expect(view.custom_headers).toEqual([{ action: 'set', name: 'x-a', value: '1' }]);
        });

        it('añade las transformaciones solo en rutas proxy', () => {
            const proxy = mcpService.toRouteView({
                ...fila,
                tiporespuesta: 'proxy',
                proxy_timeout: 5000,
                proxy_request_headers: '[{"action":"set","name":"x-key","value":"k"}]',
                proxy_pre_script: 'ms.request.path = "/v2";',
                fallbacks: []
            }, { detailed: true });

            expect(proxy.proxy_timeout).toBe(5000);
            expect(proxy.proxy_request_headers[0].name).toBe('x-key');
            expect(proxy.proxy_pre_script).toContain('ms.request');

            const mock = mcpService.toRouteView(fila, { detailed: true });
            expect(mock.proxy_pre_script).toBeUndefined();
        });

        it('no revienta con JSON corrupto en la base', () => {
            const view = mcpService.toRouteView({ ...fila, tags: 'esto no es json' }, { detailed: true });
            expect(view.tags).toBe('esto no es json');
        });

        it('devuelve null si no hay fila', () => {
            expect(mcpService.toRouteView(null)).toBeNull();
        });
    });
});

describe('routes.service: reglas compartidas por el panel y el MCP', () => {

    describe('isReservedRoute', () => {
        it('reserva los prefijos del panel y del MCP', () => {
            expect(routesService.isReservedRoute('/api')).toBe(true);
            expect(routesService.isReservedRoute('/api/routes')).toBe(true);
            expect(routesService.isReservedRoute('/mcp')).toBe(true);
            expect(routesService.isReservedRoute('/mcp/loquesea')).toBe(true);
        });

        it('no confunde rutas que solo empiezan parecido', () => {
            expect(routesService.isReservedRoute('/apiario')).toBe(false);
            expect(routesService.isReservedRoute('/mcpx')).toBe(false);
            expect(routesService.isReservedRoute('/mi-api/usuarios')).toBe(false);
            expect(routesService.isReservedRoute('/usuarios')).toBe(false);
        });

        it('tolera vacío o indefinido', () => {
            expect(routesService.isReservedRoute('')).toBe(false);
            expect(routesService.isReservedRoute(undefined)).toBe(false);
        });
    });

    describe('asJsonText', () => {
        it('serializa lo que no es texto', () => {
            expect(routesService.asJsonText([{ a: 1 }])).toBe('[{"a":1}]');
        });

        it('deja el texto tal cual, que es lo que evita la doble codificación', () => {
            expect(routesService.asJsonText('[{"a":1}]')).toBe('[{"a":1}]');
        });

        it('convierte lo vacío en null', () => {
            expect(routesService.asJsonText('')).toBeNull();
            expect(routesService.asJsonText(null)).toBeNull();
            expect(routesService.asJsonText(undefined)).toBeNull();
        });
    });
});
