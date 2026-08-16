var express = require('express');
var router = express.Router();
const sqliteService = require('../services/sqlite.service');
var pm = require('../middlewares/proxy.middleware');
const semaphore = require('../services/semaphore.service');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const openapiService = require('../services/openapi.service');
const criteriaService = require('../services/criteria-evaluator.service');
const graphqlService = require('../services/graphql.service');
const scriptRunner = require('../services/script-runner.service');
const routesService = require('../services/routes.service');
const logService = require('../services/log.service');
const versionService = require('../services/version.service');

// Configuración de multer para subida de archivos
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

// Asegurar que existe el directorio de uploads
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOADS_DIR);
    },
    filename: function (req, file, cb) {
        // Generar nombre único: timestamp + nombre original
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB límite
});

// El orden y la validación de rutas viven en routes.service, compartidos con MCP
const getNextOrder = (db, isProxy) => routesService.getNextOrder(isProxy);

/* Crear nueva ruta */
router.post('/create', upload.single('file'), async function(req, res, next) {
    // La validación y el guardado viven en routes.service para que el panel y
    // el servidor MCP no puedan divergir. Aquí solo queda lo propio de HTTP:
    // el fichero que sube multer y la traducción de errores a códigos.
    const file = (req.body.tiporespuesta === 'file' && req.file)
        ? { fileName: req.file.originalname, filePath: req.file.filename, fileMimeType: req.file.mimetype }
        : null;

    if (file) {
        console.log(`[API] Archivo subido: ${file.fileName} (${file.fileMimeType})`);
    }

    try {
        const id = await routesService.createRoute(req.body, { file });
        res.statusCode = 200;
        res.json({ id });
    } catch (err) {
        if (req.file) {
            fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {});
        }
        if (err.validation) {
            res.status(400).json({ error: err.message });
            return;
        }
        console.log(err.message);
        res.statusCode = 500;
        res.end();
    }
});

