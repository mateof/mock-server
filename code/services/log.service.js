/**
 * Log Service
 *
 * Persiste en SQLite todo lo que pasa por la consola del panel, para poder
 * consultarlo después desde la pantalla de logs o por MCP.
 *
 * Dos decisiones que condicionan el diseño:
 *
 * 1. **Escritura en lotes.** Un mock server puede recibir ráfagas de cientos de
 *    peticiones; insertar una fila por petición dentro del camino de respuesta
 *    metería la latencia de SQLite en cada llamada. Se encola en memoria y se
 *    vuelca cada poco, o cuando el lote se llena.
 * 2. **Retención acotada.** Una tabla de logs que crece sin límite acaba
 *    comiéndose el disco del volumen. Se poda a un máximo de filas.
 */

const sqliteService = require('./sqlite.service');

const HABILITADO = process.env.MOCK_SERVER_LOG_ENABLED !== 'false';
const MAX_FILAS = parseInt(process.env.MOCK_SERVER_LOG_MAX_ROWS) || 50000;
const INTERVALO_VOLCADO_MS = 500;
const TAMANO_LOTE = 50;

// Cuánto se guarda de un cuerpo: lo suficiente para depurar sin inflar la BD
const MAX_DETALLE = 20 * 1024;

let cola = [];
let temporizador = null;
let volcados = 0;
let descartados = 0;

/**
 * Encola una entrada. No espera a la BD a propósito: quien registra está
 * normalmente en mitad de atender una petición.
 */
function record(entrada) {
    if (!HABILITADO) return;

    const ahora = new Date();
    cola.push({
        ts: ahora.toISOString(),
        ts_ms: ahora.getTime(),
        type: entrada.type || 'info',
        level: entrada.level || 'info',
        method: entrada.method || null,
        url: entrada.url || null,
        status: entrada.status === undefined || entrada.status === null ? null : Number(entrada.status),
        duration: entrada.duration === undefined || entrada.duration === null ? null : Number(entrada.duration),
        route_id: entrada.routeId || null,
        target: entrada.target || null,
        message: entrada.message || null,
        details: entrada.details ? recortar(entrada.details) : null
    });

    if (cola.length >= TAMANO_LOTE) {
        flush();
    } else if (!temporizador) {
        temporizador = setTimeout(flush, INTERVALO_VOLCADO_MS);
        // No debe impedir que el proceso termine
        if (temporizador.unref) temporizador.unref();
    }
}

function recortar(details) {
    try {
        const texto = typeof details === 'string' ? details : JSON.stringify(details);
        return texto.length > MAX_DETALLE
            ? texto.substring(0, MAX_DETALLE) + '\n…(recortado)'
            : texto;
    } catch (e) {
        return null;
    }
}

/**
 * Vuelca la cola. Si la BD todavía no está lista (arranque), se espera al
 * siguiente ciclo en vez de perder las entradas.
 */
function flush() {
    if (temporizador) {
        clearTimeout(temporizador);
        temporizador = null;
    }
    if (cola.length === 0) return;

    const db = sqliteService.getDatabase();
    if (!db) {
        temporizador = setTimeout(flush, INTERVALO_VOLCADO_MS);
        if (temporizador.unref) temporizador.unref();
        return;
    }

    const lote = cola;
    cola = [];

    const sql = `INSERT INTO logs (ts, ts_ms, type, level, method, url, status, duration, route_id, target, message, details)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        const stmt = db.prepare(sql);
        for (const e of lote) {
            stmt.run([e.ts, e.ts_ms, e.type, e.level, e.method, e.url, e.status,
                      e.duration, e.route_id, e.target, e.message, e.details]);
        }
        stmt.finalize();
        db.run('COMMIT', (err) => {
            if (err) {
                console.error(`[LOG] Error guardando ${lote.length} entradas: ${err.message}`);
                return;
            }
            volcados += lote.length;
            // La poda no hace falta en cada volcado: basta con vigilarla
            if (volcados % 500 < lote.length) {
                podar();
            }
        });
    });
}

/**
 * Deja como mucho MAX_FILAS, borrando siempre las más antiguas
 */
function podar() {
    const db = sqliteService.getDatabase();
    if (!db) return;

    db.get('SELECT COUNT(*) as total FROM logs', [], (err, row) => {
        if (err || !row || row.total <= MAX_FILAS) return;

        const sobran = row.total - MAX_FILAS;
        db.run('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)', [sobran], (delErr) => {
            if (!delErr) {
                descartados += sobran;
                console.log(`[LOG] Podadas ${sobran} entradas antiguas (máximo ${MAX_FILAS})`);
            }
        });
    });
}

// ===== CONSULTA =====

function dbAll(sql, params) {
    return new Promise((resolve, reject) => {
        sqliteService.getDatabase().all(sql, params, (err, rows) => {
            if (err) reject(err); else resolve(rows || []);
        });
    });
}

function dbGet(sql, params) {
    return new Promise((resolve, reject) => {
        sqliteService.getDatabase().get(sql, params, (err, row) => {
            if (err) reject(err); else resolve(row);
        });
    });
}

/**
 * Traduce los filtros a WHERE. Se comparte entre la consulta y las
 * estadísticas para que el histograma no pueda contar cosas distintas de las
 * que enseña la tabla.
 */
function construirWhere(filtros = {}) {
    const where = [];
    const params = [];

    if (filtros.from) {
        where.push('ts_ms >= ?');
        params.push(Number(filtros.from));
    }
    if (filtros.to) {
        where.push('ts_ms <= ?');
        params.push(Number(filtros.to));
    }
    if (filtros.type) {
        const tipos = Array.isArray(filtros.type) ? filtros.type : [filtros.type];
        where.push(`type IN (${tipos.map(() => '?').join(',')})`);
        params.push(...tipos);
    }
    if (filtros.level) {
        const niveles = Array.isArray(filtros.level) ? filtros.level : [filtros.level];
        where.push(`level IN (${niveles.map(() => '?').join(',')})`);
        params.push(...niveles);
    }
    if (filtros.method) {
        where.push('UPPER(method) = ?');
        params.push(String(filtros.method).toUpperCase());
    }
    if (filtros.status) {
        // Admite un código exacto (404) o una familia (4xx)
        const s = String(filtros.status).toLowerCase();
        if (/^[1-5]xx$/.test(s)) {
            const base = parseInt(s[0]) * 100;
            where.push('status >= ? AND status < ?');
            params.push(base, base + 100);
        } else {
            where.push('status = ?');
            params.push(parseInt(s));
        }
    }
    if (filtros.url) {
        where.push('url LIKE ?');
        params.push(`%${filtros.url}%`);
    }
    if (filtros.search) {
        where.push('(message LIKE ? OR url LIKE ? OR details LIKE ?)');
        const like = `%${filtros.search}%`;
        params.push(like, like, like);
    }
    if (filtros.routeId) {
        where.push('route_id = ?');
        params.push(Number(filtros.routeId));
    }
    if (filtros.minDuration) {
        where.push('duration >= ?');
        params.push(Number(filtros.minDuration));
    }

    return { clausula: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

async function query(filtros = {}) {
    const { clausula, params } = construirWhere(filtros);
    const limit = Math.min(parseInt(filtros.limit) || 100, 1000);
    const offset = parseInt(filtros.offset) || 0;

    const total = await dbGet(`SELECT COUNT(*) as total FROM logs ${clausula}`, params);
    const filas = await dbAll(
        `SELECT * FROM logs ${clausula} ORDER BY ts_ms DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    return {
        total: total ? total.total : 0,
        count: filas.length,
        limit,
        offset,
        entries: filas.map(f => ({
            ...f,
            details: f.details ? seguroParse(f.details) : null
        }))
    };
}

