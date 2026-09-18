/**
 * API Spec Service
 *
 * Sirve el contrato OpenAPI de la API v1, que vive escrito a mano en
 * openapi/openapi.yaml.
 *
 * Escrito a mano y no generado a partir del router a propósito: lo que aporta
 * la documentación es lo que el router no dice (qué significa cada campo, qué
 * pasa si se omite, para qué sirve la operación), y eso hay que escribirlo
 * igual. Que no se quede atrás lo vigila una prueba que compara las rutas
 * registradas con las documentadas, y falla si sobra o falta una.
 *
 * La versión y la URL del servidor se inyectan al servirlo: son lo único que no
 * se puede saber al escribir el fichero.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { version } = require('../package.json');

const RUTA = path.join(__dirname, '..', 'openapi', 'openapi.yaml');

let cache = null;

function bruto() {
    return fs.readFileSync(RUTA, 'utf8');
}

function cargar() {
    if (!cache) cache = yaml.load(bruto());
    return cache;
}

/**
 * El documento listo para servir.
 *
 * @param {string} baseUrl origen desde el que se pidió, para que el "Try it out"
 *                        de Swagger UI apunte a este mismo servidor y no a un
 *                        localhost escrito en el fichero
 */
function documento({ baseUrl } = {}) {
    const spec = JSON.parse(JSON.stringify(cargar()));

    spec.info.version = version;
    if (baseUrl) {
        spec.servers = [{ url: `${baseUrl}/api/v1`, description: 'This server' }];
    }

    return spec;
}

module.exports = { documento, bruto, cargar, RUTA };
