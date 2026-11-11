const express = require('express');
const access = require('../../services/access.service');

const CLAVE = 'clave-de-prueba-123';

function peticion({ direccion = '192.168.1.50', cabeceras = {}, cookies } = {}) {
    return { socket: { remoteAddress: direccion }, headers: cabeceras, cookies };
}

function panel() {
    const router = express.Router();
    router.get('/', (req, res) => res.end());
    router.post('/', (req, res) => res.end());
    router.get('/logs', (req, res) => res.end());
    router.get('/lang/:locale', (req, res) => res.end());
    return router;
}

function ejecutarGuardia(req) {
    const resultado = { siguiente: false, estado: null, vista: null, json: null };
    const res = {
        status(codigo) { resultado.estado = codigo; return this; },
        set() { return this; },
        json(cuerpo) { resultado.json = cuerpo; return this; },
        render(vista) { resultado.vista = vista; return this; }
    };
    const completa = {
        method: 'GET',
        path: '/',
        originalUrl: req.path || '/',
        accepts: (tipos) => (req.html ? 'html' : tipos[0]),
        ...req
    };
    access.guardia(panel())(completa, res, () => { resultado.siguiente = true; });
    return resultado;
}

describe('access.service', () => {
    const anterior = process.env.MOCK_SERVER_ACCESS_KEY;

    afterEach(() => {
        if (anterior === undefined) delete process.env.MOCK_SERVER_ACCESS_KEY;
        else process.env.MOCK_SERVER_ACCESS_KEY = anterior;
    });

    describe('sin clave configurada', () => {
        beforeEach(() => { delete process.env.MOCK_SERVER_ACCESS_KEY; });

        it('deja entrar a cualquiera, que es como se comportaba el servidor antes de existir la clave', () => {
            expect(access.permitido(peticion())).toBe(true);
            expect(ejecutarGuardia({ ...peticion(), path: '/api/routes' }).siguiente).toBe(true);
        });

        it('no reconoce ningún valor como clave, ni siquiera uno vacío', () => {
            expect(access.esClave('')).toBe(false);
            expect(access.esClave('cualquier-cosa')).toBe(false);
        });

        it('informa de que no se pide clave', () => {
            expect(access.estado()).toEqual({ remote_access_key_required: false });
        });
    });

    describe('con clave configurada', () => {
        beforeEach(() => { process.env.MOCK_SERVER_ACCESS_KEY = CLAVE; });

        it('nunca se la pide al propio equipo, por IPv4, IPv6 o IPv4 mapeada', () => {
            for (const direccion of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.1.1']) {
                expect(access.permitido(peticion({ direccion }))).toBe(true);
            }
        });

        it('trata como remota una petición local que llega reenviada, porque detrás de un proxy en la misma máquina todo parecería local', () => {
            const reenviada = peticion({ direccion: '127.0.0.1', cabeceras: { 'x-forwarded-for': '10.0.0.8' } });
            expect(access.esLocal(reenviada)).toBe(false);
            expect(access.permitido(reenviada)).toBe(false);
        });

        it('se la pide a otro equipo y la acepta como Bearer, como X-API-Key o como cookie del panel', () => {
            expect(access.permitido(peticion())).toBe(false);
            expect(access.permitido(peticion({ cabeceras: { authorization: `Bearer ${CLAVE}` } }))).toBe(true);
            expect(access.permitido(peticion({ cabeceras: { 'x-api-key': CLAVE } }))).toBe(true);
            expect(access.permitido(peticion({ cookies: { [access.COOKIE]: access.valorCookie() } }))).toBe(true);
        });

        it('lee la cookie de la cabecera cruda, que es lo único que trae el handshake de socket.io', () => {
            const cruda = peticion({ cabeceras: { cookie: `otra=1; ${access.COOKIE}=${access.valorCookie()}` } });
            expect(access.permitido(cruda)).toBe(true);
        });

        it('rechaza una clave equivocada o una cookie que no es la suya', () => {
            expect(access.permitido(peticion({ cabeceras: { 'x-api-key': 'otra' } }))).toBe(false);
            expect(access.permitido(peticion({ cookies: { [access.COOKIE]: 'f'.repeat(64) } }))).toBe(false);
            expect(access.permitido(peticion({ cookies: { [access.COOKIE]: 'no-hex' } }))).toBe(false);
        });

        it('invalida las cookies ya emitidas cuando cambia la clave', () => {
            const cookie = access.valorCookie();
            process.env.MOCK_SERVER_ACCESS_KEY = 'clave-nueva';
            expect(access.permitido(peticion({ cookies: { [access.COOKIE]: cookie } }))).toBe(false);
        });

        it('no guarda la clave en la cookie', () => {
            expect(access.valorCookie()).not.toContain(CLAVE);
        });

        it('informa de que se pide clave sin revelarla', () => {
            expect(access.estado()).toEqual({ remote_access_key_required: true });
        });
    });

    describe('la guardia', () => {
        beforeEach(() => { process.env.MOCK_SERVER_ACCESS_KEY = CLAVE; });

        it('deja los mocks abiertos a otros equipos, porque quien los llama es la app bajo prueba', () => {
            for (const path of ['/users', '/logs/123', '/api-mock-que-no-es-api', '/login']) {
                expect(ejecutarGuardia({ ...peticion(), path }).siguiente).toBe(true);
            }
        });

        it('deja abierto un mock con otro método en una ruta que el panel solo atiende por GET', () => {
            expect(ejecutarGuardia({ ...peticion(), method: 'PUT', path: '/logs' }).siguiente).toBe(true);
        });

        it('cierra el panel, sus páginas y toda la API a otros equipos sin clave', () => {
            for (const [method, path] of [['GET', '/'], ['POST', '/'], ['GET', '/logs'], ['GET', '/lang/en'], ['GET', '/api'], ['POST', '/api/routes'], ['GET', '/api/v1/routes']]) {
                const resultado = ejecutarGuardia({ ...peticion(), method, path });
                expect(resultado.siguiente).toBe(false);
                expect(resultado.estado).toBe(401);
            }
        });

        it('enseña la pantalla de entrada a un navegador y un 401 en JSON a un script', () => {
            expect(ejecutarGuardia({ ...peticion(), path: '/', html: true }).vista).toBe('access');
            expect(ejecutarGuardia({ ...peticion(), path: '/api/routes' }).json.code).toBe('access_key_required');
        });

        it('deja pasar la entrada con clave, que si no nadie podría entrar', () => {
            expect(ejecutarGuardia({ ...peticion(), method: 'POST', path: '/api/access/login' }).siguiente).toBe(true);
        });

        it('deja que la API v1 valide sus propios tokens, que ya rechaza los equivocados', () => {
            const conToken = peticion({ cabeceras: { authorization: 'Bearer token-creado-en-el-panel' } });
            expect(ejecutarGuardia({ ...conToken, path: '/api/v1/routes' }).siguiente).toBe(true);
        });

        it('no deja que un Bearer cualquiera abra la API del panel, que no comprueba tokens', () => {
            const conToken = peticion({ cabeceras: { authorization: 'Bearer token-creado-en-el-panel' } });
            expect(ejecutarGuardia({ ...conToken, path: '/api/routes' }).siguiente).toBe(false);
        });
    });

    describe('destinoSeguro', () => {
        it('solo vuelve a rutas del propio servidor, para que la entrada no sirva de redirección abierta', () => {
            expect(access.destinoSeguro('/logs?x=1')).toBe('/logs?x=1');
            expect(access.destinoSeguro('https://otro.example')).toBe('/');
            expect(access.destinoSeguro('//otro.example')).toBe('/');
            expect(access.destinoSeguro('/\\otro.example')).toBe('/');
            expect(access.destinoSeguro(undefined)).toBe('/');
        });
    });
});
