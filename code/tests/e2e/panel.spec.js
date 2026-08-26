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
        await page.locator('#logsBody button[title]').filter({ has: page.locator('i.fa-sitemap') }).first().click();

        // La traza ocupa el sitio de la lista, no un modal encima
        await expect(page.locator('#logsTracePanel')).toBeVisible();
        await expect(page.locator('#logsListSection')).toBeHidden();
        // Filtros y botones de la lista se retiran: no actúan sobre la traza.
        // Se comprueba porque .d-flex es display:flex !important y le ganaba al
        // display:none, dejándolos puestos sin que nada fallara
        await expect(page.locator('#logsFilters')).toBeHidden();
        await expect(page.locator('#logsListActions')).toBeHidden();
        await expect(page.locator('#traceTimeline')).toBeVisible();
        // Toda petición atendida pasa al menos por estos dos
        await expect(page.locator('#traceTimeline')).toContainText('request');
        await expect(page.locator('#traceTimeline')).toContainText('response');

        // Y se puede volver, con todo donde estaba
        await page.click('#logsTraceBackBtn');
        await expect(page.locator('#logsListSection')).toBeVisible();
        await expect(page.locator('#logsTracePanel')).toBeHidden();
        await expect(page.locator('#logsFilters')).toBeVisible();
        await expect(page.locator('#logsListActions')).toBeVisible();
    });

    test('cada nivel lleva su icono, no solo su color', async ({ page, request }) => {
        await crearRuta(request, { ruta: '/e2e/nivel-con-icono' });
        await request.get('/e2e/nivel-con-icono');
        await esperarEnElLog(request, '/e2e/nivel-con-icono');

        await page.goto('/logs');
        await expect(page.locator('#logsBody')).toContainText('/e2e/nivel-con-icono');

        // Font Awesome 4.7 pinta vacío cualquier nombre de FA5/FA6 sin quejarse,
        // así que no basta con que el <i> esté: tiene que tener glifo
        const sinGlifo = await page.evaluate(() => {
            const malos = [];
            document.querySelectorAll('#logsBody .logs-level').forEach(nivel => {
                const icono = nivel.querySelector('i.fa');
                if (!icono) { malos.push(nivel.textContent.trim() + ': sin <i>'); return; }
                const c = getComputedStyle(icono, ':before').content;
                if (!c || c === 'none' || c === '""') malos.push(nivel.textContent.trim() + ': ' + icono.className);
            });
            return malos;
        });
        expect(sinGlifo).toEqual([]);
        expect(await page.locator('#logsBody .logs-level i.fa').count()).toBeGreaterThan(0);

        // Lo de arriba solo cubre los niveles que hayan salido, y en una prueba
        // limpia salen success e info y ninguno más. Los cuatro se comprueban
        // contra la tabla, que es donde está el nombre que puede estar mal
        const rotos = await page.evaluate(() => {
            const malos = [];
            for (const [nivel, clase] of Object.entries(LogsView.ICONO_NIVEL)) {
                const i = document.createElement('i');
                i.className = 'fa ' + clase;
                document.body.appendChild(i);
                const c = getComputedStyle(i, ':before').content;
                if (!c || c === 'none' || c === '""') malos.push(nivel + ': ' + clase);
                i.remove();
            }
            return malos;
        });
        expect(rotos).toEqual([]);
        expect(Object.keys(await page.evaluate(() => LogsView.ICONO_NIVEL)).sort())
            .toEqual(['error', 'info', 'success', 'warning']);
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
/**
 * El log se mira mientras se toca una ruta, así que además de su pantalla se
 * abre sin salir de la lista. Lo que se prueba aquí es lo que separa "abre un
 * modal" de "funciona": que no se navegue, que la traza no intente ser un
 * segundo modal encima del primero (Bootstrap 5 no lo soporta), y que cerrarlo
 * pare el seguimiento en vivo en vez de dejarlo consultando a escondidas.
 */
test.describe('el log dentro de la lista de rutas', () => {

    test('se abre desde la barra sin salir de la lista', async ({ page, request }) => {
        await crearRuta(request, { ruta: '/e2e/log-en-modal' });
        await request.get('/e2e/log-en-modal');
        await esperarEnElLog(request, '/e2e/log-en-modal');

        await page.goto('/');
        await expect(page.locator('#logsModal')).toBeHidden();

        await page.click('.btn-nav-top[href="/logs"]');
        await expect(page.locator('#logsModal')).toBeVisible();
        await expect(page.locator('#logsBody')).toContainText('/e2e/log-en-modal');

        // Lo que distingue esto de un enlace: la lista sigue detrás
        expect(new URL(page.url()).pathname).toBe('/');
        await expect(page.locator('#dtList').first()).toBeAttached();
    });

    test('la traza se abre dentro, sin un segundo modal encima', async ({ page, request }) => {
        await crearRuta(request, { ruta: '/e2e/traza-en-modal' });
        await request.get('/e2e/traza-en-modal');
        await esperarEnElLog(request, '/e2e/traza-en-modal');

        await page.goto('/');
        await page.click('.btn-nav-top[href="/logs"]');
        await expect(page.locator('#logsBody')).toContainText('/e2e/traza-en-modal');

        await page.locator('#logsBody button').filter({ has: page.locator('i.fa-sitemap') }).first().click();
        await expect(page.locator('#traceTimeline')).toContainText('request');

        // Un modal, un fondo. Dos fondos es la pila que Bootstrap no soporta
        expect(await page.locator('.modal-backdrop').count()).toBe(1);
        await expect(page.locator('#logsModal')).toBeVisible();
    });

    test('cerrarlo para el seguimiento en vivo', async ({ page }) => {
        await page.goto('/');
        await page.click('.btn-nav-top[href="/logs"]');
        await expect(page.locator('#logsModal')).toBeVisible();

        await page.click('#logsLiveBtn');
        expect(await page.evaluate(() => LogsView.live)).toBe(true);

        await page.click('#logsModal [data-bs-dismiss="modal"]');
        await expect(page.locator('#logsModal')).toBeHidden();
        // Si no, seguiría consultando cada tres segundos contra algo que no se ve
        expect(await page.evaluate(() => LogsView.live)).toBe(false);
    });
});

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

        expect(await visibles()).toEqual(
            ['respuesta', 'variacion', 'comportamiento', 'documentacion', 'organizacion']);

        await page.selectOption('#tiporespuesta', 'proxy');
        // Un proxy no tiene cuerpo propio ni condiciones: resuelve con fallbacks.
        // La documentación sí le aplica: explicar a qué backend apunta y cuándo
        // usarlo es justo lo que hace falta ahí
        expect(await visibles()).toEqual(['proxy', 'comportamiento', 'documentacion']);
    });

    test('editar una ruta existente carga sus secciones', async ({ page, request }) => {
        await crearRuta(request, { ruta: '/e2e/para-editar', respuesta: '{"x":1}' });

        await page.goto('/');
        // La tabla pagina de diez en diez: buscar la ruta sin filtrar la
        // encuentra solo mientras el resto de pruebas no llenen la primera
        // pagina, que es una condicion que se rompe sola al anadir pruebas
        await page.fill('#filterRouteValue', '/e2e/para-editar');
        await expect(page.locator('#dtList')).toContainText('/e2e/para-editar');
        await page.locator('#dtList tr', { hasText: '/e2e/para-editar' })
            .locator('button[title*="dit"], button[title*="ditar"]').first().click();

        await expect(page.locator('#routesModal')).toBeVisible();
        await expect(page.locator('#ruta')).toHaveValue('/e2e/para-editar');
        // La cabecera del índice recuerda qué ruta se edita
        await expect(page.locator('#routeNavTitle')).toContainText('/e2e/para-editar');
    });
});

