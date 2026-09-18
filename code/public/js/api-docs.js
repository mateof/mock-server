/**
 * Pantalla de documentación de la API
 *
 * Monta Swagger UI contra el contrato que sirve el propio servidor, así que lo
 * que se ve aquí es siempre lo que esta instancia sabe hacer, no lo que sabía
 * hacer la versión con la que se escribió la página.
 *
 * El "Try it out" llama a este mismo servidor: probar desde aquí crea rutas de
 * verdad y mueve las que hay.
 */
const ApiDocs = (() => {
    const CLAVE = 'mock-server-api-token';
    let ui = null;

    // localStorage puede estar bloqueado (ventana privada, cookies de terceros):
    // que falle no puede dejar la pantalla sin Swagger
    function leerToken() {
        try { return localStorage.getItem(CLAVE) || ''; } catch (e) { return ''; }
    }

    function guardarToken(valor) {
        try {
            if (valor) localStorage.setItem(CLAVE, valor);
            else localStorage.removeItem(CLAVE);
        } catch (e) { /* sin persistencia, pero la sesión sigue funcionando */ }
    }

    function aplicarAutorizacion() {
        const token = leerToken();
        if (!ui || !ui.authActions) return;

        if (token) {
            ui.authActions.authorize({
                bearerAuth: {
                    name: 'bearerAuth',
                    schema: { type: 'http', scheme: 'bearer' },
                    value: token
                }
            });
            return;
        }

        // logout() revienta si no había nada autorizado, así que se pregunta
        // antes: si no, la pantalla suelta dos errores de consola al abrirse sin
        // token, que es el caso normal
        const autorizado = ui.authSelectors && ui.authSelectors.authorized
            ? ui.authSelectors.authorized()
            : null;
        if (autorizado && typeof autorizado.get === 'function' && autorizado.get('bearerAuth')) {
            ui.authActions.logout(['bearerAuth']);
        }
    }

    function saveToken() {
        const input = document.getElementById('apiToken');
        guardarToken(input.value.trim());
        aplicarAutorizacion();
        if (typeof showToast === 'function') showToast(t('apiDocs.tokenSaved'), 'success');
    }

    function clearToken() {
        document.getElementById('apiToken').value = '';
        guardarToken('');
        aplicarAutorizacion();
        if (typeof showToast === 'function') showToast(t('apiDocs.tokenCleared'), 'info');
    }

    /**
     * Si la API pide token o no lo decide el servidor, no la pantalla: se
     * pregunta en vez de suponerlo, que es lo que evita el "pego el token y
     * sigue sin hacer falta" y el contrario
     */
    async function estadoAutenticacion() {
        const caja = document.getElementById('apiAuthState');
        try {
            const respuesta = await fetch('/api/v1/health');
            const datos = await respuesta.json();
            const requerido = datos.auth && datos.auth.required;

            caja.className = `api-docs-auth-state ${requerido ? 'is-closed' : 'is-open'}`;
            caja.innerHTML = requerido
                ? `<i class="fa fa-lock"></i> ${t('apiDocs.authRequired')}`
                : `<i class="fa fa-unlock"></i> ${t('apiDocs.authOpen')}`;
        } catch (e) {
            caja.className = 'api-docs-auth-state';
            caja.innerHTML = `<i class="fa fa-exclamation-triangle"></i> ${t('apiDocs.authUnknown')}`;
        }
    }

    function init() {
        const input = document.getElementById('apiToken');
        if (input) {
            input.value = leerToken();
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveToken(); });
        }

        ui = SwaggerUIBundle({
            url: '/api/v1/openapi.json',
            dom_id: '#swagger-ui',
            presets: [SwaggerUIBundle.presets.apis],
            layout: 'BaseLayout',
            deepLinking: true,
            // Cerrado de inicio: son sesenta operaciones y abiertas de golpe no
            // se encuentra nada
            docExpansion: 'none',
            defaultModelsExpandDepth: 0,
            defaultModelRendering: 'example',
            filter: true,
            tryItOutEnabled: true,
            persistAuthorization: true,
            displayRequestDuration: true,
            syntaxHighlight: { activate: true, theme: 'obsidian' },
            requestInterceptor: (req) => {
                // El token se pone aquí también, y no solo con "Authorize": así
                // vale igual si se pegó arriba y no se tocó el diálogo
                const token = leerToken();
                if (token && !req.headers.Authorization) {
                    req.headers.Authorization = `Bearer ${token}`;
                }
                return req;
            },
            onComplete: aplicarAutorizacion
        });

        estadoAutenticacion();
    }

    return { init, saveToken, clearToken };
})();
