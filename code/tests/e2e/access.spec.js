const { test, expect, request: peticiones } = require('@playwright/test');
const { CLAVE_DE_ACCESO } = require('../../playwright.config');

const OTRO_EQUIPO = { 'X-Forwarded-For': '192.168.1.50' };
const MOCK = '/e2e-access/ping';

test.describe('clave de acceso para otros equipos', () => {

    test.beforeAll(async () => {
        const api = await peticiones.newContext({ baseURL: test.info().project.use.baseURL });
        const r = await api.post('/api/v1/routes', {
            data: { method: 'get', path: MOCK, status_code: '200', response_type: 'json', response: '{"pong":true}' }
        });
        expect(r.status(), await r.text()).toBe(201);
        await api.dispose();
    });

    test.afterAll(async () => {
        const api = await peticiones.newContext({ baseURL: test.info().project.use.baseURL });
        await api.post('/api/v1/routes/delete', { data: { path_contains: '/e2e-access/' } });
        await api.dispose();
    });

    test('el propio equipo entra al panel y a la API sin clave', async ({ request }) => {
        expect((await request.get('/')).status()).toBe(200);
        expect((await request.get('/api/v1/server')).status()).toBe(200);
    });

    test('otro equipo llega a los mocks sin clave, pero no a la API', async ({ request }) => {
        const mock = await request.get(MOCK, { headers: OTRO_EQUIPO });
        expect(mock.status()).toBe(200);
        expect(await mock.json()).toEqual({ pong: true });

        const panel = await request.get('/api/routes', { headers: OTRO_EQUIPO });
        expect(panel.status()).toBe(401);
        expect((await panel.json()).code).toBe('access_key_required');

        expect((await request.get('/api/v1/routes', { headers: OTRO_EQUIPO })).status()).toBe(401);
    });

    test('otro equipo usa la API v1 y el MCP con la clave como token', async ({ request }) => {
        const conBearer = await request.get('/api/v1/routes', {
            headers: { ...OTRO_EQUIPO, Authorization: `Bearer ${CLAVE_DE_ACCESO}` }
        });
        expect(conBearer.status()).toBe(200);

        const conCabecera = await request.get('/api/v1/server', { headers: { ...OTRO_EQUIPO, 'X-API-Key': CLAVE_DE_ACCESO } });
        expect(conCabecera.status()).toBe(200);
        expect((await conCabecera.json()).auth.remote_access_key_required).toBe(true);

        const equivocada = await request.get('/api/v1/routes', { headers: { ...OTRO_EQUIPO, Authorization: 'Bearer equivocada' } });
        expect(equivocada.status()).toBe(401);

        const mcp = await request.post('/mcp', {
            headers: { ...OTRO_EQUIPO, Authorization: `Bearer ${CLAVE_DE_ACCESO}`, Accept: 'application/json, text/event-stream' },
            data: {
                jsonrpc: '2.0', id: 1, method: 'initialize',
                params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }
            }
        });
        expect(mcp.status()).toBe(200);
        expect(await mcp.text()).toContain('serverInfo');
    });

    test('otro equipo entra al panel con la clave desde la pantalla de entrada, y el panel conecta en vivo', async ({ page }) => {
        await page.setExtraHTTPHeaders(OTRO_EQUIPO);

        const respuesta = await page.goto('/logs');
        expect(respuesta.status()).toBe(401);
        await expect(page.locator('#access-key')).toBeVisible();

        await page.fill('#access-key', 'equivocada');
        await page.click('button[type=submit]');
        await expect(page.locator('.error')).toBeVisible();

        await page.fill('#access-key', CLAVE_DE_ACCESO);
        await page.click('button[type=submit]');
        await expect(page).toHaveURL(/\/logs$/);

        await page.goto('/');
        await expect(page.locator('#statusText')).toHaveText(/activo|active/i);

        const cookies = await page.context().cookies();
        const acceso = cookies.find((c) => c.name === 'mock-server-access');
        expect(acceso.httpOnly).toBe(true);
        expect(acceso.sameSite).toBe('Strict');
        expect(acceso.value).not.toContain(CLAVE_DE_ACCESO);
    });

    test('otro equipo sin clave no abre el canal en vivo del panel', async ({ request }) => {
        const handshake = await request.get('/socket.io/?EIO=4&transport=polling', { headers: OTRO_EQUIPO });
        expect(handshake.status()).toBe(403);

        const local = await request.get('/socket.io/?EIO=4&transport=polling');
        expect(local.status()).toBe(200);
    });
});