/**
 * Documentación de la ruta.
 *
 * Es el sitio donde se dejan instrucciones para quien use la ruta después,
 * persona o asistente. Lo que se prueba aquí es que el texto sobrevive el viaje
 * completo: se escribe en el panel, se guarda, y sigue ahí al reabrir.
 */
test.describe('documentación de la ruta', () => {

    test('tiene su propia sección, no escondida en Metadata', async ({ page }) => {
        await page.goto('/');
        await page.click('button:has-text("Nueva ruta"), button:has-text("New route"), button:has-text("Nova ruta")');
        await expect(page.locator('#routesModal')).toBeVisible();

        await page.click('.route-nav-section[data-section-key="documentacion"]');
        await expect(page.locator('#description')).toBeVisible();

        // Con sitio de sobra: como textarea de tres líneas no invitaba a escribir
        const alto = (await page.locator('#description').boundingBox()).height;
        expect(alto).toBeGreaterThan(250);
    });

    test('lo escrito se guarda y sigue ahí al reabrir', async ({ page }) => {
        const texto = '## Qué simula\nEl listado de pedidos.\n\n## Ojo\nNecesita la cabecera X-Cliente.';

        await page.goto('/');
        await page.click('button:has-text("Nueva ruta"), button:has-text("New route"), button:has-text("Nova ruta")');
        await page.fill('#ruta', '/e2e/documentada');
        await page.fill('#respuesta', '{"ok":true}');
        await page.click('.route-nav-section[data-section-key="documentacion"]');
        await page.fill('#description', texto);
        await page.click('#botonguardar');

        await page.fill('#filterRouteValue', '/e2e/documentada');
        await expect(page.locator('#dtList')).toContainText('/e2e/documentada', { timeout: 10000 });

        await page.locator('#dtList tr', { hasText: '/e2e/documentada' })
            .locator('button[title*="dit"]').first().click();
        await expect(page.locator('#routesModal')).toBeVisible();
        await page.click('.route-nav-section[data-section-key="documentacion"]');
        await expect(page.locator('#description')).toHaveValue(texto);
    });

    test('el índice dice cuánta documentación hay sin abrirla', async ({ page }) => {
        await page.goto('/');
        await page.click('button:has-text("Nueva ruta"), button:has-text("New route"), button:has-text("Nova ruta")');

        // Sin nada escrito lo dice, que es distinto de no decir nada
        await expect(page.locator('#navState-documentacion')).not.toHaveText('');

        await page.click('.route-nav-section[data-section-key="documentacion"]');
        await page.fill('#description', 'una dos tres cuatro cinco');
        await expect(page.locator('#navState-documentacion')).toContainText('5');
    });

    test('lo que escribe el asistente por API se ve en el panel', async ({ page, request }) => {
        const id = await crearRuta(request, { ruta: '/e2e/docs-por-api' });

        const r = await request.put(`/api/routes/${id}/docs`, {
            data: { docs: '## Escrito desde fuera\nEsto lo dejó un asistente.' }
        });
        expect(r.ok()).toBeTruthy();

        await page.goto('/');
        await page.fill('#filterRouteValue', '/e2e/docs-por-api');
        await expect(page.locator('#dtList')).toContainText('/e2e/docs-por-api');
        await page.locator('#dtList tr', { hasText: '/e2e/docs-por-api' })
            .locator('button[title*="dit"]').first().click();
        await page.click('.route-nav-section[data-section-key="documentacion"]');
        await expect(page.locator('#description')).toHaveValue(/Escrito desde fuera/);
    });

    test('guardar la documentación no toca el resto de la ruta', async ({ page, request }) => {
        // El endpoint escribe una columna y nada más: es lo que hace seguro que
        // un asistente documente una ruta que no configuró él
        const id = await crearRuta(request, { ruta: '/e2e/intacta', codigo: '201', respuesta: '{"a":1}' });

        await request.put(`/api/routes/${id}/docs`, { data: { docs: 'solo documentación' } });

        const despues = await request.get('/e2e/intacta');
        expect(despues.status()).toBe(201);
        expect(await despues.json()).toEqual({ a: 1 });
    });
});

