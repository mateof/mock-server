const crypto = require('crypto');

const COOKIE = 'mock-server-access';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'];

const claveConfigurada = () => process.env.MOCK_SERVER_ACCESS_KEY || null;

const resumen = (valor) => crypto.createHash('sha256').update(`mock-server:${valor}`).digest();

function iguales(a, b) {
    return crypto.timingSafeEqual(resumen(a), resumen(b));
}

function esClave(valor) {
    const clave = claveConfigurada();
    return Boolean(clave && valor) && iguales(String(valor), clave);
}

function valorCookie() {
    return resumen(claveConfigurada()).toString('hex');
}

function leerCookie(req, nombre) {
    if (req.cookies && nombre in req.cookies) return req.cookies[nombre];
    const cabecera = req.headers.cookie || '';
    for (const trozo of cabecera.split(';')) {
        const [k, ...v] = trozo.trim().split('=');
        if (k === nombre) {
            try {
                return decodeURIComponent(v.join('='));
            } catch {
                return null;
            }
        }
    }
    return null;
}

function bearer(req) {
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

function esLocal(req) {
    const direccion = (req.socket || req.connection || {}).remoteAddress || '';
    if (direccion !== '::1' && !/^(::ffff:)?127\./.test(direccion)) return false;
    return !FORWARDING_HEADERS.some((cabecera) => req.headers[cabecera]);
}

function cookieValida(req) {
    const cookie = leerCookie(req, COOKIE);
    if (!cookie || !/^[0-9a-f]{64}$/.test(cookie)) return false;
    return crypto.timingSafeEqual(Buffer.from(cookie, 'hex'), Buffer.from(valorCookie(), 'hex'));
}

function permitido(req) {
    if (!claveConfigurada() || esLocal(req)) return true;
    return esClave(bearer(req)) || esClave(req.headers['x-api-key']) || cookieValida(req);
}

function estado() {
    return { remote_access_key_required: Boolean(claveConfigurada()) };
}

function esDelPanel(router, req) {
    return router.stack.some((layer) => layer.route && layer.match(req.path) && layer.route._handles_method(req.method));
}

function esAdministracion(router, req) {
    const ruta = req.path;
    if (ruta === '/api/access' || ruta.startsWith('/api/access/')) return false;
    if (ruta === '/api' || ruta.startsWith('/api/')) return true;
    return esDelPanel(router, req);
}

function rechazar(req, res) {
    if (req.method === 'GET' && req.accepts(['json', 'html']) === 'html') {
        res.status(401).render('access', { layout: false, siguiente: req.originalUrl, error: false });
        return;
    }
    res.status(401)
        .set('WWW-Authenticate', 'Bearer realm="mock-server"')
        .json({ error: 'This server only lets other machines in with its access key', code: 'access_key_required' });
}

function guardia(panelRouter) {
    return function guardiaDeAcceso(req, res, next) {
        if (!claveConfigurada() || !esAdministracion(panelRouter, req)) return next();
        if (permitido(req)) return next();
        if ((req.path === '/api/v1' || req.path.startsWith('/api/v1/')) && bearer(req)) return next();
        rechazar(req, res);
    };
}

function destinoSeguro(valor) {
    const destino = String(valor || '/');
    return destino.startsWith('/') && !destino.startsWith('//') && !destino.startsWith('/\\') ? destino : '/';
}

function opcionesCookie() {
    return { httpOnly: true, sameSite: 'strict', path: '/', maxAge: COOKIE_MAX_AGE_MS };
}

module.exports = {
    COOKIE,
    bearer,
    cookieValida,
    destinoSeguro,
    esClave,
    esLocal,
    estado,
    guardia,
    opcionesCookie,
    permitido,
    valorCookie
};
