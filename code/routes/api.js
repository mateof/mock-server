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

// Constantes para orden
const PROXY_ORDER_START = 99999999;

// Helper para obtener siguiente orden disponible
function getNextOrder(db, isProxy) {
    return new Promise((resolve) => {
        if (isProxy) {
            // Para proxies: buscar el menor orden de proxies y restar 1
            db.get(`SELECT MIN(orden) as minOrden FROM rutas WHERE tiporespuesta = 'proxy'`, [], (err, row) => {
                if (err || !row || !row.minOrden) {
                    resolve(PROXY_ORDER_START);
                } else {
                    resolve(row.minOrden - 1);
                }
            });
        } else {
            // Para rutas normales: buscar el mayor orden de no-proxies y sumar 1
            db.get(`SELECT MAX(orden) as maxOrden FROM rutas WHERE tiporespuesta != 'proxy' OR tiporespuesta IS NULL`, [], (err, row) => {
                if (err || !row || !row.maxOrden) {
                    resolve(1);
                } else {
                    resolve(row.maxOrden + 1);
                }
            });
        }
    });
}

/* Crear nueva ruta */
router.post('/create', upload.single('file'), async function(req, res, next) {
    // Validar que la ruta no comience con /api/
    const ruta = req.body.ruta || '';
    if (ruta.startsWith('/api/') || ruta === '/api') {
        if (req.file) {
            fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {});
        }
        res.status(400).json({ error: 'Routes starting with /api/ are reserved for internal use' });
        return;
    }

    const db = sqliteService.getDatabase();
    const customHeaders = req.body.customHeaders ? JSON.stringify(req.body.customHeaders) : null;
    const activo = req.body.activo !== 'false' && req.body.activo !== false ? 1 : 0;
    const esperaActiva = req.body.esperaActiva === 'true' || req.body.esperaActiva === true ? 1 : 0;
    const isProxy = req.body.tiporespuesta === 'proxy';
    const isFile = req.body.tiporespuesta === 'file';

    // Calcular orden automáticamente
    const orden = await getNextOrder(db, isProxy);

    // Datos del archivo si existe
    let fileName = null;
    let filePath = null;
    let fileMimeType = null;

    if (isFile && req.file) {
        fileName = req.file.originalname;
        filePath = req.file.filename; // Solo el nombre del archivo, no la ruta completa
        fileMimeType = req.file.mimetype;
        console.log(`[API] Archivo subido: ${fileName} (${fileMimeType})`);
    }

    // Tags
    const tags = req.body.tags || null;

    try {
        const result = await new Promise((resolve, reject) => {
            db.run(`INSERT INTO rutas(tipo, ruta, codigo, respuesta, tiporespuesta, esperaActiva, isRegex, customHeaders, activo, orden, fileName, filePath, fileMimeType, tags) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [req.body.tipo, req.body.ruta, req.body.codigo, req.body.respuesta, req.body.tiporespuesta, esperaActiva, req.body.isRegex === 'true' || req.body.isRegex === true ? 1 : 0, customHeaders, activo, orden, fileName, filePath, fileMimeType, tags],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ lastID: this.lastID });
                    }
                });
        });

        console.log(`Ruta insertada con id ${result.lastID} y orden ${orden}`);


        if (isProxy) {
            console.log('Recargando configuración de proxy...');
            await pm.reloadProxyConfigs();
            console.log('Configuración de proxy recargada');
        }

        res.statusCode = 200;
        res.json({ id: result.lastID });
    } catch (err) {
        console.log(err.message);

        // Si hubo error y se subió archivo, eliminarlo
        if (req.file) {
            fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {});
        }
        res.statusCode = 500;
        res.end();
    }
});

/* Duplicar ruta existente */
router.post('/duplicate/:id', async function(req, res) {
    const db = sqliteService.getDatabase();
    const id = req.params.id;
    const newRoute = req.body.newRoute;

    if (!newRoute) {
        return res.status(400).json({ error: 'New route is required' });
    }

    if (newRoute.startsWith('/api/') || newRoute === '/api') {
        return res.status(400).json({ error: 'Routes starting with /api/ are reserved for internal use' });
    }

    try {
        // Obtener la ruta original
        const original = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM rutas WHERE id = ?', [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!original) {
            return res.status(404).json({ error: 'Route not found' });
        }

        const isProxy = original.tiporespuesta === 'proxy';
        const orden = await getNextOrder(db, isProxy);

        // Determinar si la nueva ruta necesita ser regex
        const isRegex = original.isRegex;

        // Copiar archivo si existe
        let fileName = original.fileName;
        let filePath = original.filePath;
        let fileMimeType = original.fileMimeType;

        if (original.filePath) {
            const ext = path.extname(original.filePath);
            const newFileName = `${Date.now()}${ext}`;
            const srcPath = path.join(UPLOADS_DIR, original.filePath);
            const destPath = path.join(UPLOADS_DIR, newFileName);
            try {
                fs.copyFileSync(srcPath, destPath);
                filePath = newFileName;
            } catch (e) {
                console.log(`[API] No se pudo copiar archivo: ${e.message}`);
                fileName = null;
                filePath = null;
                fileMimeType = null;
            }
        }

        const result = await new Promise((resolve, reject) => {
            db.run(`INSERT INTO rutas(tipo, ruta, codigo, respuesta, tiporespuesta, esperaActiva, isRegex, customHeaders, activo, orden, fileName, filePath, fileMimeType, tags) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [original.tipo, newRoute, original.codigo, original.respuesta, original.tiporespuesta, original.esperaActiva, isRegex, original.customHeaders, original.activo, orden, fileName, filePath, fileMimeType, original.tags],
                function(err) {
                    if (err) reject(err);
                    else resolve({ lastID: this.lastID });
                });
        });

        console.log(`Ruta duplicada: ${original.ruta} -> ${newRoute} (nuevo id: ${result.lastID})`);

        if (isProxy) {
            await pm.reloadProxyConfigs();
        }

        res.json({ id: result.lastID });
    } catch (err) {
        console.error(`[API] Error duplicando ruta: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

router.put('/update/:id', upload.single('file'), async function(req, res) {
    // Validar que la ruta no comience con /api/
    const ruta = req.body.ruta || '';
    if (ruta.startsWith('/api/') || ruta === '/api') {
        if (req.file) {
            fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {});
        }
        res.status(400).json({ error: 'Routes starting with /api/ are reserved for internal use' });
        return;
    }

    const db = sqliteService.getDatabase();
    const id = req.params.id;
    const customHeaders = req.body.customHeaders ? JSON.stringify(req.body.customHeaders) : null;
    const activo = req.body.activo !== 'false' && req.body.activo !== false ? 1 : 0;
    const esperaActiva = req.body.esperaActiva === 'true' || req.body.esperaActiva === true ? 1 : 0;
    const isProxy = req.body.tiporespuesta === 'proxy';
    const isFile = req.body.tiporespuesta === 'file';

    // Verificar si cambió de/a proxy para recalcular orden
    const currentRow = await new Promise((resolve) => {
        db.get(`SELECT tiporespuesta, orden, filePath FROM rutas WHERE id = ?`, [id], (err, row) => resolve(row));
    });

    let newOrden = currentRow ? currentRow.orden : 1;
    const wasProxy = currentRow && currentRow.tiporespuesta === 'proxy';
    const oldFilePath = currentRow ? currentRow.filePath : null;

    // Si cambió de tipo (proxy <-> no proxy), recalcular orden
    if (wasProxy !== isProxy) {
        newOrden = await getNextOrder(db, isProxy);
        console.log(`Tipo cambiado, nuevo orden: ${newOrden}`);
    }

    // Datos del archivo
    let fileName = null;
    let filePath = null;
    let fileMimeType = null;

    if (isFile) {
        if (req.file) {
            // Nuevo archivo subido
            fileName = req.file.originalname;
            filePath = req.file.filename;
            fileMimeType = req.file.mimetype;
            console.log(`[API] Nuevo archivo subido: ${fileName} (${fileMimeType})`);

            // Eliminar archivo antiguo si existía
            if (oldFilePath) {
                const oldFullPath = path.join(UPLOADS_DIR, oldFilePath);
                fs.unlink(oldFullPath, (err) => {
                    if (!err) console.log(`[API] Archivo antiguo eliminado: ${oldFilePath}`);
                });
            }
        } else if (req.body.keepFile === 'true') {
            // Mantener archivo existente
            const existingFile = await new Promise((resolve) => {
                db.get(`SELECT fileName, filePath, fileMimeType FROM rutas WHERE id = ?`, [id], (err, row) => resolve(row));
            });
            if (existingFile) {
                fileName = existingFile.fileName;
                filePath = existingFile.filePath;
                fileMimeType = existingFile.fileMimeType;
            }
        }
    } else if (oldFilePath) {
        // Cambió de tipo file a otro, eliminar archivo
        const oldFullPath = path.join(UPLOADS_DIR, oldFilePath);
        fs.unlink(oldFullPath, (err) => {
            if (!err) console.log(`[API] Archivo eliminado por cambio de tipo: ${oldFilePath}`);
        });
    }

    // Tags
    const tags = req.body.tags || null;

    try {
        await new Promise((resolve, reject) => {
            db.run(`UPDATE rutas SET tipo = ?, ruta = ?, codigo = ?, respuesta = ?, tiporespuesta = ?, esperaActiva = ?, isRegex = ?, customHeaders = ?, activo = ?, orden = ?, fileName = ?, filePath = ?, fileMimeType = ?, tags = ? WHERE id = ?`,
                [req.body.tipo, req.body.ruta, req.body.codigo, req.body.respuesta, req.body.tiporespuesta, esperaActiva, req.body.isRegex === 'true' || req.body.isRegex === true ? 1 : 0, customHeaders, activo, newOrden, fileName, filePath, fileMimeType, tags, id],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
        });

        console.log(`Ruta ${id} actualizada con orden ${newOrden}`);


        console.log('Recargando configuración de proxy...');
        await pm.reloadProxyConfigs();
        console.log('Configuración de proxy recargada');

        res.statusCode = 200;
        res.json({ success: true });
    } catch (err) {
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
    const db = sqliteService.getDatabase();
    const id = req.params.id;

    try {
        // Primero obtener info del archivo si existe
        const row = await new Promise((resolve, reject) => {
            db.get(`SELECT filePath FROM rutas WHERE id = ?`, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        // Eliminar archivo si existe
        if (row && row.filePath) {
            const fullPath = path.join(UPLOADS_DIR, row.filePath);
            fs.unlink(fullPath, (unlinkErr) => {
                if (!unlinkErr) console.log(`[API] Archivo eliminado: ${row.filePath}`);
            });
        }

        // Eliminar registro
        await new Promise((resolve, reject) => {
            db.run(`DELETE FROM rutas WHERE id = ?`, [id], function(deleteErr) {
                if (deleteErr) reject(deleteErr);
                else resolve();
            });
        });

        console.log(`Ruta eliminada con id ${id}`);


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
    const reserved = routes.filter(r => r.ruta.startsWith('/api/') || r.ruta === '/api');
    if (reserved.length > 0) {
        return res.status(400).json({ success: false, error: 'Routes starting with /api/ are reserved' });
    }

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
                    await new Promise((resolve, reject) => {
                        db.run(
                            `UPDATE rutas SET codigo = ?, respuesta = ?, tiporespuesta = ?, isRegex = ? WHERE id = ?`,
                            [route.codigo, route.respuesta, route.tiporespuesta, route.isRegex ? 1 : 0, existing.id],
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
            // Use tags from the route (if provided per-route) or from importTags
            const routeTags = route.tags ? JSON.stringify(route.tags) : (importTags ? JSON.stringify(importTags) : null);
            await new Promise((resolve, reject) => {
                db.run(
                    `INSERT INTO rutas(tipo, ruta, codigo, respuesta, tiporespuesta, esperaActiva, isRegex, customHeaders, activo, orden, tags) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                    [route.tipo, route.ruta, route.codigo, route.respuesta, route.tiporespuesta, 0, route.isRegex ? 1 : 0, null, 1, currentOrder, routeTags],
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

module.exports = router;