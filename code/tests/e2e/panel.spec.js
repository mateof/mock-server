const { test, expect } = require('@playwright/test');

/**
 * Pruebas de humo del panel.
 *
 * No pretenden cubrirlo todo: cubren los cuatro caminos por los que se pasa
 * siempre (abrir el panel, crear una ruta, filtrar por tag, mirar una traza),
 * que son justo los que se rompían sin que nadie se enterara hasta abrirlo a
 * mano. Todo lo que va por debajo ya está cubierto por las pruebas unitarias.
 */

// Crea una ruta por la API. Se usa cuando lo que se prueba no es el formulario
// sino lo que viene después: montarla a mano en cada prueba las haría lentas y
// dependientes del formulario para todo
async function crearRuta(request, datos) {
    const form = new URLSearchParams({
        tipo: datos.tipo || 'get',
        ruta: datos.ruta,
        codigo: datos.codigo || '200',
        tiporespuesta: datos.tiporespuesta || 'json',
        respuesta: datos.respuesta || '{"ok":true}',
        activo: 'true',
        rutaActiva: 'true',
        ...(datos.tags ? { tags: JSON.stringify(datos.tags) } : {})
    });

    const r = await request.post('/api/create', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: form.toString()
    });
    expect(r.ok()).toBeTruthy();
    return (await r.json()).id;
}

/**
 * Espera a que una petición aparezca en el log antes de abrir la pantalla.
 *
 * El log se escribe por lotes cada 500 ms, y la pantalla consulta una sola vez
 * al cargar: si se abre antes del volcado, se queda vacía para siempre y la
 * espera de Playwright reintenta contra un DOM que ya no va a cambiar. Se
 * sondea la API, que es el dato de verdad, en vez de dormir un rato a ojo.
 */
async function esperarEnElLog(request, texto, intentos = 30) {
    for (let i = 0; i < intentos; i++) {
        const r = await request.get(`/api/logs?limit=200&url=${encodeURIComponent(texto)}`);
        if (r.ok()) {
            const datos = await r.json();
            if (datos.entries.some(e => (e.url || '').includes(texto))) return true;
        }
        await new Promise(res => setTimeout(res, 200));
    }
    throw new Error(`"${texto}" no llegó al log`);
}

test.describe('panel de rutas', () => {

    test('abre y enseña la tabla de rutas', async ({ page }) => {
        await page.goto('/');

        await expect(page.locator('#dtList')).toBeVisible();
        await expect(page.locator('.card-header-modern h2').first()).toBeVisible();
        // La consola en vivo es lo que dice que el socket conectó
        await expect(page.locator('.terminal-header').first()).toBeVisible();
    });

    test('crea una ruta desde el formulario y aparece en la lista', async ({ page }) => {
        await page.goto('/');

        await page.click('button:has-text("Nueva ruta"), button:has-text("New route"), button:has-text("Nova ruta")');
        await expect(page.locator('#routesModal')).toBeVisible();

        await page.fill('#ruta', '/e2e/creada-a-mano');
        await page.selectOption('#tiporespuesta', 'json');
        await page.fill('#respuesta', '{"desde":"playwright"}');

        await page.click('#botonguardar');

        // La tabla se recarga sola tras guardar
        await expect(page.locator('#dtList')).toContainText('/e2e/creada-a-mano', { timeout: 10000 });
    });

    test('la ruta creada responde de verdad', async ({ page, request }) => {
        await crearRuta(request, { ruta: '/e2e/responde', respuesta: '{"vivo":true}' });

        const r = await request.get('/e2e/responde');
        expect(r.status()).toBe(200);
        expect(await r.json()).toEqual({ vivo: true });
    });

    test('filtrar por tag deja solo las rutas de ese tag', async ({ page, request }) => {
        // Un tag y dos rutas: una con él y otra sin él
        const tagRes = await request.post('/api/tags', {
            data: { name: 'e2e-pagos', color: '#ef4444' }
        });
        const cuerpo = tagRes.ok() ? await tagRes.json() : null;
        const tag = cuerpo && cuerpo.tag ? cuerpo.tag : null;
        test.skip(!tag || !tag.id, 'no se pudo crear el tag');

        await crearRuta(request, { ruta: '/e2e/con-tag', tags: [tag] });
        await crearRuta(request, { ruta: '/e2e/sin-tag' });

        await page.goto('/');
        await expect(page.locator('#dtList')).toContainText('/e2e/con-tag');
        await expect(page.locator('#dtList')).toContainText('/e2e/sin-tag');

        // Abrir el desplegable de tags y marcar el nuestro
        await page.click('#tagsFilterDropdown');
        await expect(page.locator('#tagsFilterMenu')).toBeVisible();
        await page.locator('#tagsFilterMenu input[type="checkbox"][value="' + tag.id + '"]').check();

        await expect(page.locator('#dtList')).toContainText('/e2e/con-tag');
        await expect(page.locator('#dtList')).not.toContainText('/e2e/sin-tag');
    });

    test('el menú de tags se puede quitar y vuelven todas', async ({ page, request }) => {
        await page.goto('/');
        await page.click('#tagsFilterDropdown');
        await expect(page.locator('#tagsFilterMenu')).toBeVisible();

        const casilla = page.locator('#tagsFilterMenu input[type="checkbox"]').first();
        await casilla.check();
        await casilla.uncheck();

        // Sin filtro vuelven a verse las dos
        await expect(page.locator('#dtList')).toContainText('/e2e/sin-tag');
    });
});

