/**
 * Autenticación de la API
 *
 * La API v1 la usan scripts de otras máquinas, así que puede hacer falta un
 * token; el panel, que vive en la misma pantalla que el servidor, nunca lo pidió.
 * Por eso viene abierta por defecto: exigirlo de entrada rompería a todo el que
 * ya llama al servidor desde su suite de pruebas, y en un mock server local no
 * hay nada que proteger.
 *
 * Con MOCK_SERVER_API_AUTH=required se exige `Authorization: Bearer <token>` en
 * todo /api/v1. Valen dos clases de token:
 *
 * - MOCK_SERVER_API_TOKEN, fijo y puesto por quien despliega. Es lo que quiere
 *   un CI: no hay pantalla donde crear nada.
 * - Los creados desde el panel, que son los mismos que usa el servidor MCP. Así
 *   no hay dos listas de credenciales que revocar por separado.
 *
 * Un token equivocado se rechaza SIEMPRE, también con la API abierta: pasarlo
 * por alto haría creer que la credencial es buena hasta el día que se cierre.
 */

const sqliteService = require('../services/sqlite.service');

const tokenFijo = () => process.env.MOCK_SERVER_API_TOKEN || null;
const exigido = () => String(process.env.MOCK_SERVER_API_AUTH || '').toLowerCase() === 'required';

/**
 * Cómo está configurada la autenticación, para contarlo en la pantalla de
 * documentación y en /api/v1/server sin tener que leer el entorno desde la vista
 */
function estado() {
    return {
        required: exigido(),
        scheme: 'bearer',
        static_token_configured: Boolean(tokenFijo())
    };
}

async function comprobar(token) {
    if (tokenFijo() && token === tokenFijo()) {
        return { id: 'env', nombre: 'MOCK_SERVER_API_TOKEN' };
    }
    const registro = await sqliteService.findMcpToken(token);
    if (registro) {
        sqliteService.touchMcpToken(registro.id);
        return registro;
    }
    return null;
}

async function authenticate(req, res, next) {
    const cabecera = req.headers.authorization || '';
    const match = cabecera.match(/^Bearer\s+(.+)$/i);

    if (!match) {
        if (!exigido()) return next();
        return res.status(401)
            .set('WWW-Authenticate', 'Bearer realm="mock-server"')
            .json({ error: 'Missing Authorization: Bearer <token> header', code: 'unauthorized' });
    }

    try {
        const registro = await comprobar(match[1].trim());
        if (!registro) {
            console.log('[API] Token rechazado');
            return res.status(401).json({ error: 'Invalid or revoked token', code: 'unauthorized' });
        }
        req.apiToken = registro;
        next();
    } catch (error) {
        console.error(`[API] Error comprobando el token: ${error.message}`);
        res.status(500).json({ error: 'Could not check the token', code: 'internal_error' });
    }
}

module.exports = { authenticate, estado };
