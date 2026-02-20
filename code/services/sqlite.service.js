var sqlite3 = require('sqlite3');
var path = require('path');
var fs = require('fs');

// Ruta de la base de datos
const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'database.db');

// Conexión persistente (singleton)
let _db = null;

async function initSql(){
    console.log('[DB] Inicializando base de datos SQLite...');
    console.log(`[DB] Ruta: ${DB_PATH}`);

    // Asegurar que existe el directorio data
    if (!fs.existsSync(DB_DIR)) {
        console.log('[DB] Creando directorio data...');
        fs.mkdirSync(DB_DIR, { recursive: true });
    }

    // Crear conexión persistente
    _db = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
            if (err) {
                console.error("[DB] Error abriendo base de datos: " + err);
                reject(err);
                return;
            }
            resolve(db);
        });
    });

    // Habilitar WAL mode para mejor concurrencia
    await new Promise((resolve) => {
        _db.run('PRAGMA journal_mode=WAL', () => resolve());
    });

    console.log('[DB] Conexión persistente establecida');
    await createTables(_db);
    console.log('[DB] Esquema verificado correctamente');
}

function getDatabase() {
    return _db;
}

async function getRuta(ruta, tipo) {
    console.log(`[DB] Buscando ruta: ${ruta} (método: ${tipo})`);
    const db = _db;
    const rutaSinQuery = ruta.split("?")[0];
    console.log(`[DB] Ruta sin query params: ${rutaSinQuery}`);

    // Primero buscar rutas exactas (no regex) con tipo específico o 'any' y que estén activas
    // Ordenar por: 1) tipo específico primero, 2) orden de prioridad (menor = mayor prioridad)
    let sql = `SELECT * FROM rutas WHERE ruta = ? AND (tipo = ? OR tipo = 'any') AND (isRegex IS NULL OR isRegex = 0) AND (activo IS NULL OR activo = 1) ORDER BY CASE WHEN tipo = ? THEN 0 ELSE 1 END, COALESCE(orden, 999999) ASC LIMIT 1`;
    console.log(`[DB] Buscando coincidencia exacta...`);
    let result = await new Promise((resolve, reject) => {
        db.get(sql, [rutaSinQuery, tipo, tipo], (err, result) => {
            if (err) {
                console.error(`[DB] Error en consulta: ${err.message}`);
                reject(err);
            }
            resolve(result);
        });
    });

    if (result) {
        console.log(`[DB] Coincidencia exacta encontrada: ID=${result.id}, ruta=${result.ruta}`);
    }

    // Si no hay resultado, buscar con regex
    if (!result) {
        console.log(`[DB] Sin coincidencia exacta, buscando rutas regex...`);
        // Ordenar rutas regex por prioridad (menor orden = mayor prioridad)
        const regexSql = `SELECT * FROM rutas WHERE isRegex = 1 AND (tipo = ? OR tipo = 'any') AND (activo IS NULL OR activo = 1) ORDER BY COALESCE(orden, 999999) ASC`;
        const regexRoutes = await new Promise((resolve, reject) => {
            db.all(regexSql, [tipo], (err, rows) => {
                if (err) {
                    console.error(`[DB] Error buscando rutas regex: ${err.message}`);
                    reject(err);
                }
                resolve(rows || []);
            });
        });

        console.log(`[DB] Rutas regex encontradas: ${regexRoutes.length}`);

        for (const route of regexRoutes) {
            try {
                const regex = new RegExp(route.ruta);
                console.log(`[DB] Probando regex: ${route.ruta}`);
                // Para rutas regex, usar la URL completa (con query params) para el match
                if (regex.test(ruta)) {
                    console.log(`[DB] Match con regex: ${route.ruta} (URL completa: ${ruta})`);
                    result = route;
                    break;
                }
            } catch (e) {
                console.error(`[DB] Regex inválido: ${route.ruta} - ${e.message}`);
            }
        }
    }

    if (result) {
        console.log(`[DB] Resultado final: ID=${result.id}, tiporespuesta=${result.tiporespuesta}, codigo=${result.codigo}`);
    } else {
        console.log(`[DB] No se encontró ninguna ruta configurada`);
    }

    return result;
}