test.describe('pantalla de log', () => {

    test('abre y enseña el tráfico que acaba de pasar', async ({ page, request }) => {
        await crearRuta(request, { ruta: '/e2e/para-el-log', respuesta: '{"x":1}' });
        await request.get('/e2e/para-el-log');
        await esperarEnElLog(request, '/e2e/para-el-log');

        await page.goto('/logs');
        await expect(page.locator('.logs-table')).toBeVisible();

        // El log se escribe por lotes cada 500 ms, así que puede tardar un poco
        await expect(page.locator('#logsBody')).toContainText('/e2e/para-el-log');
    });

    test('abre la traza de una petición y enseña sus pasos', async ({ page, request }) => {
        await crearRuta(request, { ruta: '/e2e/para-la-traza', respuesta: '{"x":2}' });
        await request.get('/e2e/para-la-traza');
        await esperarEnElLog(request, '/e2e/para-la-traza');

        await page.goto('/logs');
        await expect(page.locator('#logsBody')).toContainText('/e2e/para-la-traza');

        // El botón del diagrama solo está en las filas que tienen traza
        await page.locator('#logsBody button[title]').filter({ has: page.locator('i.fa-project-diagram') }).first().click();

        await expect(page.locator('#traceModal, .modal:visible').first()).toBeVisible();
        await expect(page.locator('#traceTimeline')).toBeVisible();
        // Toda petición atendida pasa al menos por estos dos
        await expect(page.locator('#traceTimeline')).toContainText('request');
        await expect(page.locator('#traceTimeline')).toContainText('response');
    });

    test('el filtro de método reduce lo que se ve', async ({ page, request }) => {
        await crearRuta(request, { tipo: 'post', ruta: '/e2e/solo-post' });
        await request.post('/e2e/solo-post', { data: {} });
        await esperarEnElLog(request, '/e2e/solo-post');

        await page.goto('/logs');
        await expect(page.locator('#logsBody')).toContainText('/e2e/solo-post');

        await page.selectOption('#logMethod', 'GET');
        await expect(page.locator('#logsBody')).not.toContainText('/e2e/solo-post');

        await page.selectOption('#logMethod', 'POST');
        await expect(page.locator('#logsBody')).toContainText('/e2e/solo-post');
    });
});

/**
 * El formulario de ruta se enseña por secciones.
 *
 * Antes eran veinticuatro bloques en una columna, tres pantallas y media de
 * scroll. Estas pruebas cubren lo que se rompe en silencio al reorganizar:
 * que cada sección enseñe lo suyo, que el índice resuma lo configurado, y que
 * cambiar el tipo de ruta no deje al usuario encerrado.
 */