/* Duplicar ruta existente */
router.post('/duplicate/:id', async function(req, res) {
    // El servicio copia también condiciones, fallbacks y mensajes WebSocket,
    // que antes se perdían al duplicar
    try {
        const id = await routesService.duplicateRoute(req.params.id, req.body.newRoute);
        res.json({ id });
    } catch (err) {
        if (err.validation) {
            return res.status(400).json({ error: err.message });
        }
        console.error(`[API] Error duplicando ruta: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

router.put('/update/:id', upload.single('file'), async function(req, res) {
    const id = req.params.id;
    const isFile = req.body.tiporespuesta === 'file';

    // Qué hacer con el fichero: uno nuevo, conservar el que hay, o ninguno
    // (si la ruta deja de ser de tipo file, el servicio borra el antiguo)
    let file = null;
    if (isFile && req.file) {
        file = { fileName: req.file.originalname, filePath: req.file.filename, fileMimeType: req.file.mimetype };
        console.log(`[API] Nuevo archivo subido: ${file.fileName} (${file.fileMimeType})`);
    } else if (isFile && req.body.keepFile === 'true') {
        file = 'keep';
    }

    try {
        await routesService.updateRoute(id, req.body, { file });
        res.statusCode = 200;
        res.json({ success: true });
    } catch (err) {
        if (err.validation) {
            if (req.file) {
                fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {});
            }
            res.status(400).json({ error: err.message });
            return;
        }
        console.log(err.message);

        // Si hubo error y se subió archivo nuevo, eliminarlo
        if (req.file) {
            fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {});
        }
        res.statusCode = 500;
        res.end();
    }
});

router.delete('/delete/:id', async function(req, res) {
    try {
        await routesService.deleteRoute(req.params.id);
        res.statusCode = 200;
        res.end();
    } catch (err) {
        if (err.validation) {
            res.status(404).json({ error: err.message });
            return;
        }
        console.log(err.message);
        res.statusCode = 500;
        res.end();
    }
});

router.post('/delete-bulk', async function(req, res) {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, error: 'No IDs provided' });
    }

    const db = sqliteService.getDatabase();

    try {
        // Obtener archivos asociados antes de eliminar
        const placeholders = ids.map(() => '?').join(',');
        const rows = await new Promise((resolve, reject) => {
            db.all(`SELECT id, filePath FROM rutas WHERE id IN (${placeholders})`, ids, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // Eliminar archivos asociados
        for (const row of rows) {
            if (row.filePath) {
                const fullPath = path.join(UPLOADS_DIR, row.filePath);
                fs.unlink(fullPath, (err) => {
                    if (!err) console.log(`[API] Archivo eliminado: ${row.filePath}`);
                });
            }
        }

        // Eliminar registros
        await new Promise((resolve, reject) => {
            db.run(`DELETE FROM rutas WHERE id IN (${placeholders})`, ids, function(err) {
                if (err) reject(err);
                else resolve();
            });
        });

        console.log(`[API] ${ids.length} rutas eliminadas en bulk`);


        await pm.reloadProxyConfigs();

        res.json({ success: true, deleted: ids.length });
    } catch (err) {
        console.error('[API] Error en bulk delete:', err.message);

        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/routes', function(req, res, next) {
    let sql = `SELECT * FROM rutas
           ORDER BY COALESCE(orden, 999999) ASC, id ASC`;
    const db = sqliteService.getDatabase();
    let result = [];
    db.all(sql, [], (err, rows) => {
        if (err) {
          throw err;
        }
        rows.forEach((row) => {
            // console.log(row);
            result.push(row);
            // result.push({
            //     id: row.id,
            //     tipo: row.tipo,
            //     ruta: row.ruta,
            //     codigo: row.codigo,
            //     respuesta: row.respuesta,
            //     data: row.data
            // });
        });


    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
      });
    
});

router.post('/initTask', function(req, res, next) {
  const { id, customResponse } = req.body;
  semaphore.wakeUp(id, customResponse);
  res.end();
});

router.post('/validateRegex', function(req, res, next) {
  const { regex, testUrl } = req.body;
  try {
    const re = new RegExp(regex);
    const isValid = true;
    const matches = testUrl ? re.test(testUrl) : null;
    res.json({ valid: isValid, matches, error: null });
  } catch (e) {
    res.json({ valid: false, matches: false, error: e.message });
  }
});

/* Validar expresión de criterio */
router.post('/validateCriteria', function(req, res) {
    const { criteria, testContext } = req.body;

    const validation = criteriaService.validateCriteria(criteria);
    if (!validation.valid) {
        return res.json({ valid: false, error: validation.error });
    }

    // Si hay contexto de prueba, evaluar la expresión
    if (testContext) {
        const result = criteriaService.evaluateCriteria(criteria, testContext);
        return res.json({ valid: true, testResult: result });
    }

    res.json({ valid: true });
});

/* Validar un script de transformación de proxy, opcionalmente probándolo */
router.post('/validateScript', function(req, res) {
    const { script, phase, testContext } = req.body;

    const validation = scriptRunner.validateScript(script);
    if (!validation.valid) {
        return res.json({ valid: false, error: validation.error });
    }

    // Sin contexto solo se valida sintaxis y patrones prohibidos
    if (!testContext) {
        return res.json({ valid: true });
    }

    const vars = {};
    const outcome = phase === 'response'
        ? scriptRunner.runResponseScript(script, {
            status: testContext.status || 200,
            headers: testContext.headers || {},
            bodyText: typeof testContext.body === 'string' ? testContext.body : JSON.stringify(testContext.body || {}),
            request: testContext.request || {},
            vars
        })
        : scriptRunner.runRequestScript(script, {
            method: testContext.method || 'GET',
            path: testContext.path || '/',
            query: testContext.query || {},
            headers: testContext.headers || {},
            bodyText: typeof testContext.body === 'string' ? testContext.body : JSON.stringify(testContext.body || {}),
            vars
        });

    res.json({ valid: true, testResult: outcome });
});

/* Versión en ejecución y si hay una más nueva publicada */
router.get('/version', async function(req, res) {
    try {
        const estado = await versionService.getStatus({ force: req.query.force === 'true' });
        res.json(estado);
    } catch (err) {
        // No poder comprobarlo no es un error para quien pregunta
        console.log(`[API] Error comprobando la versión: ${err.message}`);
        res.json({
            current: versionService.VERSION_ACTUAL,
            latest: null,
            update_available: false,
            package_url: versionService.URL_PAQUETE
        });
    }
});

// ===== LOG =====

/* Consultar el log con filtros */
router.get('/logs', async function(req, res) {
    try {
        const resultado = await logService.query({
            from: req.query.from,
            to: req.query.to,
            type: req.query.type ? String(req.query.type).split(',') : null,
            level: req.query.level ? String(req.query.level).split(',') : null,
            method: req.query.method,
            status: req.query.status,
            url: req.query.url,
            search: req.query.search,
            routeId: req.query.routeId,
            traceId: req.query.traceId,
            step: req.query.step ? String(req.query.step).split(',') : null,
            minDuration: req.query.minDuration,
            limit: req.query.limit,
            offset: req.query.offset
        });
        res.json(resultado);
    } catch (err) {
        console.error(`[API] Error consultando el log: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/* Resumen y histograma, con los mismos filtros que la consulta */
router.get('/logs/stats', async function(req, res) {
    try {
        const resumen = await logService.stats({
            from: req.query.from,
            to: req.query.to,
            type: req.query.type ? String(req.query.type).split(',') : null,
            level: req.query.level ? String(req.query.level).split(',') : null,
            method: req.query.method,
            status: req.query.status,
            url: req.query.url,
            search: req.query.search,
            routeId: req.query.routeId,
            traceId: req.query.traceId,
            minDuration: req.query.minDuration
        });
        res.json({ ...resumen, storage: logService.estado() });
    } catch (err) {
        console.error(`[API] Error calculando estadísticas del log: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/* Traza completa de una petición, con sus pasos en orden */
router.get('/logs/trace/:traceId', async function(req, res) {
    try {
        const traza = await logService.getTrace(req.params.traceId);
        if (!traza) {
            return res.status(404).json({ error: 'Traza no encontrada' });
        }
        res.json(traza);
    } catch (err) {
        console.error(`[API] Error recuperando la traza: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/* Vaciar el log, entero o solo lo que casa con los filtros */
router.delete('/logs', async function(req, res) {
    try {
        const eliminados = await logService.clear({
            from: req.query.from,
            to: req.query.to,
            level: req.query.level ? String(req.query.level).split(',') : null,
            type: req.query.type ? String(req.query.type).split(',') : null
        });
        res.json({ success: true, deleted: eliminados });
    } catch (err) {
        console.error(`[API] Error vaciando el log: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ===== CONEXIONES MCP =====

/* Listar conexiones MCP */
router.get('/mcp/tokens', async function(req, res) {
    try {
        const tokens = await sqliteService.getMcpTokens();
        res.json(tokens);
    } catch (err) {
        console.error(`[API] Error listando tokens MCP: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/* Crear una conexión MCP y devolver su token */
router.post('/mcp/tokens', async function(req, res) {
    const nombre = (req.body.nombre || '').trim();
    if (!nombre) {
        return res.status(400).json({ error: 'El nombre es obligatorio' });
    }

    try {
        const token = await sqliteService.createMcpToken(nombre);
        res.json(token);
    } catch (err) {
        console.error(`[API] Error creando token MCP: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/* Revocar una conexión MCP */
router.delete('/mcp/tokens/:id', async function(req, res) {
    try {
        const eliminado = await sqliteService.deleteMcpToken(req.params.id);
        if (!eliminado) {
            return res.status(404).json({ error: 'La conexión no existe' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error(`[API] Error eliminando token MCP: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/* Referencia de la API ms.* para el modal de ayuda */
router.get('/script-api-reference', function(req, res) {
    res.json(scriptRunner.getApiReference());
});

/* Definiciones de tipos del API ms.*, para el autocompletado del editor */
router.get('/script-types', function(req, res) {
    res.type('text/plain; charset=utf-8');
    // Cambian solo al cambiar la versión del servidor
    res.set('Cache-Control', 'no-cache');
    res.send(scriptRunner.getTypeDefinitions());
});

/* Obtener helpers y ejemplos disponibles para criterios */
router.get('/criteria-helpers', function(req, res) {
    res.json({
        helpers: criteriaService.getAvailableHelpers(),
        examples: criteriaService.getExamples()
    });
});

/* Obtener condiciones de una ruta */
router.get('/conditions/:routeId', async function(req, res) {
    try {
        const conditions = await sqliteService.getConditionalResponses(req.params.routeId);
        res.json({ success: true, conditions });
    } catch (err) {
        console.error(`[API] Error obteniendo condiciones: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* Guardar condiciones de una ruta */
router.put('/conditions/:routeId', async function(req, res) {
    const { conditions } = req.body;

    if (!Array.isArray(conditions)) {
        return res.status(400).json({ success: false, error: 'conditions debe ser un array' });
    }

    // Validar cada expresión de criterio
    for (let i = 0; i < conditions.length; i++) {
        const c = conditions[i];
        if (!c.criteria || !c.criteria.trim()) {
            return res.status(400).json({
                success: false,
                error: `La condición ${i + 1} no tiene criterio definido`
            });
        }

        const validation = criteriaService.validateCriteria(c.criteria);
        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                error: `Condición "${c.nombre || i + 1}": ${validation.error}`
            });
        }
    }

    try {
        await sqliteService.saveConditionalResponses(req.params.routeId, conditions);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API] Error guardando condiciones: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== PROXY FALLBACKS API =====

/* Obtener fallbacks de una ruta proxy */
router.get('/fallbacks/:routeId', async function(req, res) {
    try {
        const fallbacks = await sqliteService.getAllProxyFallbacks(req.params.routeId);
        res.json({ success: true, fallbacks });
    } catch (err) {
        console.error(`[API] Error obteniendo fallbacks: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* Guardar fallbacks de una ruta proxy */
router.put('/fallbacks/:routeId', async function(req, res) {
    // La validación, el guardado de condiciones anidadas y la recarga del
    // proxy viven en routes.service, compartidos con MCP
    try {
        await routesService.saveFallbacks(req.params.routeId, req.body.fallbacks);
        res.json({ success: true });
    } catch (err) {
        if (err.validation) {
            return res.status(400).json({ success: false, error: err.message });
        }
        console.error(`[API] Error guardando fallbacks: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/fallback-conditions/:fallbackId', async function(req, res) {
    try {
        const conditions = await sqliteService.getAllFallbackConditions(req.params.fallbackId);
        res.json({ success: true, conditions });
    } catch (err) {
        console.error(`[API] Error obteniendo condiciones de fallback: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* Guardar condiciones de un fallback */
router.put('/fallback-conditions/:fallbackId', async function(req, res) {
    try {
        await routesService.saveFallbackConditions(req.params.fallbackId, req.body.conditions);
        res.json({ success: true });
    } catch (err) {
        if (err.validation) {
            return res.status(400).json({ success: false, error: err.message });
        }
        console.error(`[API] Error guardando condiciones de fallback: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/graphql-operations/:routeId', async function(req, res) {
    try {
        const operations = await sqliteService.getAllGraphQLOperations(req.params.routeId);
        res.json({ success: true, operations });
    } catch (err) {
        console.error(`[API] Error obteniendo operaciones GraphQL: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* Guardar operaciones GraphQL de una ruta */
router.put('/graphql-operations/:routeId', async function(req, res) {
    const { operations } = req.body;

    if (!Array.isArray(operations)) {
        return res.status(400).json({ success: false, error: 'operations debe ser un array' });
    }

    // Validar cada operación
    for (let i = 0; i < operations.length; i++) {
        const op = operations[i];

        if (!op.operationName || !op.operationName.trim()) {
            return res.status(400).json({
                success: false,
                error: `La operación ${i + 1} debe tener un nombre`
            });
        }

        if (!['query', 'mutation'].includes(op.operationType)) {
            return res.status(400).json({
                success: false,
                error: `Operación "${op.operationName}": tipo inválido "${op.operationType}"`
            });
        }

        // Validar que la respuesta sea JSON válido (solo si no es proxy)
        if (!op.useProxy && op.respuesta && op.respuesta.trim()) {
            try {
                JSON.parse(op.respuesta);
            } catch (e) {
                return res.status(400).json({
                    success: false,
                    error: `Operación "${op.operationName}": JSON de respuesta inválido`
                });
            }
        }
    }

    try {
        await sqliteService.saveGraphQLOperations(req.params.routeId, operations);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API] Error guardando operaciones GraphQL: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== GRAPHQL SCHEMA API =====

/* Importar schema GraphQL desde URL remota */
router.post('/graphql-schema/import', async function(req, res) {
    const { url, routeId } = req.body;

    if (!url || !url.trim()) {
        return res.status(400).json({ success: false, error: 'URL is required' });
    }

    try {
        console.log(`[API] Importing GraphQL schema from: ${url}`);

        const introspectionResult = await graphqlService.fetchIntrospectionFromUrl(url);
        const { operations } = graphqlService.generateMockFromIntrospection(introspectionResult);
        console.log(`[API] Generated ${operations.length} mock operations from schema`);

        // Si se proporciona routeId, guardar directamente en BD
        if (routeId) {
            await sqliteService.saveGraphQLOperations(routeId, operations);

            const db = sqliteService.getDatabase();
            await new Promise((resolve, reject) => {
                db.run('UPDATE rutas SET graphql_schema = ?, graphql_proxy_url = ? WHERE id = ?',
                    [JSON.stringify(introspectionResult), url, routeId],
                    (err) => { if (err) reject(err); else resolve(); }
                );
            });
            console.log(`[API] Schema, proxy URL and operations saved to route ${routeId}`);
        }

        res.json({
            success: true,
            schema: introspectionResult,
            operations,
            operationCount: operations.length
        });
    } catch (err) {
        console.error(`[API] Error importing GraphQL schema: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
    }
});

/* Obtener schema GraphQL almacenado de una ruta */
router.get('/graphql-schema/:routeId', async function(req, res) {
    try {
        const db = sqliteService.getDatabase();
        const row = await new Promise((resolve, reject) => {
            db.get('SELECT graphql_schema FROM rutas WHERE id = ?', [req.params.routeId], (err, row) => {
                if (err) reject(err); else resolve(row);
            });
        });

        if (!row || !row.graphql_schema) {
            return res.json({ success: true, schema: null });
        }

        res.json({ success: true, schema: JSON.parse(row.graphql_schema) });
    } catch (err) {
        console.error(`[API] Error getting GraphQL schema: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* Guardar/actualizar schema GraphQL de una ruta */
router.put('/graphql-schema/:routeId', async function(req, res) {
    const { schema } = req.body;
    try {
        const db = sqliteService.getDatabase();
        await new Promise((resolve, reject) => {
            db.run('UPDATE rutas SET graphql_schema = ? WHERE id = ?',
                [schema ? JSON.stringify(schema) : null, req.params.routeId],
                (err) => { if (err) reject(err); else resolve(); }
            );
        });
        res.json({ success: true });
    } catch (err) {
        console.error(`[API] Error saving GraphQL schema: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* Obtener/guardar proxy URL de una ruta GraphQL */
router.get('/graphql-proxy-url/:routeId', async function(req, res) {
    try {
        const db = sqliteService.getDatabase();
        const row = await new Promise((resolve, reject) => {
            db.get('SELECT graphql_proxy_url FROM rutas WHERE id = ?', [req.params.routeId], (err, row) => {
                if (err) reject(err); else resolve(row);
            });
        });
        res.json({ success: true, proxyUrl: row?.graphql_proxy_url || null });
    } catch (err) {
        console.error(`[API] Error getting GraphQL proxy URL: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/graphql-proxy-url/:routeId', async function(req, res) {
    const { proxyUrl } = req.body;
    try {
        const db = sqliteService.getDatabase();
        await new Promise((resolve, reject) => {
            db.run('UPDATE rutas SET graphql_proxy_url = ? WHERE id = ?',
                [proxyUrl || null, req.params.routeId],
                (err) => { if (err) reject(err); else resolve(); }
            );
        });
        res.json({ success: true });
    } catch (err) {
        console.error(`[API] Error saving GraphQL proxy URL: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== TAGS API =====

/* Obtener todos los tags */
router.get('/tags', async function(req, res) {
    try {
        const tags = await sqliteService.getAllTags();
        res.json({ success: true, tags });
    } catch (err) {
        console.error(`[API] Error obteniendo tags: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* Crear nuevo tag */
router.post('/tags', async function(req, res) {
    const { name, color } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Tag name is required' });
    }
    try {
        const tag = await sqliteService.getOrCreateTag(name, color || '#6366f1');
        res.json({ success: true, tag });
    } catch (err) {
        console.error(`[API] Error creando tag: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* Actualizar color de tag */
router.put('/tags/:id', async function(req, res) {
    const { color } = req.body;
    if (!color) {
        return res.status(400).json({ success: false, error: 'Color is required' });
    }
    try {
        await sqliteService.updateTagColor(req.params.id, color);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API] Error actualizando tag: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* Eliminar tag */
router.delete('/tags/:id', async function(req, res) {
    try {
        await sqliteService.deleteTag(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API] Error eliminando tag: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.put('/toggle-active/:id', async function(req, res, next) {
    const db = sqliteService.getDatabase();
    const id = req.params.id;
    const activo = req.body.activo ? 1 : 0;

    try {
        await new Promise((resolve, reject) => {
            db.run(`UPDATE rutas SET activo = ? WHERE id = ?`, [activo, id], function(err) {
                if (err) reject(err);
                else resolve();
            });
        });

        console.log(`Ruta ${id} activo cambiado a ${activo}`);


        console.log('Recargando configuración de proxy...');
        await pm.reloadProxyConfigs();
        console.log('Configuración de proxy recargada');

        res.statusCode = 200;
        res.end();
    } catch (err) {
        console.log(err.message);

        res.statusCode = 500;
        res.end();
    }
});

router.put('/toggle-wait/:id', function(req, res, next) {
    const db = sqliteService.getDatabase();
    const id = req.params.id;
    const esperaActiva = req.body.esperaActiva ? 1 : 0;
    db.run(`UPDATE rutas SET esperaActiva = ? WHERE id = ?`, [esperaActiva, id], function(err) {
        if (err) {
  
          console.log(err.message);
          res.statusCode = 500;
          res.end();
          return;
        }
        console.log(`Ruta ${id} esperaActiva cambiado a ${esperaActiva}`);

      });

      res.statusCode = 200;
      res.end();
});

// Actualizar orden de una ruta específica con desplazamiento automático
router.put('/update-order/:id', async function(req, res, next) {
    const db = sqliteService.getDatabase();
    const id = parseInt(req.params.id);
    const newOrden = parseInt(req.body.orden);

    if (isNaN(newOrden) || newOrden < 1) {
        res.statusCode = 400;
        res.json({ error: 'Orden debe ser un número positivo' });
        return;
    }

    try {
        // Obtener orden actual de la ruta
        const currentRow = await new Promise((resolve, reject) => {
            db.get(`SELECT orden, tiporespuesta FROM rutas WHERE id = ?`, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!currentRow) {
    
            res.statusCode = 404;
            res.json({ error: 'Ruta no encontrada' });
            return;
        }

        const currentOrden = currentRow.orden;
        const isProxy = currentRow.tiporespuesta === 'proxy';

        // Si el orden no cambió, no hacer nada
        if (currentOrden === newOrden) {
    
            res.json({ success: true, id, orden: newOrden });
            return;
        }

        // Determinar el rango de rutas a desplazar (solo del mismo tipo: proxy o no-proxy)
        const typeCondition = isProxy
            ? `tiporespuesta = 'proxy'`
            : `(tiporespuesta != 'proxy' OR tiporespuesta IS NULL)`;

        if (newOrden < currentOrden) {
            // Moviendo hacia arriba (menor orden = mayor prioridad)
            // Desplazar hacia abajo las rutas entre newOrden y currentOrden-1
            await new Promise((resolve) => {
                db.run(
                    `UPDATE rutas SET orden = orden + 1
                     WHERE ${typeCondition} AND orden >= ? AND orden < ? AND id != ?`,
                    [newOrden, currentOrden, id],
                    () => resolve()
                );
            });
        } else {
            // Moviendo hacia abajo (mayor orden = menor prioridad)
            // Desplazar hacia arriba las rutas entre currentOrden+1 y newOrden
            await new Promise((resolve) => {
                db.run(
                    `UPDATE rutas SET orden = orden - 1
                     WHERE ${typeCondition} AND orden > ? AND orden <= ? AND id != ?`,
                    [currentOrden, newOrden, id],
                    () => resolve()
                );
            });
        }

        // Actualizar el orden de la ruta objetivo
        await new Promise((resolve) => {
            db.run(`UPDATE rutas SET orden = ? WHERE id = ?`, [newOrden, id], () => resolve());
        });

        console.log(`Ruta ${id} orden cambiado de ${currentOrden} a ${newOrden} (con desplazamiento)`);

        res.json({ success: true, id, orden: newOrden });
    } catch (err) {
        console.error('Error actualizando orden:', err);

        res.statusCode = 500;
        res.json({ error: err.message });
    }
});

// Mover ruta arriba (decrementar orden)
router.put('/move-up/:id', function(req, res, next) {
    const db = sqliteService.getDatabase();
    const id = req.params.id;

    // Obtener orden actual
    db.get(`SELECT orden FROM rutas WHERE id = ?`, [id], (err, row) => {
        if (err || !row) {
    
            res.statusCode = 404;
            res.json({ error: 'Ruta no encontrada' });
            return;
        }

        const currentOrder = row.orden || 999999;

        // Buscar la ruta con orden inmediatamente menor
        db.get(`SELECT id, orden FROM rutas WHERE orden < ? ORDER BY orden DESC LIMIT 1`, [currentOrder], (err, prevRow) => {
            if (!prevRow) {
                // Ya está en el primer lugar
        
                res.json({ success: true, message: 'Ya está en primer lugar' });
                return;
            }

            // Intercambiar órdenes
            const prevOrder = prevRow.orden;
            const prevId = prevRow.id;

            db.run(`UPDATE rutas SET orden = ? WHERE id = ?`, [prevOrder, id], () => {
                db.run(`UPDATE rutas SET orden = ? WHERE id = ?`, [currentOrder, prevId], () => {
            
                    console.log(`Rutas ${id} y ${prevId} intercambiadas`);
                    res.json({ success: true });
                });
            });
        });
    });
});

// Mover ruta abajo (incrementar orden)
router.put('/move-down/:id', function(req, res, next) {
    const db = sqliteService.getDatabase();
    const id = req.params.id;

    // Obtener orden actual
    db.get(`SELECT orden FROM rutas WHERE id = ?`, [id], (err, row) => {
        if (err || !row) {
    
            res.statusCode = 404;
            res.json({ error: 'Ruta no encontrada' });
            return;
        }

        const currentOrder = row.orden || 0;

        // Buscar la ruta con orden inmediatamente mayor
        db.get(`SELECT id, orden FROM rutas WHERE orden > ? ORDER BY orden ASC LIMIT 1`, [currentOrder], (err, nextRow) => {
            if (!nextRow) {
                // Ya está en el último lugar
        
                res.json({ success: true, message: 'Ya está en último lugar' });
                return;
            }

            // Intercambiar órdenes
            const nextOrder = nextRow.orden;
            const nextId = nextRow.id;

            db.run(`UPDATE rutas SET orden = ? WHERE id = ?`, [nextOrder, id], () => {
                db.run(`UPDATE rutas SET orden = ? WHERE id = ?`, [currentOrder, nextId], () => {
            
                    console.log(`Rutas ${id} y ${nextId} intercambiadas`);
                    res.json({ success: true });
                });
            });
        });
    });
});

// Reordenar múltiples rutas (para drag & drop)
router.put('/reorder', function(req, res, next) {
    const db = sqliteService.getDatabase();
    const { orders } = req.body; // Array de { id, orden }

    if (!Array.isArray(orders)) {
        res.statusCode = 400;
        res.json({ error: 'Se requiere un array de órdenes' });
        return;
    }

    let completed = 0;
    let hasError = false;

    orders.forEach(({ id, orden }) => {
        db.run(`UPDATE rutas SET orden = ? WHERE id = ?`, [orden, id], function(err) {
            if (err && !hasError) {
                hasError = true;
                console.log(err.message);
            }
            completed++;

            if (completed === orders.length) {
        
                if (hasError) {
                    res.statusCode = 500;
                    res.json({ error: 'Error actualizando órdenes' });
                } else {
                    console.log(`Reordenadas ${orders.length} rutas`);
                    res.json({ success: true });
                }
            }
        });
    });
});

// Normalizar órdenes - reinicializa los órdenes secuencialmente
router.post('/normalize-order', async function(req, res, next) {
    const db = sqliteService.getDatabase();

    try {
        // Obtener rutas normales ordenadas por orden actual
        const normalRoutes = await new Promise((resolve, reject) => {
            db.all(`SELECT id FROM rutas WHERE tiporespuesta != 'proxy' ORDER BY COALESCE(orden, 999999) ASC, id ASC`, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // Obtener proxies ordenados por orden actual
        const proxyRoutes = await new Promise((resolve, reject) => {
            db.all(`SELECT id FROM rutas WHERE tiporespuesta = 'proxy' ORDER BY COALESCE(orden, 999999) ASC, id ASC`, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // Asignar órdenes secuenciales a rutas normales (1, 2, 3...)
        let order = 1;
        for (const row of normalRoutes) {
            await new Promise((resolve) => {
                db.run(`UPDATE rutas SET orden = ? WHERE id = ?`, [order, row.id], () => resolve());
            });
            order++;
        }

        // Asignar órdenes a proxies (99999999, 99999998, ...)
        let proxyOrder = PROXY_ORDER_START;
        for (const row of proxyRoutes) {
            await new Promise((resolve) => {
                db.run(`UPDATE rutas SET orden = ? WHERE id = ?`, [proxyOrder, row.id], () => resolve());
            });
            proxyOrder--;
        }


        console.log(`Órdenes normalizados: ${normalRoutes.length} rutas, ${proxyRoutes.length} proxies`);
        res.json({ success: true, rutas: normalRoutes.length, proxies: proxyRoutes.length });
    } catch (err) {

        console.error('Error normalizando órdenes:', err);
        res.statusCode = 500;
        res.json({ error: err.message });
    }
});

// ===== IMPORT OPENAPI =====

// Preview: parsea spec y devuelve rutas sin insertar
router.post('/import-openapi/preview', upload.single('specFile'), async function(req, res) {
    try {
        let content = '';
        let format = req.body.format || 'auto';

        if (req.file) {
            content = fs.readFileSync(req.file.path, 'utf-8');
            fs.unlink(req.file.path, () => {});
            if (format === 'auto') {
                format = req.file.originalname.match(/\.ya?ml$/i) ? 'yaml' : 'json';
            }
        } else if (req.body.specUrl) {
            // Fetch spec from remote URL
            const specUrl = req.body.specUrl;
            console.log(`[OPENAPI] Fetching spec from URL: ${specUrl}`);
            const fetchModule = specUrl.startsWith('https') ? require('https') : require('http');
            content = await new Promise((resolve, reject) => {
                fetchModule.get(specUrl, { headers: { 'Accept': 'application/json, application/yaml, */*' } }, (response) => {
                    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                        // Follow redirect
                        const redirectModule = response.headers.location.startsWith('https') ? require('https') : require('http');
                        redirectModule.get(response.headers.location, (redirectRes) => {
                            let data = '';
                            redirectRes.on('data', chunk => data += chunk);
                            redirectRes.on('end', () => resolve(data));
                        }).on('error', reject);
                        return;
                    }
                    if (response.statusCode !== 200) {
                        reject(new Error(`HTTP ${response.statusCode} fetching spec from URL`));
                        return;
                    }
                    let data = '';
                    response.on('data', chunk => data += chunk);
                    response.on('end', () => resolve(data));
                }).on('error', reject);
            });
            if (format === 'auto') {
                format = specUrl.match(/\.ya?ml$/i) ? 'yaml' : 'json';
            }
        } else if (req.body.content) {
            content = req.body.content;
        } else {
            return res.status(400).json({ success: false, error: 'No specification provided' });
        }

        const basePath = req.body.basePath || '';

        // Parsear y validar
        const spec = await openapiService.parseSpec(content, format);
        const specInfo = openapiService.getSpecInfo(spec);

        // Generar rutas
        const routes = openapiService.generateRoutes(spec, basePath);
        specInfo.operationCount = routes.length;

        // Detectar conflictos con rutas existentes
        const db = sqliteService.getDatabase();
        for (const route of routes) {
            const existing = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT id FROM rutas WHERE ruta = ? AND tipo = ?',
                    [route.ruta, route.tipo],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });
            route._conflict = !!existing;
            route._existingId = existing ? existing.id : null;
        }


        res.json({ success: true, specInfo, routes });
    } catch (err) {
        console.error('[OPENAPI] Preview error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// Confirm: inserta las rutas seleccionadas en la BD
router.post('/import-openapi/confirm', async function(req, res) {
    const { routes, conflictStrategy = 'skip', tags: importTags } = req.body;

    if (!Array.isArray(routes) || routes.length === 0) {
        return res.status(400).json({ success: false, error: 'No routes provided' });
    }

    // Validar que ninguna ruta empiece con /api/
    const reserved = routes.filter(r => routesService.isReservedRoute(r.ruta));
    if (reserved.length > 0) {
        return res.status(400).json({ success: false, error: 'Routes starting with /api/ are reserved' });
    }

    // Palette for random tag colors
    const tagColorPalette = [
        '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#f59e0b',
        '#10b981', '#14b8a6', '#06b6d4', '#3b82f6', '#374151', '#1e293b'
    ];
    const getRandomColor = () => tagColorPalette[Math.floor(Math.random() * tagColorPalette.length)];

    const db = sqliteService.getDatabase();
    let imported = 0;
    let skipped = 0;

    try {
        // Obtener orden inicial una vez
        let currentOrder = await getNextOrder(db, false);

        for (const route of routes) {
            // Verificar si ya existe
            const existing = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT id FROM rutas WHERE ruta = ? AND tipo = ?',
                    [route.ruta, route.tipo],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });

            if (existing) {
                if (conflictStrategy === 'skip') {
                    skipped++;
                    continue;
                } else if (conflictStrategy === 'overwrite') {
                    // Combine tags for overwrite as well
                    let finalTags = [];
                    if (importTags && Array.isArray(importTags)) {
                        finalTags = [...importTags];
                    }
                    if (route.openApiTags && Array.isArray(route.openApiTags) && route.openApiTags.length > 0) {
                        for (const tagName of route.openApiTags) {
                            const tag = await sqliteService.getOrCreateTag(tagName, getRandomColor());
                            if (!finalTags.some(t => t.id === tag.id)) {
                                finalTags.push({ id: tag.id, name: tag.name, color: tag.color });
                            }
                        }
                    }
                    const routeTags = finalTags.length > 0 ? JSON.stringify(finalTags) : null;

                    await new Promise((resolve, reject) => {
                        db.run(
                            `UPDATE rutas SET codigo = ?, respuesta = ?, tiporespuesta = ?, isRegex = ?, operationId = ?, summary = ?, description = ?, tags = ?, requestBodyExample = ? WHERE id = ?`,
                            [route.codigo, route.respuesta, route.tiporespuesta, route.isRegex ? 1 : 0, route.operationId || null, route.summary || null, route.description || null, routeTags, route.requestBodyExample || null, existing.id],
                            function(err) {
                                if (err) reject(err);
                                else resolve();
                            }
                        );
                    });
                    imported++;
                    continue;
                }
            }

            // Insertar nueva ruta
            // Combine tags: user-selected import tags + OpenAPI operation tags
            let finalTags = [];

            // Add user-selected tags from import modal
            if (importTags && Array.isArray(importTags)) {
                finalTags = [...importTags];
            }

            // Add tags from OpenAPI operation (create them if they don't exist)
            if (route.openApiTags && Array.isArray(route.openApiTags) && route.openApiTags.length > 0) {
                for (const tagName of route.openApiTags) {
                    const tag = await sqliteService.getOrCreateTag(tagName, getRandomColor());
                    // Check if tag already in finalTags
                    if (!finalTags.some(t => t.id === tag.id)) {
                        finalTags.push({ id: tag.id, name: tag.name, color: tag.color });
                    }
                }
            }

            const routeTags = finalTags.length > 0 ? JSON.stringify(finalTags) : null;
            await new Promise((resolve, reject) => {
                db.run(
                    `INSERT INTO rutas(tipo, ruta, codigo, respuesta, tiporespuesta, esperaActiva, isRegex, customHeaders, activo, orden, tags, operationId, summary, description, requestBodyExample) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [route.tipo, route.ruta, route.codigo, route.respuesta, route.tiporespuesta, 0, route.isRegex ? 1 : 0, null, 1, currentOrder, routeTags, route.operationId || null, route.summary || null, route.description || null, route.requestBodyExample || null],
                    function(err) {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });
            currentOrder++;
            imported++;
        }


        console.log(`[OPENAPI] Import completado: ${imported} importadas, ${skipped} omitidas`);
        res.json({ success: true, imported, skipped });
    } catch (err) {

        console.error('[OPENAPI] Import error:', err.message);
        res.status(500).json({ success: false, error: err.message, imported, skipped });
    }
});

// ===== WEBSOCKET MESSAGES API =====

const websocketService = require('../services/websocket.service');

/* Get WebSocket messages for a route */
router.get('/ws-messages/:routeId', async function(req, res) {
    try {
        const messages = await sqliteService.getAllWebSocketMessages(req.params.routeId);
        res.json({ success: true, messages });
    } catch (err) {
        console.error(`[API] Error obteniendo mensajes WebSocket: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* Save WebSocket messages for a route */
router.put('/ws-messages/:routeId', async function(req, res) {
    const { messages } = req.body;

    if (!Array.isArray(messages)) {
        return res.status(400).json({ success: false, error: 'messages debe ser un array' });
    }

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!['onConnect', 'onMessage', 'periodic'].includes(m.event_type)) {
            return res.status(400).json({
                success: false,
                error: `Mensaje ${i + 1}: event_type inválido "${m.event_type}"`
            });
        }
    }

    try {
        await sqliteService.saveWebSocketMessages(req.params.routeId, messages);
        await websocketService.reloadRouteConfig(req.params.routeId);
        res.json({ success: true });
    } catch (err) {
        console.error(`[API] Error guardando mensajes WebSocket: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===== WEBSOCKET CLIENTS API =====

/* Get connected WebSocket clients */
router.get('/ws-clients', function(req, res) {
    res.json({ success: true, clients: websocketService.getConnectedClients() });
});

/* Send message to specific WebSocket clients */
router.post('/ws-clients/send', function(req, res) {
    const { clientIds, message } = req.body;

    if (!Array.isArray(clientIds) || !clientIds.length) {
        return res.status(400).json({ success: false, error: 'clientIds debe ser un array no vacío' });
    }
    if (typeof message !== 'string') {
        return res.status(400).json({ success: false, error: 'message debe ser un string' });
    }

    const sent = websocketService.sendMessageToClients(clientIds, message);
    res.json({ success: true, sent });
});

/* Disconnect a WebSocket client */
router.post('/ws-clients/disconnect', function(req, res) {
    const { clientId } = req.body;
    if (!clientId) {
        return res.status(400).json({ success: false, error: 'clientId es requerido' });
    }
    const disconnected = websocketService.disconnectClient(clientId);
    res.json({ success: true, disconnected });
});

module.exports = router;