/**
 * Tags puestos por quien no pasa por el panel (un asistente por MCP, la API).
 *
 * El registro de tags identifica por nombre y reparte uuids; el filtro del
 * panel casa por id. Guardar en una ruta un tag que el registro no conoce
 * dejaba el desplegable vacío, y si el tag se creaba después a mano, el id ya
 * no coincidía y filtrar por él seguía sin encontrar la ruta.
 */
test.describe('tags creados fuera del panel', () => {

    test('un tag nuevo aparece en el filtro y encuentra su ruta', async ({ page, request }) => {
        // Sin id, que es justo lo que manda un asistente por MCP
        await crearRuta(request, {
            ruta: '/e2e/con-tag-externo',
            tags: [{ name: 'e2e-externo', color: '#10b981' }]
        });

        await page.goto('/');
        await page.click('#tagsFilterDropdown');
        await expect(page.locator('#tagsFilterMenu')).toContainText('e2e-externo');

        await page.locator('#tagsFilterMenu label', { hasText: 'e2e-externo' })
            .locator('input').check();
        await expect(page.locator('#dtList')).toContainText('/e2e/con-tag-externo');
    });

    test('reutiliza el tag que ya existía en vez de duplicarlo', async ({ page, request }) => {
        const creado = await request.post('/api/tags', {
            data: { name: 'e2e-compartido', color: '#6366f1' }
        });
        const { tag } = await creado.json();

        // Se manda solo el nombre: el servidor tiene que dar con el id de arriba
        await crearRuta(request, {
            ruta: '/e2e/reusa-tag',
            tags: [{ name: 'e2e-compartido' }]
        });

        const rutas = await (await request.get('/api/routes')).json();
        const ruta = (Array.isArray(rutas) ? rutas : rutas.routes)
            .find(r => r.ruta === '/e2e/reusa-tag');
        expect(JSON.parse(ruta.tags)[0].id).toBe(tag.id);

        // Y no se ha creado un segundo tag con el mismo nombre
        const { tags } = await (await request.get('/api/tags')).json();
        expect(tags.filter(t => t.name === 'e2e-compartido')).toHaveLength(1);
    });
});