test.describe('secciones del formulario de ruta', () => {

    async function abrirFormulario(page) {
        await page.goto('/');
        await page.click('button:has-text("Nueva ruta"), button:has-text("New route"), button:has-text("Nova ruta")');
        await expect(page.locator('#routesModal')).toBeVisible();
    }

    test('abre en Ruta y respuesta, con el cuerpo a la vista', async ({ page }) => {
        await abrirFormulario(page);

        await expect(page.locator('.route-nav-section.active')).toContainText(/Ruta y respuesta|Route and response|Ruta e resposta/);
        await expect(page.locator('#respuesta')).toBeVisible();
        // Lo de otras secciones no debe estar delante
        await expect(page.locator('#divFaults')).not.toBeVisible();
    });

    test('cambiar de sección cambia lo que se ve', async ({ page }) => {
        await abrirFormulario(page);

        await page.click('.route-nav-section[data-section-key="comportamiento"]');
        await expect(page.locator('#latencyMode')).toBeVisible();
        await expect(page.locator('#respuesta')).not.toBeVisible();

        await page.click('.route-nav-section[data-section-key="respuesta"]');
        await expect(page.locator('#respuesta')).toBeVisible();
        await expect(page.locator('#latencyMode')).not.toBeVisible();
    });

    test('el índice resume lo que hay configurado', async ({ page }) => {
        await abrirFormulario(page);

        await page.click('.route-nav-section[data-section-key="comportamiento"]');
        await page.selectOption('#latencyMode', 'fixed');
        await page.fill('#latencyMs', '400');
        await page.fill('#faultRate', '10');

        // Sin abrir la sección se ve lo que lleva puesto, que es la gracia
        await expect(page.locator('#navState-comportamiento')).toContainText('400 ms');
        await expect(page.locator('#navState-comportamiento')).toContainText('10%');
    });

    test('se puede volver a mock después de elegir proxy', async ({ page }) => {
        // Regresión: el selector de tipo vivía dentro de la sección "Respuesta",
        // así que al pasar a proxy se escondía con ella y no había forma de
        // deshacerlo sin cerrar el formulario
        await abrirFormulario(page);

        await page.selectOption('#tiporespuesta', 'proxy');
        await expect(page.locator('#destinoProxy')).toBeVisible();
        await expect(page.locator('#tiporespuesta')).toBeVisible();

        await page.selectOption('#tiporespuesta', 'json');
        await expect(page.locator('#respuesta')).toBeVisible();
    });

    test('las secciones se ajustan al tipo de ruta', async ({ page }) => {
        await abrirFormulario(page);

        const visibles = async () =>
            page.locator('.route-nav-section:visible').evaluateAll(
                nodos => nodos.map(n => n.dataset.sectionKey));

        expect(await visibles()).toEqual(['respuesta', 'variacion', 'comportamiento', 'organizacion']);

        await page.selectOption('#tiporespuesta', 'proxy');
        // Un proxy no tiene cuerpo propio ni condiciones: resuelve con fallbacks
        expect(await visibles()).toEqual(['proxy', 'comportamiento']);
    });

    test('editar una ruta existente carga sus secciones', async ({ page, request }) => {
        await crearRuta(request, { ruta: '/e2e/para-editar', respuesta: '{"x":1}' });

        await page.goto('/');
        await expect(page.locator('#dtList')).toContainText('/e2e/para-editar');
        await page.locator('#dtList tr', { hasText: '/e2e/para-editar' })
            .locator('button[title*="dit"], button[title*="ditar"]').first().click();

        await expect(page.locator('#routesModal')).toBeVisible();
        await expect(page.locator('#ruta')).toHaveValue('/e2e/para-editar');
        // La cabecera del índice recuerda qué ruta se edita
        await expect(page.locator('#routeNavTitle')).toContainText('/e2e/para-editar');
    });
});
