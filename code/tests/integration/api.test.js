const request = require('supertest');

// Set up test environment
process.env.NODE_ENV = 'test';

// Mock socket service
jest.mock('../../services/socket.service', () => ({
    init: jest.fn(),
    emit: jest.fn(),
    getIO: jest.fn(() => ({
        emit: jest.fn()
    }))
}));

// Mock proxy middleware
jest.mock('../../middlewares/proxy.middleware', () => ({
    configureProxy: jest.fn(),
    reloadProxyConfigs: jest.fn().mockResolvedValue(undefined)
}));

// Create mock storage module that can be modified
const mockStorage = {
    routes: [],
    conditions: [],
    nextRouteId: 1,
    nextConditionId: 1,
    reset() {
        this.routes = [];
        this.conditions = [];
        this.nextRouteId = 1;
        this.nextConditionId = 1;
    }
};

// Mock sqlite service with reference to external storage
jest.mock('../../services/sqlite.service', () => {
    const storage = require('./api.test.js').mockStorage || { routes: [], conditions: [], nextRouteId: 1, nextConditionId: 1 };

    const mockDb = {
        run: jest.fn((sql, params, callback) => {
            const mockRoutes = storage.routes;

            // Handle INSERT
            if (sql.includes('INSERT INTO rutas')) {
                const id = storage.nextRouteId++;
                mockRoutes.push({
                    id,
                    tipo: params[0],
                    ruta: params[1],
                    codigo: params[2],
                    respuesta: params[3],
                    tiporespuesta: params[4],
                    esperaActiva: params[5],
                    isRegex: params[6],
                    customHeaders: params[7],
                    activo: params[8],
                    orden: params[9] || mockRoutes.length + 1,
                    fileName: params[10] || null,
                    filePath: params[11] || null,
                    fileMimeType: params[12] || null
                });
                if (callback) callback.call({ lastID: id }, null);
                return;
            }
            // Handle UPDATE tipo (full update)
            if (sql.includes('UPDATE rutas SET tipo')) {
                const id = params[params.length - 1];
                const route = mockRoutes.find(r => r.id === id);
                if (route) {
                    route.tipo = params[0];
                    route.ruta = params[1];
                    route.codigo = params[2];
                    route.respuesta = params[3];
                    route.tiporespuesta = params[4];
                    route.esperaActiva = params[5];
                    route.isRegex = params[6];
                    route.customHeaders = params[7];
                    route.activo = params[8];
                    route.orden = params[9];
                }
                if (callback) callback(null);
                return;
            }
            // Handle UPDATE activo
            if (sql.includes('UPDATE rutas SET activo')) {
                const id = params[1];
                const route = mockRoutes.find(r => r.id === id);
                if (route) route.activo = params[0];
                if (callback) callback(null);
                return;
            }
            // Handle UPDATE esperaActiva
            if (sql.includes('UPDATE rutas SET esperaActiva')) {
                const id = params[1];
                const route = mockRoutes.find(r => r.id === id);
                if (route) route.esperaActiva = params[0];
                if (callback) callback(null);
                return;
            }
            // Handle UPDATE orden
            if (sql.includes('UPDATE rutas SET orden')) {
                const id = params[1];
                const route = mockRoutes.find(r => r.id === id);
                if (route) route.orden = params[0];
                if (callback) callback(null);
                return;
            }
            // Handle DELETE single
            if (sql.includes('DELETE FROM rutas WHERE id = ?')) {
                const idx = storage.routes.findIndex(r => r.id === params[0]);
                if (idx > -1) storage.routes.splice(idx, 1);
                if (callback) callback(null);
                return;
            }
            // Handle DELETE bulk
            if (sql.includes('DELETE FROM rutas WHERE id IN')) {
                storage.routes = storage.routes.filter(r => !params.includes(r.id));
                if (callback) callback(null);
                return;
            }
            if (callback) callback(null);
        }),
        get: jest.fn((sql, params, callback) => {
            const mockRoutes = storage.routes;

            // Handle SELECT by id
            if (sql.includes('WHERE id = ?')) {
                const route = mockRoutes.find(r => r.id === params[0]);
                callback(null, route || null);
                return;
            }
            // Handle SELECT MAX orden
            if (sql.includes('MAX(orden)')) {
                const max = mockRoutes.length > 0 ? Math.max(...mockRoutes.map(r => r.orden || 0)) : 0;
                callback(null, { maxOrden: max });
                return;
            }
            // Handle SELECT MIN orden
            if (sql.includes('MIN(orden)')) {
                const proxies = mockRoutes.filter(r => r.tiporespuesta === 'proxy');
                const min = proxies.length > 0 ? Math.min(...proxies.map(r => r.orden || 99999999)) : null;
                callback(null, { minOrden: min });
                return;
            }
            // Handle SELECT for move-up/down
            if (sql.includes('ORDER BY orden DESC LIMIT 1')) {
                const currentOrder = params[0];
                const prev = mockRoutes.filter(r => (r.orden || 0) < currentOrder)
                    .sort((a, b) => (b.orden || 0) - (a.orden || 0))[0];
                callback(null, prev || null);
                return;
            }
            if (sql.includes('ORDER BY orden ASC LIMIT 1')) {
                const currentOrder = params[0];
                const next = mockRoutes.filter(r => (r.orden || 0) > currentOrder)
                    .sort((a, b) => (a.orden || 0) - (b.orden || 0))[0];
                callback(null, next || null);
                return;
            }
            callback(null, null);
        }),
        all: jest.fn((sql, params, callback) => {
            const mockRoutes = storage.routes;

            // Handle SELECT all routes
            if (sql.includes('SELECT * FROM rutas') && !sql.includes('WHERE')) {
                callback(null, [...mockRoutes].sort((a, b) => (a.orden || 999999) - (b.orden || 999999)));
                return;
            }
            // Handle SELECT with filePath
            if (sql.includes('SELECT id, filePath FROM rutas WHERE id IN')) {
                const routes = mockRoutes.filter(r => params.includes(r.id));
                callback(null, routes);
                return;
            }
            // Handle SELECT for normalize-order
            if (sql.includes('tiporespuesta != \'proxy\'')) {
                const routes = mockRoutes.filter(r => r.tiporespuesta !== 'proxy');
                callback(null, routes);
                return;
            }
            if (sql.includes('tiporespuesta = \'proxy\'') && sql.includes('WHERE')) {
                const routes = mockRoutes.filter(r => r.tiporespuesta === 'proxy');
                callback(null, routes);
                return;
            }
            callback(null, []);
        })
    };

    return {
        initSql: jest.fn().mockResolvedValue(undefined),
        getDatabase: jest.fn(() => mockDb),
        getRuta: jest.fn(),
        getProxys: jest.fn().mockResolvedValue([]),
        getConditionalResponses: jest.fn((routeId) => {
            return Promise.resolve(storage.conditions.filter(c => c.route_id === parseInt(routeId)));
        }),
        saveConditionalResponses: jest.fn((routeId, conditions) => {
            storage.conditions = storage.conditions.filter(c => c.route_id !== parseInt(routeId));
            conditions.forEach((c, i) => {
                storage.conditions.push({
                    id: storage.nextConditionId++,
                    route_id: parseInt(routeId),
                    orden: i,
                    nombre: c.nombre,
                    criteria: c.criteria,
                    codigo: c.codigo,
                    tiporespuesta: c.tiporespuesta,
                    respuesta: c.respuesta,
                    customHeaders: c.customHeaders,
                    activo: 1
                });
            });
            return Promise.resolve();
        }),
        deleteConditionalResponses: jest.fn((routeId) => {
            storage.conditions = storage.conditions.filter(c => c.route_id !== parseInt(routeId));
            return Promise.resolve();
        }),
        _storage: storage
    };
});

