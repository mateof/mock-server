const { test, expect, request: peticiones } = require('@playwright/test');

/**
 * La API v1 contra el servidor de verdad.
 *
 * Va aquí y no en las pruebas unitarias porque lo que hay que comprobar es
 * justo lo que no se ve desde dentro: que encender un mock por la API cambia lo
 * que contesta el servidor a la siguiente petición. Con la base de datos y el
 * middleware simulados eso pasa siempre, tenga o no razón el código.
 *
 * El ciclo que se cubre es el que motiva la API entera: montar dos variantes de
 * un endpoint, cambiar de una a otra desde fuera, y preguntar después qué se
 * llamó.
 */

const V1 = '/api/v1';

async function crearRuta(request, datos) {
    const r = await request.post(`${V1}/routes`, { data: datos });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).route;
}

test.describe('API v1', () => {

    /**
     * Se recoge lo que ensucia.
     *
     * Las pruebas de este fichero corren antes que las del panel contra el mismo
     * servidor, y las del panel miran la tabla de rutas: una docena de rutas
     * nuestras la empujan a la segunda página y las hacen fallar sin que el fallo
     * tenga nada que ver con ellas. El `request` de las pruebas no existe en
     * afterAll, así que se abre un contexto propio.
     */
    test.afterAll(async () => {
        const api = await peticiones.newContext({ baseURL: test.info().project.use.baseURL });

        await api.post(`${V1}/routes/delete`, { data: { path_contains: '/e2e-api/' } });

        const tags = await api.get(`${V1}/tags`);
        if (tags.ok()) {
            for (const tag of (await tags.json()).tags) {
                if (String(tag.name).startsWith('e2e-')) await api.delete(`${V1}/tags/${tag.id}`);
            }
        }

        await api.delete(`${V1}/environments/e2e-staging`);
        await api.dispose();
    });

    test('sirve su propio contrato y la pantalla que lo enseña', async ({ page, request }) => {
        const spec = await request.get(`${V1}/openapi.json`);
        expect(spec.ok()).toBeTruthy();

        const doc = await spec.json();
        expect(doc.openapi).toMatch(/^3\./);
        expect(doc.paths['/routes/activate'].post).toBeDefined();
        // El servidor del contrato es este, no el localhost escrito en el fichero
        expect(doc.servers[0].url).toContain('/api/v1');

        await page.goto('/api-docs');
        // Swagger UI ha montado de verdad, no solo cargado el script
        await expect(page.locator('.swagger-ui .opblock-tag').first()).toBeVisible();
        await expect(page.locator('#apiAuthState')).toContainText(/token/i);
    });

    test('enciende un mock y apaga el que competía por la misma petición', async ({ request }) => {
        const ok = await crearRuta(request, {
            method: 'get', path: '/e2e-api/orders', status_code: '200',
            response_type: 'json', response: '{"state":"paid"}',
            tags: [{ name: 'e2e-ok' }]
        });
        const ko = await crearRuta(request, {
            method: 'get', path: '/e2e-api/orders', status_code: '503',
            response_type: 'json', response: '{"state":"down"}',
            active: false, tags: [{ name: 'e2e-down' }]
        });

        const antes = await request.get('/e2e-api/orders');
        expect(antes.status()).toBe(200);

        const cambio = await request.post(`${V1}/routes/activate`, {
            data: { tag: 'e2e-down', exclusive: true }
        });
        expect(cambio.ok()).toBeTruthy();
        const resultado = await cambio.json();
        expect(resultado.routes.map(r => r.id)).toContain(ko.id);
        expect(resultado.deactivated.map(r => r.id)).toContain(ok.id);

        const despues = await request.get('/e2e-api/orders');
        expect(despues.status()).toBe(503);

        // Y de vuelta, que es lo que hace un runner entre casos
        await request.post(`${V1}/routes/activate`, { data: { tag: 'e2e-ok', exclusive: true } });
        expect((await request.get('/e2e-api/orders')).status()).toBe(200);
    });

    test('un parche cambia un campo sin llevarse por delante lo demás', async ({ request }) => {
        const ruta = await crearRuta(request, {
            method: 'get', path: '/e2e-api/slow', status_code: '200',
            response_type: 'json', response: '{"ok":true}',
            latency_mode: 'fixed', latency_ms: 120, templating: true
        });

        const parche = await request.patch(`${V1}/routes/${ruta.id}`, { data: { status_code: '201' } });
        expect(parche.ok()).toBeTruthy();

        const despues = (await parche.json()).route;
        expect(despues.status_code).toBe('201');
        expect(despues.latency).toEqual({ mode: 'fixed', ms: 120, max_ms: 0 });
        expect(despues.templating).toBe(true);
    });

    test('cuenta las llamadas que recibió, que es lo que asegura una prueba', async ({ request }) => {
        await crearRuta(request, {
            method: 'post', path: '/e2e-api/payments', status_code: '200',
            response_type: 'json', response: '{"paid":true}'
        });

        const desde = Date.now();
        await request.post('/e2e-api/payments', { data: { amount: 42 } });
        await request.post('/e2e-api/payments', { data: { amount: 43 } });

        // El log se vuelca por lotes: se reintenta en vez de dormir a ojo
        let resultado;
        for (let i = 0; i < 30; i++) {
            const r = await request.post(`${V1}/verify/calls`, {
                data: { path: '/e2e-api/payments', method: 'post', since_ms: desde, times: 2 }
            });
            resultado = await r.json();
            if (resultado.matched >= 2) break;
            await new Promise(res => setTimeout(res, 200));
        }

        expect(resultado.matched).toBe(2);
        expect(resultado.passed).toBe(true);
        expect(resultado.expected).toBe('exactly 2');
    });

    test('un escenario avanza con las llamadas y se reinicia desde fuera', async ({ request }) => {
        const ruta = await crearRuta(request, {
            method: 'get', path: '/e2e-api/job', status_code: '200',
            response_type: 'json', response: '{"state":"unknown"}'
        });

        const pasos = await request.put(`${V1}/routes/${ruta.id}/sequence`, {
            data: {
                mode: 'stick',
                sequence: [
                    { name: 'pending', status_code: '200', response_type: 'json', response: '{"state":"pending"}' },
                    { name: 'done', status_code: '200', response_type: 'json', response: '{"state":"done"}' }
                ]
            }
        });
        expect(pasos.ok()).toBeTruthy();

        expect(await (await request.get('/e2e-api/job')).json()).toEqual({ state: 'pending' });
        expect(await (await request.get('/e2e-api/job')).json()).toEqual({ state: 'done' });

        const reinicio = await request.post(`${V1}/routes/${ruta.id}/sequence/reset`);
        expect(reinicio.ok()).toBeTruthy();
        expect(await (await request.get('/e2e-api/job')).json()).toEqual({ state: 'pending' });
    });

    test('contesta con el código que toca cuando se pide algo imposible', async ({ request }) => {
        const inexistente = await request.get(`${V1}/routes/999999`);
        expect(inexistente.status()).toBe(404);
        expect((await inexistente.json()).code).toBe('not_found');

        const sinSelector = await request.post(`${V1}/routes/activate`, { data: {} });
        expect(sinSelector.status()).toBe(400);
        expect((await sinSelector.json()).code).toBe('invalid');

        const mock = await crearRuta(request, {
            method: 'get', path: '/e2e-api/plain', status_code: '200',
            response_type: 'json', response: '{}'
        });
        // Los fallbacks son cosa de rutas proxy: existe, pero no puede
        const imposible = await request.put(`${V1}/routes/${mock.id}/proxy-fallbacks`, {
            data: { fallbacks: [] }
        });
        expect(imposible.status()).toBe(422);

        const fuera = await request.get(`${V1}/no-existe`);
        expect(fuera.status()).toBe(404);
        expect((await fuera.json()).code).toBe('not_found');
    });

    test('rechaza una ruta a medias y normaliza el método', async ({ request }) => {
        // Por MCP esto lo para el esquema de la herramienta; por HTTP no lo para
        // nadie, y una ruta sin método ni camino no responde a nada
        const vacia = await request.post(`${V1}/routes`, { data: {} });
        expect(vacia.status()).toBe(400);
        expect((await vacia.json()).error).toContain('method');

        const rara = await request.post(`${V1}/routes`, {
            data: { method: 'FETCH', path: '/e2e-api/x', status_code: '200', response_type: 'json', response: '{}' }
        });
        expect(rara.status()).toBe(400);

        // La resolución compara el método ya en minúscula: guardarlo como POST
        // dejaría una ruta que no casa con ninguna petición
        const creada = await crearRuta(request, {
            method: 'POST', path: '/e2e-api/upper', status_code: '200',
            response_type: 'json', response: '{"ok":true}'
        });
        expect(creada.method).toBe('post');
        expect((await request.post('/e2e-api/upper', { data: {} })).status()).toBe(200);
    });

    test('crea una ruta de fichero y lo cambia sin perder el resto', async ({ request }) => {
        const alta = await request.post(`${V1}/routes`, {
            multipart: {
                method: 'get',
                path: '/e2e-api/tarifas.csv',
                status_code: '200',
                response_type: 'file',
                tags: JSON.stringify([{ name: 'e2e-ficheros' }]),
                file: { name: 'tarifas.csv', mimeType: 'text/csv', buffer: Buffer.from('clave;valor\na;1\n') }
            }
        });
        expect(alta.status(), await alta.text()).toBe(201);
        const ruta = (await alta.json()).route;
        expect(ruta.file).toEqual({ name: 'tarifas.csv', mime_type: 'text/csv' });

        const servido = await request.get('/e2e-api/tarifas.csv');
        expect(servido.status()).toBe(200);
        expect(servido.headers()['content-type']).toContain('text/csv');
        expect(await servido.text()).toContain('clave;valor');

        // Un parche normal no puede llevarse el fichero por delante
        const parche = await request.patch(`${V1}/routes/${ruta.id}`, { data: { summary: 'tarifas vigentes' } });
        expect((await parche.json()).route.file.name).toBe('tarifas.csv');
        expect((await request.get('/e2e-api/tarifas.csv')).status()).toBe(200);

        // Y mandar otro fichero lo sustituye
        const nuevo = await request.patch(`${V1}/routes/${ruta.id}`, {
            multipart: { file: { name: 'tarifas-2026.csv', mimeType: 'text/csv', buffer: Buffer.from('clave;valor\nb;2\n') } }
        });
        expect((await nuevo.json()).route.file.name).toBe('tarifas-2026.csv');
        expect(await (await request.get('/e2e-api/tarifas.csv')).text()).toContain('b;2');

        // Sin fichero no hay ruta de fichero que valga: se guardaría muda
        const sinFichero = await request.post(`${V1}/routes`, {
            data: { method: 'get', path: '/e2e-api/vacia', status_code: '200', response_type: 'file' }
        });
        expect(sinFichero.status()).toBe(400);
    });

    test('los entornos se manejan por nombre, sin conocer ids', async ({ request }) => {
        const creado = await request.put(`${V1}/environments/e2e-staging`, {
            data: { variables: [{ key: 'E2E_BACKEND', value: 'https://staging.example.com' }], activate: true }
        });
        expect(creado.ok()).toBeTruthy();
        expect((await creado.json()).active).toBe('e2e-staging');

        const variable = await request.put(`${V1}/environments/e2e-staging/variables/E2E_TOKEN`, {
            data: { value: 'abc123' }
        });
        expect(variable.ok()).toBeTruthy();

        const leido = await request.get(`${V1}/environments/e2e-staging`);
        const entorno = (await leido.json()).environment;
        expect(entorno.variables.map(v => v.key).sort()).toEqual(['E2E_BACKEND', 'E2E_TOKEN']);

        const borrada = await request.delete(`${V1}/environments/e2e-staging/variables/E2E_TOKEN`);
        expect(borrada.ok()).toBeTruthy();
    });
});
