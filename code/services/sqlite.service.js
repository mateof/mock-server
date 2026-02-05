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
    const result = await new Promise((resolve, reject) => {
        _db.all(sql, [], (err, result) => {
        if (err) {
          console.error(`[DB] Error obteniendo proxys: ${err.message}`);
          reject(err);
        }
        resolve(result);
      });
    });
    console.log(`[DB] Proxys encontrados: ${result ? result.length : 0}`);
    return result;
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
        await new Promise((resolve, reject) => {
            _db.run(`INSERT INTO conditional_responses
                     (route_id, orden, nombre, criteria, codigo, tiporespuesta, respuesta, customHeaders, activo)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [routeId, i, c.nombre || null, c.criteria, c.codigo || null, c.tiporespuesta || null,
                 c.respuesta || null, c.customHeaders || null, c.activo !== false ? 1 : 0],
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

exports.initSql = initSql;
exports.getDatabase = getDatabase;
exports.getRuta = getRuta;
exports.getProxys = getProxys;
exports.getConditionalResponses = getConditionalResponses;
exports.saveConditionalResponses = saveConditionalResponses;
exports.deleteConditionalResponses = deleteConditionalResponses;