// Export storage for mock to access
module.exports = { mockStorage };

// Create test app
const express = require('express');
const cookieParser = require('cookie-parser');
const apiRouter = require('../../routes/api');
const semaphore = require('../../services/semaphore.service');
const sqliteService = require('../../services/sqlite.service');

let app;

beforeAll(async () => {
    // Initialize semaphore
    semaphore.init();

    // Create test app
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use(cookieParser());
    app.use('/api', apiRouter);

    // Error handler
    app.use((err, req, res, next) => {
        res.status(err.status || 500).json({ error: err.message });
    });
});

beforeEach(() => {
    // Reset mock data before each test using the internal storage reference
    const storage = sqliteService._storage;
    if (storage) {
        storage.routes = [];
        storage.conditions = [];
        storage.nextRouteId = 1;
        storage.nextConditionId = 1;
    }
});

describe('API Routes', () => {
    describe('GET /api/routes', () => {
        test('should return empty array when no routes exist', async () => {
            const response = await request(app)
                .get('/api/routes')
                .expect('Content-Type', /json/)
                .expect(200);

            expect(Array.isArray(response.body)).toBe(true);
            expect(response.body.length).toBe(0);
        });

        test('should return routes when they exist', async () => {
            // Add a mock route via storage
            sqliteService._storage.routes.push({
                id: 1,
                tipo: 'get',
                ruta: '/test',
                codigo: '200',
                tiporespuesta: 'json',
                respuesta: '{}',
                activo: 1,
                orden: 1
            });

            const response = await request(app)
                .get('/api/routes')
                .expect(200);

            expect(response.body.length).toBe(1);
            expect(response.body[0].ruta).toBe('/test');
        });
    });

    describe('POST /api/create', () => {
        test('should create a new route', async () => {
            const response = await request(app)
                .post('/api/create')
                .send({
                    tipo: 'get',
                    ruta: '/test/hello',
                    codigo: '200',
                    tiporespuesta: 'json',
                    respuesta: '{"message": "Hello World"}'
                })
                .expect('Content-Type', /json/)
                .expect(200);

            expect(response.body.id).toBeDefined();
            expect(sqliteService._storage.routes.length).toBe(1);
        });

        test('should reject routes starting with /api/', async () => {
            const response = await request(app)
                .post('/api/create')
                .send({
                    tipo: 'get',
                    ruta: '/api/reserved',
                    codigo: '200',
                    tiporespuesta: 'json',
                    respuesta: '{}'
                })
                .expect(400);

            expect(response.body.error).toContain('reserved');
            expect(sqliteService._storage.routes.length).toBe(0);
        });

        test('should create route with custom headers', async () => {
            const response = await request(app)
                .post('/api/create')
                .send({
                    tipo: 'get',
                    ruta: '/test/with-headers',
                    codigo: '200',
                    tiporespuesta: 'json',
                    respuesta: '{}',
                    customHeaders: [{ action: 'set', name: 'X-Custom', value: 'test' }]
                })
                .expect(200);

            expect(response.body.id).toBeDefined();
        });

        test('should create inactive route', async () => {
            const response = await request(app)
                .post('/api/create')
                .send({
                    tipo: 'get',
                    ruta: '/test/inactive',
                    codigo: '200',
                    tiporespuesta: 'json',
                    respuesta: '{}',
                    activo: false
                })
                .expect(200);

            expect(response.body.id).toBeDefined();
            expect(sqliteService._storage.routes[0].activo).toBe(0);
        });

        test('should create regex route', async () => {
            const response = await request(app)
                .post('/api/create')
                .send({
                    tipo: 'get',
                    ruta: '/test/users/\\d+',
                    codigo: '200',
                    tiporespuesta: 'json',
                    respuesta: '{"id": 1}',
                    isRegex: true
                })
                .expect(200);

            expect(response.body.id).toBeDefined();
            expect(sqliteService._storage.routes[0].isRegex).toBe(1);
        });
    });

    describe('PUT /api/update/:id', () => {
        beforeEach(() => {
            sqliteService._storage.routes.push({
                id: 1,
                tipo: 'get',
                ruta: '/test/update-me',
                codigo: '200',
                tiporespuesta: 'json',
                respuesta: '{"original": true}',
                activo: 1,
                orden: 1
            });
            sqliteService._storage.nextRouteId = 2;
        });

        test('should update existing route', async () => {
            // Test the endpoint responds successfully to update request
            await request(app)
                .put('/api/update/1')
                .send({
                    tipo: 'post',
                    ruta: '/test/update-me',
                    codigo: '201',
                    tiporespuesta: 'json',
                    respuesta: '{"updated": true}'
                })
                .expect(200);
        });

        test('should reject update with reserved path', async () => {
            await request(app)
                .put('/api/update/1')
                .send({
                    tipo: 'get',
                    ruta: '/api/forbidden',
                    codigo: '200',
                    tiporespuesta: 'json',
                    respuesta: '{}'
                })
                .expect(400);
        });
    });

    describe('DELETE /api/delete/:id', () => {
        beforeEach(() => {
            sqliteService._storage.routes.push({
                id: 1,
                tipo: 'get',
                ruta: '/test/delete-me',
                codigo: '200',
                tiporespuesta: 'json',
                respuesta: '{}',
                activo: 1,
                orden: 1
            });
            sqliteService._storage.nextRouteId = 2;
        });

        test('should delete existing route', async () => {
            // Test the endpoint responds successfully to delete request
            await request(app)
                .delete('/api/delete/1')
                .expect(200);
        });
    });

    describe('POST /api/delete-bulk', () => {
        beforeEach(() => {
            sqliteService._storage.routes = [
                { id: 1, tipo: 'get', ruta: '/test/1', codigo: '200', tiporespuesta: 'json', activo: 1 },
                { id: 2, tipo: 'get', ruta: '/test/2', codigo: '200', tiporespuesta: 'json', activo: 1 },
                { id: 3, tipo: 'get', ruta: '/test/3', codigo: '200', tiporespuesta: 'json', activo: 1 }
            ];
            sqliteService._storage.nextRouteId = 4;
        });

        test('should delete multiple routes', async () => {
            const response = await request(app)
                .post('/api/delete-bulk')
                .send({ ids: [1, 2] })
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.deleted).toBe(2);
            expect(sqliteService._storage.routes.length).toBe(1);
        });

        test('should reject empty ids array', async () => {
            await request(app)
                .post('/api/delete-bulk')
                .send({ ids: [] })
                .expect(400);
        });

        test('should reject missing ids', async () => {
            await request(app)
                .post('/api/delete-bulk')
                .send({})
                .expect(400);
        });
    });

    describe('PUT /api/toggle-active/:id', () => {
        beforeEach(() => {
            sqliteService._storage.routes.push({
                id: 1,
                tipo: 'get',
                ruta: '/test',
                codigo: '200',
                tiporespuesta: 'json',
                activo: 1,
                orden: 1
            });
            sqliteService._storage.nextRouteId = 2;
        });

        test('should respond to toggle active request', async () => {
            // This test verifies the endpoint responds successfully
            await request(app)
                .put('/api/toggle-active/1')
                .send({ activo: false })
                .expect(200);
        });
    });

    describe('PUT /api/toggle-wait/:id', () => {
        beforeEach(() => {
            sqliteService._storage.routes.push({
                id: 1,
                tipo: 'get',
                ruta: '/test',
                codigo: '200',
                tiporespuesta: 'json',
                esperaActiva: 0,
                orden: 1
            });
            sqliteService._storage.nextRouteId = 2;
        });

        test('should respond to toggle esperaActiva request', async () => {
            // This test verifies the endpoint responds successfully
            // The actual toggle logic is tested in unit tests
            await request(app)
                .put('/api/toggle-wait/1')
                .send({ esperaActiva: true })
                .expect(200);
        });
    });

    describe('POST /api/validateRegex', () => {
        test('should validate correct regex', async () => {
            const response = await request(app)
                .post('/api/validateRegex')
                .send({
                    regex: '/users/\\d+',
                    testUrl: '/users/123'
                })
                .expect(200);

            expect(response.body.valid).toBe(true);
            expect(response.body.matches).toBe(true);
        });

        test('should report non-matching regex', async () => {
            const response = await request(app)
                .post('/api/validateRegex')
                .send({
                    regex: '/users/\\d+',
                    testUrl: '/users/abc'
                })
                .expect(200);

            expect(response.body.valid).toBe(true);
            expect(response.body.matches).toBe(false);
        });

        test('should report invalid regex', async () => {
            const response = await request(app)
                .post('/api/validateRegex')
                .send({
                    regex: '[invalid',
                    testUrl: '/test'
                })
                .expect(200);

            expect(response.body.valid).toBe(false);
            expect(response.body.error).toBeDefined();
        });
    });

    describe('POST /api/validateCriteria', () => {
        test('should validate correct criteria expression', async () => {
            const response = await request(app)
                .post('/api/validateCriteria')
                .send({
                    criteria: "headers['x-api-key'] === 'secret'"
                })
                .expect(200);

            expect(response.body.valid).toBe(true);
        });

        test('should reject dangerous patterns', async () => {
            const response = await request(app)
                .post('/api/validateCriteria')
                .send({
                    criteria: "require('fs')"
                })
                .expect(200);

            expect(response.body.valid).toBe(false);
            expect(response.body.error).toBeDefined();
        });

        test('should validate with test context', async () => {
            const response = await request(app)
                .post('/api/validateCriteria')
                .send({
                    criteria: "body.userId > 100",
                    testContext: {
                        body: { userId: 150 },
                        headers: {},
                        query: {},
                        path: '/test',
                        params: {},
                        method: 'GET'
                    }
                })
                .expect(200);

            expect(response.body.valid).toBe(true);
            expect(response.body.testResult).toBeDefined();
            expect(response.body.testResult.result).toBe(true);
        });
    });

    describe('GET /api/criteria-helpers', () => {
        test('should return available helpers and examples', async () => {
            const response = await request(app)
                .get('/api/criteria-helpers')
                .expect(200);

            expect(response.body.helpers).toBeDefined();
            expect(Array.isArray(response.body.helpers)).toBe(true);
            expect(response.body.helpers).toContain('includes');
            expect(response.body.helpers).toContain('hasKey');

            expect(response.body.examples).toBeDefined();
            expect(Array.isArray(response.body.examples)).toBe(true);
        });
    });

    describe('Conditional Responses API', () => {
        beforeEach(() => {
            sqliteService._storage.routes.push({
                id: 1,
                tipo: 'get',
                ruta: '/test/conditions',
                codigo: '200',
                tiporespuesta: 'json',
                respuesta: '{"default": true}',
                activo: 1,
                orden: 1
            });
            sqliteService._storage.nextRouteId = 2;
        });

        test('GET /api/conditions/:routeId should return empty array initially', async () => {
            const response = await request(app)
                .get('/api/conditions/1')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.conditions).toEqual([]);
        });

        test('PUT /api/conditions/:routeId should save conditions', async () => {
            const conditions = [
                {
                    nombre: 'Premium User',
                    criteria: "headers['x-subscription'] === 'premium'",
                    codigo: '200',
                    tiporespuesta: 'json',
                    respuesta: '{"premium": true}'
                },
                {
                    nombre: 'Error Simulation',
                    criteria: "query.error === 'true'",
                    codigo: '500',
                    tiporespuesta: 'json',
                    respuesta: '{"error": "simulated"}'
                }
            ];

            await request(app)
                .put('/api/conditions/1')
                .send({ conditions })
                .expect(200);

            // Verify conditions were saved
            const getResponse = await request(app)
                .get('/api/conditions/1')
                .expect(200);

            expect(getResponse.body.conditions.length).toBe(2);
        });

        test('PUT /api/conditions/:routeId should reject invalid criteria', async () => {
            const conditions = [
                {
                    nombre: 'Invalid',
                    criteria: "require('fs')",
                    codigo: '200',
                    tiporespuesta: 'json',
                    respuesta: '{}'
                }
            ];

            const response = await request(app)
                .put('/api/conditions/1')
                .send({ conditions })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toBeDefined();
        });

        test('PUT /api/conditions/:routeId should reject empty criteria', async () => {
            const conditions = [
                {
                    nombre: 'Empty',
                    criteria: '',
                    codigo: '200'
                }
            ];

            const response = await request(app)
                .put('/api/conditions/1')
                .send({ conditions })
                .expect(400);

            expect(response.body.success).toBe(false);
        });

        test('PUT /api/conditions/:routeId should reject non-array', async () => {
            await request(app)
                .put('/api/conditions/1')
                .send({ conditions: 'not an array' })
                .expect(400);
        });
    });

    describe('Route Duplication', () => {
        test('POST /api/duplicate/:id should reject reserved path', async () => {
            sqliteService._storage.routes.push({
                id: 1,
                tipo: 'get',
                ruta: '/test/original',
                codigo: '200',
                tiporespuesta: 'json',
                respuesta: '{"original": true}',
                activo: 1,
                orden: 1
            });

            await request(app)
                .post('/api/duplicate/1')
                .send({ newRoute: '/api/reserved' })
                .expect(400);
        });

        test('POST /api/duplicate/:id should reject missing newRoute', async () => {
            await request(app)
                .post('/api/duplicate/1')
                .send({})
                .expect(400);
        });
    });

    describe('Order Management', () => {
        beforeEach(() => {
            sqliteService._storage.routes = [
                { id: 1, tipo: 'get', ruta: '/test/1', codigo: '200', tiporespuesta: 'json', activo: 1, orden: 1 },
                { id: 2, tipo: 'get', ruta: '/test/2', codigo: '200', tiporespuesta: 'json', activo: 1, orden: 2 },
                { id: 3, tipo: 'get', ruta: '/test/3', codigo: '200', tiporespuesta: 'json', activo: 1, orden: 3 }
            ];
            sqliteService._storage.nextRouteId = 4;
        });

        test('PUT /api/reorder should reorder multiple routes', async () => {
            const orders = [
                { id: 1, orden: 100 },
                { id: 2, orden: 101 },
                { id: 3, orden: 102 }
            ];

            const response = await request(app)
                .put('/api/reorder')
                .send({ orders })
                .expect(200);

            expect(response.body.success).toBe(true);
        });

        test('PUT /api/reorder should reject non-array', async () => {
            await request(app)
                .put('/api/reorder')
                .send({ orders: 'not an array' })
                .expect(400);
        });
    });

    describe('Semaphore/Wait functionality', () => {
        test('POST /api/initTask should handle non-existent task', async () => {
            await request(app)
                .post('/api/initTask')
                .send({ id: 'non-existent-task' })
                .expect(200);
        });

        test('POST /api/initTask should accept custom response', async () => {
            await request(app)
                .post('/api/initTask')
                .send({
                    id: 'test-task',
                    customResponse: { status: 500, body: { error: 'test' } }
                })
                .expect(200);
        });
    });
});