/**
 * Barra de acciones sobre la selección y cabecera reducida.
 *
 * Antes había nueve botones arriba mezclando acciones sobre selección,
 * navegación y creación. Lo global se fue a la barra superior y las acciones
 * sobre selección a una barra que aparece al marcar rutas.
 */
test.describe('acciones sobre la selección', () => {

    test('la cabecera se queda en dos controles', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('.header-actions > *')).toHaveCount(2);
        // Y la navegación vive arriba, que vale en cualquier pantalla
        await expect(page.locator('.btn-nav-top[href="/logs"]')).toBeVisible();
    });

    test('la barra aparece solo al seleccionar', async ({ page, request }) => {
        await crearRuta(request, { ruta: '/e2e/bulk-uno' });
        await crearRuta(request, { ruta: '/e2e/bulk-dos' });

        await page.goto('/');
        await page.fill('#filterRouteValue', '/e2e/bulk-');
        await expect(page.locator('#bulkBar')).not.toBeVisible();

        await page.locator('.route-select-check').first().check();
        await expect(page.locator('#bulkBar')).toBeVisible();
        await expect(page.locator('#bulkCount')).toContainText('1');

        await page.locator('.route-select-check').nth(1).check();
        await expect(page.locator('#bulkCount')).toContainText('2');

        await page.click('.bulk-clear');
        await expect(page.locator('#bulkBar')).not.toBeVisible();
    });

    test('aplica latencia a varias rutas de una vez', async ({ page, request }) => {
        const id = await crearRuta(request, { ruta: '/e2e/bulk-lenta' });

        await page.goto('/');
        // La tabla pagina: sin filtrar, una ruta creada al final cae en la
        // página dos y no está en el DOM para poder marcarla
        await page.fill('#filterRouteValue', '/e2e/bulk-lenta');
        await expect(page.locator('#dtList tbody tr')).toHaveCount(1);
        await page.locator('.route-select-check').first().check();

        await page.click('#bulkBehaviourBtn');
        await page.fill('#bulkLatencyMs', '250');

        // Se espera a que el guardado responda: sin esto la medición de abajo
        // podía correr antes de que la latencia estuviera puesta
        const guardado = page.waitForResponse(r =>
            r.url().includes('/api/routes/bulk-behaviour') && r.status() === 200);
        await page.click('#bulkApplyLatency');
        await guardado;

        // La comprobación de verdad es que la ruta tarda, no que salga un aviso
        const inicio = Date.now();
        await request.get('/e2e/bulk-lenta');
        expect(Date.now() - inicio).toBeGreaterThan(200);
    });

    test('etiqueta la selección sin abrir ruta por ruta', async ({ page, request }) => {
        const tagRes = await request.post('/api/tags', { data: { name: 'e2e-bulk', color: '#8b5cf6' } });
        const { tag } = await tagRes.json();
        await crearRuta(request, { ruta: '/e2e/bulk-tag' });

        await page.goto('/');
        await page.fill('#filterRouteValue', '/e2e/bulk-tag');
        await expect(page.locator('#dtList tbody tr')).toHaveCount(1);
        await page.locator('.route-select-check').first().check();

        await page.click('#bulkTagsBtn');
        await page.locator('#bulkTagsAdd').getByText('e2e-bulk').click();

        await expect(page.locator('#dtList tbody tr').first()).toContainText('e2e-bulk');
    });
});

