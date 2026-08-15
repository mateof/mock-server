/**
 * Version Service
 *
 * Comprueba si hay una versión más nueva publicada en GHCR y la compara con la
 * que está corriendo.
 *
 * Tres decisiones que condicionan el diseño:
 *
 * 1. **La comprobación la hace el servidor, no el navegador.** GHCR no manda
 *    cabeceras CORS, así que desde el navegador fallaría; y además así se
 *    consulta una vez por instancia y no una por pestaña abierta.
 * 2. **Perezosa y con caché.** No hay temporizador de fondo: se consulta al
 *    pedirla y solo si la caché ha caducado. Si nadie mira el panel, no hace
 *    falta comprobar nada.
 * 3. **Falla en silencio.** Un mock server puede correr en una red sin salida
 *    a internet. Si no se puede consultar, no se avisa de nada y no se llena
 *    el log de errores: no saber si hay actualización no es un problema.
 */

const https = require('https');
const { version: VERSION_ACTUAL } = require('../package.json');

const IMAGEN = process.env.MOCK_SERVER_IMAGE || 'mateof/mock-server';
const HABILITADO = process.env.MOCK_SERVER_UPDATE_CHECK !== 'false';
const HORAS_CACHE = parseFloat(process.env.MOCK_SERVER_UPDATE_CHECK_HOURS) || 6;
const TIMEOUT_MS = 5000;

const URL_PAQUETE = `https://github.com/${IMAGEN.split('/')[0]}/${IMAGEN.split('/')[1]}/pkgs/container/${IMAGEN.split('/')[1]}`;

let cache = null;
let consultando = null;

// ===== COMPARACIÓN DE VERSIONES =====

/**
 * Compara dos versiones semánticas. Devuelve >0 si a es mayor, <0 si es menor
 * y 0 si son iguales. Comparar como texto daría 0.9.0 > 0.15.0.
 */
function compararVersiones(a, b) {
    // Las partes que falten cuentan como 0: si no, restar undefined da NaN y
    // la comparación deja de significar nada
    const partes = (v) => {
        const [x = 0, y = 0, z = 0] = String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
        return [x, y, z];
    };
    const [a1, a2, a3] = partes(a);
    const [b1, b2, b3] = partes(b);
    return (a1 - b1) || (a2 - b2) || (a3 - b3);
}

/**
 * Se queda con la mayor de las etiquetas que son una versión.
 * El registro trae también `latest`, `main`, `sha-...` y demás, que no dicen
 * qué número traen.
 */
function versionMasAlta(tags) {
    const versiones = (tags || []).filter(t => /^v?\d+\.\d+\.\d+$/.test(t));
    if (versiones.length === 0) return null;
    return versiones.reduce((mayor, actual) => compararVersiones(actual, mayor) > 0 ? actual : mayor);
}

// ===== CONSULTA AL REGISTRO =====

function pedirJson(url, cabeceras = {}) {
    return new Promise((resolve, reject) => {
        const peticion = https.get(url, { headers: cabeceras, timeout: TIMEOUT_MS }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let datos = '';
            res.on('data', c => datos += c);
            res.on('end', () => {
                try { resolve(JSON.parse(datos)); }
                catch (e) { reject(new Error('respuesta no válida')); }
            });
        });

        peticion.on('timeout', () => {
            peticion.destroy();
            reject(new Error('timeout'));
        });
        peticion.on('error', reject);
    });
}

/**
 * GHCR permite listar las etiquetas de una imagen pública sin credenciales,
 * pero exige pedir antes un token anónimo acotado a ese repositorio.
 */
async function consultarRegistro() {
    const { token } = await pedirJson(
        `https://ghcr.io/token?scope=${encodeURIComponent(`repository:${IMAGEN}:pull`)}&service=ghcr.io`
    );
    if (!token) throw new Error('sin token');

    const listado = await pedirJson(`https://ghcr.io/v2/${IMAGEN}/tags/list`, {
        Authorization: `Bearer ${token}`
    });

    return versionMasAlta(listado.tags);
}

// ===== API DEL SERVICIO =====

function cacheVigente() {
    return cache && (Date.now() - cache.checkedAt) < HORAS_CACHE * 3600 * 1000;
}

/**
 * Estado de versión. Con `force` se salta la caché (lo usa el botón de
 * comprobar ahora); sin él respeta el TTL.
 */
async function getStatus({ force = false } = {}) {
    const base = {
        current: VERSION_ACTUAL,
        image: IMAGEN,
        package_url: URL_PAQUETE,
        check_enabled: HABILITADO
    };

    if (!HABILITADO) {
        return { ...base, latest: null, update_available: false, checked_at: null };
    }

    if (!force && cacheVigente()) {
        return { ...base, ...cache.datos, checked_at: new Date(cache.checkedAt).toISOString() };
    }

    // Si ya hay una consulta en vuelo, se reaprovecha en vez de disparar otra
    if (!consultando) {
        consultando = consultarRegistro()
            .then(latest => {
                cache = {
                    checkedAt: Date.now(),
                    datos: {
                        latest,
                        update_available: !!latest && compararVersiones(latest, VERSION_ACTUAL) > 0
                    }
                };
                console.log(`[VERSION] Última publicada: ${latest || 'desconocida'} (actual ${VERSION_ACTUAL})`);
            })
            .catch(err => {
                // Sin salida a internet no se avisa de nada, y no se insiste
                // hasta que caduque la caché
                cache = {
                    checkedAt: Date.now(),
                    datos: { latest: null, update_available: false, error: err.message }
                };
                console.log(`[VERSION] No se pudo comprobar: ${err.message}`);
            })
            .finally(() => { consultando = null; });
    }

    await consultando;
    return { ...base, ...cache.datos, checked_at: new Date(cache.checkedAt).toISOString() };
}

module.exports = {
    getStatus,
    compararVersiones,
    versionMasAlta,
    VERSION_ACTUAL,
    URL_PAQUETE
};