async function getProxys() {
    console.log(`[DB] Obteniendo configuraciones de proxy...`);
    let sql = `SELECT * FROM rutas WHERE tiporespuesta = 'proxy' AND (activo IS NULL OR activo = 1)`;
    const proxies = await new Promise((resolve, reject) => {
        _db.all(sql, [], (err, result) => {
            if (err) {
                console.error(`[DB] Error obteniendo proxys: ${err.message}`);
                reject(err);
            }
            resolve(result || []);
        });
    });

    // Load fallbacks for each proxy
    for (const proxy of proxies) {
        proxy.fallbacks = await getProxyFallbacks(proxy.id);
    }

    console.log(`[DB] Proxys encontrados: ${proxies.length}`);
    return proxies;
}

async function createTables(newdb) {
    console.log('[DB] Creando/verificando tablas...');

    // Crear tabla con promesa para asegurar que termine antes de continuar
    await new Promise((resolve, reject) => {
        newdb.exec(`
        CREATE TABLE IF NOT EXISTS rutas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT NOT NULL,
            ruta TEXT NOT NULL,
            codigo TEXT NOT NULL,
            tiporespuesta TEXT NOT NULL,
            respuesta TEXT,
            data TEXT,
            esperaActiva INTEGER,
            isRegex INTEGER DEFAULT 0,
            customHeaders TEXT,
            activo INTEGER DEFAULT 1
        );`, (err) => {
            if (err) {
                console.error('[DB] Error creando tabla:', err.message);
                reject(err);
            } else {
                console.log('[DB] Tabla rutas verificada');
                resolve();
            }
        });
    });

    // Añadir columnas si no existen (para BD existentes)
    const addColumn = (db, column, definition) => {
        return new Promise((resolve) => {
            db.run(`ALTER TABLE rutas ADD COLUMN ${column} ${definition}`, (err) => {
                if (err && err.message.includes('duplicate column')) {
                    console.log(`[DB] Columna ${column}: ya existe`);
                } else if (!err) {
                    console.log(`[DB] Columna ${column}: añadida`);
                }
                resolve();
            });
        });
    };

    await addColumn(newdb, 'isRegex', 'INTEGER DEFAULT 0');
    await addColumn(newdb, 'customHeaders', 'TEXT');
    await addColumn(newdb, 'activo', 'INTEGER DEFAULT 1');
    await addColumn(newdb, 'orden', 'INTEGER DEFAULT 0');
    await addColumn(newdb, 'fileName', 'TEXT');
    await addColumn(newdb, 'filePath', 'TEXT');
    await addColumn(newdb, 'fileMimeType', 'TEXT');
    await addColumn(newdb, 'tags', 'TEXT');
    await addColumn(newdb, 'operationId', 'TEXT');
    await addColumn(newdb, 'summary', 'TEXT');
    await addColumn(newdb, 'description', 'TEXT');
    await addColumn(newdb, 'requestBodyExample', 'TEXT');
    await addColumn(newdb, 'proxy_timeout', 'INTEGER DEFAULT 30000');
    await addColumn(newdb, 'graphql_schema', 'TEXT');
    await addColumn(newdb, 'graphql_proxy_url', 'TEXT');

    // Crear índices para optimizar búsquedas de rutas
    await new Promise((resolve) => {
        newdb.exec(`
            CREATE INDEX IF NOT EXISTS idx_rutas_ruta_tipo ON rutas(ruta, tipo);
            CREATE INDEX IF NOT EXISTS idx_rutas_tiporespuesta_activo ON rutas(tiporespuesta, activo);
            CREATE INDEX IF NOT EXISTS idx_rutas_orden ON rutas(orden);
        `, (err) => {
            if (!err) console.log('[DB] Indices verificados');
            resolve();
        });
    });

    // Crear tabla de tags registry
    await new Promise((resolve) => {
        newdb.exec(`
            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                color TEXT NOT NULL DEFAULT '#6366f1'
            );
            CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
        `, (err) => {
            if (!err) console.log('[DB] Tabla tags verificada');
            resolve();
        });
    });

    // Crear tabla de respuestas condicionales
    await new Promise((resolve) => {
        newdb.exec(`
            CREATE TABLE IF NOT EXISTS conditional_responses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                route_id INTEGER NOT NULL,
                orden INTEGER DEFAULT 0,
                nombre TEXT,
                criteria TEXT NOT NULL,
                codigo TEXT,
                tiporespuesta TEXT,
                respuesta TEXT,
                customHeaders TEXT,
                activo INTEGER DEFAULT 1,
                FOREIGN KEY (route_id) REFERENCES rutas(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_conditions_route_orden ON conditional_responses(route_id, orden);
        `, (err) => {
            if (!err) console.log('[DB] Tabla conditional_responses verificada');
            resolve();
        });
    });

    // Crear tabla de proxy fallbacks
    await new Promise((resolve) => {
        newdb.exec(`
            CREATE TABLE IF NOT EXISTS proxy_fallbacks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                route_id INTEGER NOT NULL,
                orden INTEGER DEFAULT 0,
                nombre TEXT,
                path_pattern TEXT NOT NULL,
                error_types TEXT NOT NULL,
                codigo TEXT DEFAULT '200',
                tiporespuesta TEXT DEFAULT 'json',
                respuesta TEXT,
                customHeaders TEXT,
                activo INTEGER DEFAULT 1,
                FOREIGN KEY (route_id) REFERENCES rutas(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_fallbacks_route_orden ON proxy_fallbacks(route_id, orden);
        `, (err) => {
            if (!err) console.log('[DB] Tabla proxy_fallbacks verificada');
            resolve();
        });
    });

    // Crear tabla de condiciones para fallbacks
    await new Promise((resolve) => {
        newdb.exec(`
            CREATE TABLE IF NOT EXISTS proxy_fallback_conditions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fallback_id INTEGER NOT NULL,
                orden INTEGER DEFAULT 0,
                nombre TEXT,
                criteria TEXT NOT NULL,
                codigo TEXT,
                tiporespuesta TEXT,
                respuesta TEXT,
                customHeaders TEXT,
                activo INTEGER DEFAULT 1,
                FOREIGN KEY (fallback_id) REFERENCES proxy_fallbacks(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_fallback_conditions_orden ON proxy_fallback_conditions(fallback_id, orden);
        `, (err) => {
            if (!err) console.log('[DB] Tabla proxy_fallback_conditions verificada');
            resolve();
        });
    });

    // Inicializar orden para rutas existentes que no lo tengan
    // Proxies empiezan en 99999999 y decrementan
    // Rutas normales empiezan en 1 y incrementan
    await new Promise((resolve) => {
        // Primero las rutas normales (no proxy)
        newdb.all(`SELECT id FROM rutas WHERE (tiporespuesta != 'proxy' OR tiporespuesta IS NULL) AND (orden IS NULL OR orden = 0) ORDER BY id`, [], (err, rows) => {
            if (!err && rows && rows.length > 0) {
                let order = 1;
                rows.forEach((row) => {
                    newdb.run(`UPDATE rutas SET orden = ? WHERE id = ?`, [order, row.id]);
                    order++;
                });
                console.log(`[DB] Orden inicializado para ${rows.length} rutas normales`);
            }
            resolve();
        });
    });

    await new Promise((resolve) => {
        // Luego los proxies
        newdb.all(`SELECT id FROM rutas WHERE tiporespuesta = 'proxy' AND (orden IS NULL OR orden = 0 OR orden < 99000000) ORDER BY id DESC`, [], (err, rows) => {
            if (!err && rows && rows.length > 0) {
                let order = 99999999;
                rows.forEach((row) => {
                    newdb.run(`UPDATE rutas SET orden = ? WHERE id = ?`, [order, row.id]);
                    order--;
                });
                console.log(`[DB] Orden inicializado para ${rows.length} proxies`);
            }
            resolve();
        });
    });

    // Crear tabla de operaciones GraphQL
    await new Promise((resolve) => {
        newdb.exec(`
            CREATE TABLE IF NOT EXISTS graphql_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                route_id INTEGER NOT NULL,
                orden INTEGER DEFAULT 0,
                operationType TEXT NOT NULL DEFAULT 'query',
                operationName TEXT NOT NULL,
                respuesta TEXT,
                activo INTEGER DEFAULT 1,
                FOREIGN KEY (route_id) REFERENCES rutas(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_graphql_ops_route_orden ON graphql_operations(route_id, orden);
        `, (err) => {
            if (!err) console.log('[DB] Tabla graphql_operations verificada');
            resolve();
        });
    });

    // Añadir columna useProxy a graphql_operations (para BD existentes)
    const addGqlColumn = (db, column, definition) => {
        return new Promise((resolve) => {
            db.run(`ALTER TABLE graphql_operations ADD COLUMN ${column} ${definition}`, (err) => {
                if (err && err.message.includes('duplicate column')) {
                    console.log(`[DB] Columna graphql_operations.${column}: ya existe`);
                } else if (!err) {
                    console.log(`[DB] Columna graphql_operations.${column}: añadida`);
                }
                resolve();
            });
        });
    };
    await addGqlColumn(newdb, 'useProxy', 'INTEGER DEFAULT 0');

    console.log('[DB] Inicialización de tablas completada');
}