/**
 * Entornos.
 *
 * El selector vive en la barra porque el entorno activo es estado global: no
 * es una preferencia de la pestaña, decide lo que responde el servidor.
 */
test.describe('entornos', () => {

    test('el selector está en la barra y lista los entornos', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('#envActiveName')).not.toHaveText('');

        await page.click('.btn-env');
        await expect(page.locator('#envMenu')).toBeVisible();
        await expect(page.locator('#envMenuList .env-menu-item')).not.toHaveCount(0);
    });

    test('una variable definida se sustituye y una que falta se respeta', async ({ page, request }) => {
        const entornos = await (await request.get('/api/environments')).json();
        const activo = entornos.environments.find(e => e.active);

        await request.put(`/api/environments/${activo.id}/variables`, {
            data: { variables: [...activo.variables, { key: 'E2E_VALOR', value: 'definido' }] }
        });
        await crearRuta(request, {
            ruta: '/e2e/con-variables',
            respuesta: '{"hay":"${E2E_VALOR}","falta":"${E2E_NO_EXISTE}"}'
        });

        const r = await request.get('/e2e/con-variables');
        const cuerpo = await r.json();
        expect(cuerpo.hay).toBe('definido');
        // Sin definir se queda tal cual: vaciarlo destrozaría un texto ajeno
        expect(cuerpo.falta).toBe('${E2E_NO_EXISTE}');
    });

    test('avisa de las variables que ninguna definición cubre', async ({ page, request }) => {
        await crearRuta(request, { ruta: '/e2e/pide-variable', respuesta: '{"x":"${E2E_SIN_DEFINIR}"}' });

        await page.goto('/');
        await expect(page.locator('#envWarningDot')).toBeVisible();
        await expect(page.locator('#envWarningDot')).toHaveAttribute('title', /E2E_SIN_DEFINIR/);
    });
});

/**
 * Detalles de la interfaz que se rompen en silencio.
 *
 * Los iconos y la posición de un desplegable no los nota ninguna prueba de
 * servidor: se ven o no se ven, y hay que mirarlos.
 */