function seguroParse(texto) {
    try { return JSON.parse(texto); } catch (e) { return texto; }
}

/**
 * Resumen para la pantalla: totales por nivel, por tipo, los códigos más
 * frecuentes y un histograma temporal para el gráfico.
 */
async function stats(filtros = {}) {
    const { clausula, params } = construirWhere(filtros);

    // Los códigos llevan una condición extra, así que su WHERE se compone aparte
    const whereCodigos = clausula ? `${clausula} AND status IS NOT NULL` : 'WHERE status IS NOT NULL';

    const [porNivel, porTipo, porCodigo, rango, tiempos] = await Promise.all([
        dbAll(`SELECT level, COUNT(*) as total FROM logs ${clausula} GROUP BY level`, params),
        dbAll(`SELECT type, COUNT(*) as total FROM logs ${clausula} GROUP BY type ORDER BY total DESC`, params),
        dbAll(`SELECT status, COUNT(*) as total FROM logs ${whereCodigos} GROUP BY status ORDER BY total DESC LIMIT 10`, params),
        dbGet(`SELECT MIN(ts_ms) as desde, MAX(ts_ms) as hasta, COUNT(*) as total FROM logs ${clausula}`, params),
        dbGet(`SELECT AVG(duration) as media, MAX(duration) as maximo FROM logs ${clausula}`, params)
    ]);

    // Histograma: 30 barras repartidas por el rango consultado
    let histograma = [];
    if (rango && rango.total > 0 && rango.desde !== null) {
        const BARRAS = 30;
        const ancho = Math.max(1, Math.ceil((rango.hasta - rango.desde + 1) / BARRAS));
        const filas = await dbAll(
            `SELECT ((ts_ms - ?) / ?) as bucket, level, COUNT(*) as total
             FROM logs ${clausula}
             GROUP BY bucket, level`,
            [rango.desde, ancho, ...params]
        );

        histograma = Array.from({ length: BARRAS }, (_, i) => ({
            from: rango.desde + i * ancho,
            to: rango.desde + (i + 1) * ancho,
            info: 0, success: 0, warning: 0, error: 0, total: 0
        }));

        for (const f of filas) {
            const idx = Math.min(BARRAS - 1, Math.floor(f.bucket));
            if (idx >= 0 && histograma[idx]) {
                histograma[idx][f.level] = (histograma[idx][f.level] || 0) + f.total;
                histograma[idx].total += f.total;
            }
        }
    }

    return {
        total: rango ? rango.total : 0,
        range: rango ? { from: rango.desde, to: rango.hasta } : null,
        by_level: Object.fromEntries(porNivel.map(r => [r.level, r.total])),
        by_type: Object.fromEntries(porTipo.map(r => [r.type, r.total])),
        top_status: porCodigo.map(r => ({ status: r.status, total: r.total })),
        duration: tiempos ? { avg: tiempos.media, max: tiempos.maximo } : null,
        histogram: histograma
    };
}

async function clear(filtros = {}) {
    // Sin filtros borra todo; con ellos, solo lo que se está viendo
    const { clausula, params } = construirWhere(filtros);
    return new Promise((resolve, reject) => {
        sqliteService.getDatabase().run(`DELETE FROM logs ${clausula}`, params, function(err) {
            if (err) reject(err);
            else {
                console.log(`[LOG] Eliminadas ${this.changes} entradas`);
                resolve(this.changes);
            }
        });
    });
}

function estado() {
    return {
        enabled: HABILITADO,
        max_rows: MAX_FILAS,
        queued: cola.length,
        written: volcados,
        pruned: descartados
    };
}

module.exports = {
    record,
    flush,
    query,
    stats,
    clear,
    estado,
    MAX_FILAS,
    HABILITADO
};