// Obtener respuestas condicionales para una ruta (ordenadas)
async function getConditionalResponses(routeId) {
    const sql = `SELECT * FROM conditional_responses
                 WHERE route_id = ? AND (activo = 1 OR activo IS NULL)
                 ORDER BY orden ASC`;
    return new Promise((resolve, reject) => {
        _db.all(sql, [routeId], (err, rows) => {
            if (err) {
                console.error(`[DB] Error obteniendo condiciones: ${err.message}`);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

// Guardar respuestas condicionales (reemplaza todas las existentes)
async function saveConditionalResponses(routeId, conditions) {
    // Eliminar condiciones existentes
    await new Promise((resolve, reject) => {
        _db.run('DELETE FROM conditional_responses WHERE route_id = ?', [routeId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    // Insertar nuevas condiciones
    for (let i = 0; i < conditions.length; i++) {
        const c = conditions[i];
        // Stringify customHeaders if it's an array
        const customHeaders = c.customHeaders ?
            (typeof c.customHeaders === 'string' ? c.customHeaders : JSON.stringify(c.customHeaders)) : null;
        await new Promise((resolve, reject) => {
            _db.run(`INSERT INTO conditional_responses
                     (route_id, orden, nombre, criteria, codigo, tiporespuesta, respuesta, customHeaders, activo)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [routeId, i, c.nombre || null, c.criteria, c.codigo || null, c.tiporespuesta || null,
                 c.respuesta || null, customHeaders, c.activo !== false ? 1 : 0],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                });
        });
    }

    console.log(`[DB] Guardadas ${conditions.length} condiciones para ruta ${routeId}`);
}

// Eliminar condiciones de una ruta (usado al eliminar la ruta)
async function deleteConditionalResponses(routeId) {
    return new Promise((resolve, reject) => {
        _db.run('DELETE FROM conditional_responses WHERE route_id = ?', [routeId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// ===== TAGS FUNCTIONS =====

// Get all tags from registry
async function getAllTags() {
    const sql = `SELECT * FROM tags ORDER BY name ASC`;
    return new Promise((resolve, reject) => {
        _db.all(sql, [], (err, rows) => {
            if (err) {
                console.error(`[DB] Error obteniendo tags: ${err.message}`);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

// Create or get existing tag
async function getOrCreateTag(name, color) {
    const normalizedName = name.trim();
    // Try to get existing
    const existing = await new Promise((resolve, reject) => {
        _db.get('SELECT * FROM tags WHERE name = ? COLLATE NOCASE', [normalizedName], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });

    if (existing) return existing;

    // Create new
    const crypto = require('crypto');
    const id = crypto.randomUUID();
    await new Promise((resolve, reject) => {
        _db.run('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)', [id, normalizedName, color || '#6366f1'], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    console.log(`[DB] Tag creado: ${normalizedName} (${color})`);
    return { id, name: normalizedName, color: color || '#6366f1' };
}

// Update tag color
async function updateTagColor(id, color) {
    return new Promise((resolve, reject) => {
        _db.run('UPDATE tags SET color = ? WHERE id = ?', [color, id], (err) => {
            if (err) reject(err);
            else {
                console.log(`[DB] Tag ${id} color actualizado a ${color}`);
                resolve();
            }
        });
    });
}

// Delete tag from registry and remove from all routes
async function deleteTag(id) {
    return new Promise((resolve, reject) => {
        // First, get all routes that have tags
        _db.all('SELECT id, tags FROM rutas WHERE tags IS NOT NULL AND tags != ""', [], (err, rows) => {
            if (err) {
                reject(err);
                return;
            }

            // Update routes that contain this tag
            const updatePromises = rows.map(row => {
                return new Promise((resolveUpdate, rejectUpdate) => {
                    try {
                        const tags = JSON.parse(row.tags || '[]');
                        const filteredTags = tags.filter(tag => tag.id !== id);

                        // Only update if the tag was actually removed
                        if (filteredTags.length !== tags.length) {
                            const newTagsJson = JSON.stringify(filteredTags);
                            _db.run('UPDATE rutas SET tags = ? WHERE id = ?', [newTagsJson, row.id], (updateErr) => {
                                if (updateErr) rejectUpdate(updateErr);
                                else {
                                    console.log(`[DB] Tag ${id} eliminado de ruta ${row.id}`);
                                    resolveUpdate();
                                }
                            });
                        } else {
                            resolveUpdate();
                        }
                    } catch (parseErr) {
                        // Skip rows with invalid JSON
                        resolveUpdate();
                    }
                });
            });

            // After updating all routes, delete the tag from the registry
            Promise.all(updatePromises)
                .then(() => {
                    _db.run('DELETE FROM tags WHERE id = ?', [id], (deleteErr) => {
                        if (deleteErr) reject(deleteErr);
                        else {
                            console.log(`[DB] Tag ${id} eliminado del registro`);
                            resolve();
                        }
                    });
                })
                .catch(reject);
        });
    });
}

// ===== PROXY FALLBACKS FUNCTIONS =====

// Get active proxy fallbacks for a route (ordered)
async function getProxyFallbacks(routeId) {
    const sql = `SELECT * FROM proxy_fallbacks
                 WHERE route_id = ? AND (activo = 1 OR activo IS NULL)
                 ORDER BY orden ASC`;
    return new Promise((resolve, reject) => {
        _db.all(sql, [routeId], (err, rows) => {
            if (err) {
                console.error(`[DB] Error obteniendo fallbacks: ${err.message}`);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

// Get all proxy fallbacks for a route (including inactive, for edit form)
async function getAllProxyFallbacks(routeId) {
    const sql = `SELECT * FROM proxy_fallbacks WHERE route_id = ? ORDER BY orden ASC`;
    return new Promise((resolve, reject) => {
        _db.all(sql, [routeId], (err, rows) => {
            if (err) {
                console.error(`[DB] Error obteniendo fallbacks: ${err.message}`);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

// Save proxy fallbacks (replaces all existing)
async function saveProxyFallbacks(routeId, fallbacks) {
    // Delete existing fallbacks
    await new Promise((resolve, reject) => {
        _db.run('DELETE FROM proxy_fallbacks WHERE route_id = ?', [routeId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    // Insert new fallbacks
    for (let i = 0; i < fallbacks.length; i++) {
        const f = fallbacks[i];
        // Stringify customHeaders if it's an array
        const customHeaders = f.customHeaders ?
            (typeof f.customHeaders === 'string' ? f.customHeaders : JSON.stringify(f.customHeaders)) : null;
        await new Promise((resolve, reject) => {
            _db.run(`INSERT INTO proxy_fallbacks
                     (route_id, orden, nombre, path_pattern, error_types, codigo, tiporespuesta, respuesta, customHeaders, activo)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [routeId, i, f.nombre || null, f.path_pattern,
                 typeof f.error_types === 'string' ? f.error_types : JSON.stringify(f.error_types),
                 f.codigo || '200', f.tiporespuesta || 'json',
                 f.respuesta || null, customHeaders, f.activo !== false ? 1 : 0],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                });
        });
    }

    console.log(`[DB] Guardados ${fallbacks.length} fallbacks para ruta ${routeId}`);
}

// Delete fallbacks for a route
async function deleteProxyFallbacks(routeId) {
    return new Promise((resolve, reject) => {
        _db.run('DELETE FROM proxy_fallbacks WHERE route_id = ?', [routeId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// ===== PROXY FALLBACK CONDITIONS =====

// Get active conditions for a fallback
async function getFallbackConditions(fallbackId) {
    const sql = `SELECT * FROM proxy_fallback_conditions
                 WHERE fallback_id = ? AND (activo = 1 OR activo IS NULL)
                 ORDER BY orden ASC`;
    return new Promise((resolve, reject) => {
        _db.all(sql, [fallbackId], (err, rows) => {
            if (err) {
                console.error(`[DB] Error obteniendo condiciones de fallback: ${err.message}`);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

// Get all conditions for a fallback (including inactive, for edit form)
async function getAllFallbackConditions(fallbackId) {
    const sql = `SELECT * FROM proxy_fallback_conditions WHERE fallback_id = ? ORDER BY orden ASC`;
    return new Promise((resolve, reject) => {
        _db.all(sql, [fallbackId], (err, rows) => {
            if (err) {
                console.error(`[DB] Error obteniendo condiciones de fallback: ${err.message}`);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

// Save fallback conditions (replaces all existing)
async function saveFallbackConditions(fallbackId, conditions) {
    // Delete existing conditions
    await new Promise((resolve, reject) => {
        _db.run('DELETE FROM proxy_fallback_conditions WHERE fallback_id = ?', [fallbackId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    // Insert new conditions
    for (let i = 0; i < conditions.length; i++) {
        const c = conditions[i];
        // Stringify customHeaders if it's an array
        const customHeaders = c.customHeaders ?
            (typeof c.customHeaders === 'string' ? c.customHeaders : JSON.stringify(c.customHeaders)) : null;
        await new Promise((resolve, reject) => {
            _db.run(`INSERT INTO proxy_fallback_conditions
                     (fallback_id, orden, nombre, criteria, codigo, tiporespuesta, respuesta, customHeaders, activo)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [fallbackId, i, c.nombre || null, c.criteria,
                 c.codigo || null, c.tiporespuesta || null,
                 c.respuesta || null, customHeaders, c.activo !== false ? 1 : 0],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                });
        });
    }

    console.log(`[DB] Guardadas ${conditions.length} condiciones para fallback ${fallbackId}`);
}

// Delete conditions for a fallback
async function deleteFallbackConditions(fallbackId) {
    return new Promise((resolve, reject) => {
        _db.run('DELETE FROM proxy_fallback_conditions WHERE fallback_id = ?', [fallbackId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// ===== GRAPHQL OPERATIONS FUNCTIONS =====

// Obtener operaciones GraphQL activas para una ruta (ordenadas)
async function getGraphQLOperations(routeId) {
    const sql = `SELECT * FROM graphql_operations
                 WHERE route_id = ? AND (activo = 1 OR activo IS NULL)
                 ORDER BY orden ASC`;
    return new Promise((resolve, reject) => {
        _db.all(sql, [routeId], (err, rows) => {
            if (err) {
                console.error(`[DB] Error obteniendo operaciones GraphQL: ${err.message}`);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

// Obtener todas las operaciones GraphQL (incluidas inactivas, para edición)
async function getAllGraphQLOperations(routeId) {
    const sql = `SELECT * FROM graphql_operations
                 WHERE route_id = ?
                 ORDER BY orden ASC`;
    return new Promise((resolve, reject) => {
        _db.all(sql, [routeId], (err, rows) => {
            if (err) {
                console.error(`[DB] Error obteniendo todas las operaciones GraphQL: ${err.message}`);
                reject(err);
            } else {
                resolve(rows || []);
            }
        });
    });
}

// Guardar operaciones GraphQL (reemplaza todas las existentes)
async function saveGraphQLOperations(routeId, operations) {
    // Eliminar existentes
    await new Promise((resolve, reject) => {
        _db.run('DELETE FROM graphql_operations WHERE route_id = ?', [routeId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    // Insertar nuevas
    for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        await new Promise((resolve, reject) => {
            _db.run(`INSERT INTO graphql_operations
                     (route_id, orden, operationType, operationName, respuesta, activo, useProxy)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [routeId, i, op.operationType || 'query', op.operationName,
                 op.respuesta || null, op.activo !== false && op.activo !== 0 ? 1 : 0,
                 op.useProxy ? 1 : 0],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                });
        });
    }

    console.log(`[DB] Guardadas ${operations.length} operaciones GraphQL para ruta ${routeId}`);
}

// Eliminar operaciones GraphQL de una ruta
async function deleteGraphQLOperations(routeId) {
    return new Promise((resolve, reject) => {
        _db.run('DELETE FROM graphql_operations WHERE route_id = ?', [routeId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

exports.initSql = initSql;
exports.getDatabase = getDatabase;
exports.getRuta = getRuta;
exports.getProxys = getProxys;
exports.getConditionalResponses = getConditionalResponses;
exports.saveConditionalResponses = saveConditionalResponses;
exports.deleteConditionalResponses = deleteConditionalResponses;
exports.getAllTags = getAllTags;
exports.getOrCreateTag = getOrCreateTag;
exports.updateTagColor = updateTagColor;
exports.deleteTag = deleteTag;
exports.getProxyFallbacks = getProxyFallbacks;
exports.getAllProxyFallbacks = getAllProxyFallbacks;
exports.saveProxyFallbacks = saveProxyFallbacks;
exports.deleteProxyFallbacks = deleteProxyFallbacks;
exports.getFallbackConditions = getFallbackConditions;
exports.getAllFallbackConditions = getAllFallbackConditions;
exports.saveFallbackConditions = saveFallbackConditions;
exports.deleteFallbackConditions = deleteFallbackConditions;
exports.getGraphQLOperations = getGraphQLOperations;
exports.getAllGraphQLOperations = getAllGraphQLOperations;
exports.saveGraphQLOperations = saveGraphQLOperations;
exports.deleteGraphQLOperations = deleteGraphQLOperations;