test.describe('detalles visuales', () => {

    test('no hay iconos rotos en ninguna pantalla', async ({ page }) => {
        // El proyecto usa Font Awesome 4.7 y es fácil escribir nombres de FA5 o
        // FA6, que no fallan: simplemente no pintan nada
        const sinGlifo = async () => page.evaluate(() => {
            const malos = [];
            document.querySelectorAll('i.fa').forEach(el => {
                const contenido = getComputedStyle(el, ':before').content;
                if (!contenido || contenido === 'none' || contenido === '""') malos.push(el.className);
            });
            return malos;
        });

        await page.goto('/');
        expect(await sinGlifo()).toEqual([]);

        await page.goto('/logs');
        expect(await sinGlifo()).toEqual([]);
    });

    test('los menús de la barra bulk salen pegados a su botón', async ({ page, request }) => {
        // Regresión: el CSS los deja en top:0/left:0 hasta que alguien los
        // coloca, así que sin posicionarlos aparecían arriba a la izquierda
        await crearRuta(request, { ruta: '/e2e/menus' });

        await page.goto('/');
        await page.fill('#filterRouteValue', '/e2e/menus');
        await page.locator('.route-select-check').first().check();

        for (const [boton, menu] of [['#bulkTagsBtn', '#bulkTagsMenu'],
                                     ['#bulkBehaviourBtn', '#bulkBehaviourMenu']]) {
            await page.click(boton);
            const caja = await page.locator(menu).boundingBox();
            const ref = await page.locator(boton).boundingBox();
            expect(Math.abs(caja.x - ref.x)).toBeLessThan(20);
            expect(caja.y).toBeGreaterThan(ref.y);
        }
    });

    test('la selección sobrevive a que se repinte la tabla', async ({ page, request }) => {
        // Regresión: el refresco del uso repinta la tabla cada 30 s, y con la
        // marca solo en la casilla se perdía sola mientras la barra seguía
        // diciendo que había rutas elegidas. Pulsar una acción no hacía nada.
        await crearRuta(request, { ruta: '/e2e/persiste-1' });
        await crearRuta(request, { ruta: '/e2e/persiste-2' });

        await page.goto('/');
        await page.fill('#filterRouteValue', '/e2e/persiste-');
        await expect(page.locator('#dtList tbody tr')).toHaveCount(2);
        await page.locator('.route-select-check').nth(0).check();
        await page.locator('.route-select-check').nth(1).check();
        await expect(page.locator('#bulkCount')).toContainText('2');

        // Lo que hace el refresco automático
        await page.evaluate(() => cargarUsoDeRutas());
        await expect(page.locator('.route-select-check:checked')).toHaveCount(2);
        await expect(page.locator('#bulkCount')).toContainText('2');

        // Y al reordenar, que también recrea las celdas
        await page.click('#dtList thead th:nth-child(5)');
        await expect(page.locator('.route-select-check:checked')).toHaveCount(2);
    });

    test('se puede crear un tag desde la barra y queda aplicado', async ({ page, request }) => {
        await crearRuta(request, { ruta: '/e2e/tag-al-vuelo' });

        await page.goto('/');
        await page.fill('#filterRouteValue', '/e2e/tag-al-vuelo');
        await page.locator('.route-select-check').first().check();

        await page.click('#bulkTagsBtn');
        await page.fill('#bulkNewTag', 'e2e-al-vuelo');
        await page.click('#bulkTagsMenu .bulk-new-tag button');

        // Aplicado a la ruta y registrado, que es lo que lo hace aparecer luego
        // en el filtro de tags
        await expect(page.locator('#dtList tbody tr').first()).toContainText('e2e-al-vuelo');
        const { tags } = await (await request.get('/api/tags')).json();
        expect(tags.some(t => t.name === 'e2e-al-vuelo')).toBe(true);
    });
});
