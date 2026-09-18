/**
 * El contrato de la API v1 contra el router de verdad.
 *
 * La documentación está escrita a mano, que es lo que la hace útil, y por eso
 * puede quedarse atrás. Esta prueba es lo que impide que pase: si alguien añade
 * un endpoint y no lo documenta, o documenta uno que ya no existe, falla aquí y
 * no en la cara de quien lea el Swagger.
 */

jest.mock('../../services/socket.service', () => ({
    log: { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() },
    sendData: jest.fn(),
    init: jest.fn()
}));

const SwaggerParser = require('@apidevtools/swagger-parser');
const apiSpec = require('../../services/api-spec.service');
const router = require('../../routes/api-v1');

const METODOS = ['get', 'post', 'put', 'patch', 'delete'];

/** Rutas registradas en Express, con el camino en el formato de OpenAPI */
function registradas() {
    const salida = [];
    router.stack.forEach(capa => {
        if (!capa.route) return;
        const camino = capa.route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        Object.keys(capa.route.methods)
            .filter(m => METODOS.includes(m))
            .forEach(metodo => salida.push(`${metodo.toUpperCase()} ${camino}`));
    });
    return salida;
}

/** Operaciones documentadas en el contrato */
function documentadas(spec) {
    const salida = [];
    Object.entries(spec.paths).forEach(([camino, operaciones]) => {
        Object.keys(operaciones)
            .filter(m => METODOS.includes(m))
            .forEach(metodo => salida.push(`${metodo.toUpperCase()} ${camino}`));
    });
    return salida;
}

describe('API v1: el contrato y el router dicen lo mismo', () => {
    const spec = apiSpec.cargar();

    it('documenta todo lo que el router atiende', () => {
        const sinDocumentar = registradas().filter(op => !documentadas(spec).includes(op));
        expect(sinDocumentar).toEqual([]);
    });

    it('no documenta nada que el router no atienda', () => {
        const inventadas = documentadas(spec).filter(op => !registradas().includes(op));
        expect(inventadas).toEqual([]);
    });

    it('es un documento OpenAPI válido, con todas las referencias resueltas', async () => {
        // Se valida sobre una copia: swagger-parser resuelve los $ref in situ y
        // dejaría la caché del servicio con el documento ya aplanado
        const copia = JSON.parse(JSON.stringify(spec));
        await expect(SwaggerParser.validate(copia)).resolves.toBeDefined();
    });

    it('cada operación tiene resumen y operationId único', () => {
        const ids = [];
        const sinResumen = [];

        Object.entries(spec.paths).forEach(([camino, operaciones]) => {
            Object.entries(operaciones)
                .filter(([m]) => METODOS.includes(m))
                .forEach(([metodo, operacion]) => {
                    if (!operacion.summary) sinResumen.push(`${metodo.toUpperCase()} ${camino}`);
                    ids.push(operacion.operationId);
                });
        });

        expect(sinResumen).toEqual([]);
        expect(ids.filter(id => !id)).toEqual([]);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('cada operación cuelga de un grupo declarado', () => {
        const grupos = spec.tags.map(t => t.name);
        const huerfanas = [];

        Object.entries(spec.paths).forEach(([camino, operaciones]) => {
            Object.entries(operaciones)
                .filter(([m]) => METODOS.includes(m))
                .forEach(([metodo, operacion]) => {
                    const suyos = operacion.tags || [];
                    if (!suyos.length || suyos.some(t => !grupos.includes(t))) {
                        huerfanas.push(`${metodo.toUpperCase()} ${camino}`);
                    }
                });
        });

        expect(huerfanas).toEqual([]);
    });

    it('la versión servida es la del paquete, no la del fichero', () => {
        const { version } = require('../../package.json');
        expect(apiSpec.documento().info.version).toBe(version);
    });

    it('apunta al servidor desde el que se pidió', () => {
        const doc = apiSpec.documento({ baseUrl: 'http://192.168.1.50:3880' });
        expect(doc.servers[0].url).toBe('http://192.168.1.50:3880/api/v1');
    });
});
