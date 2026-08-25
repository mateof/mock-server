/**
 * Environment Service
 *
 * Variables de entorno editables desde el panel, sustituidas en lo que la ruta
 * tiene configurado: el destino de un proxy, el cuerpo de la respuesta y las
 * cabeceras. Sirve para tener el mismo juego de rutas apuntando a integración,
 * a preproducción o a un backend local sin editarlas una por una.
 *
 * ## Por qué `${VARIABLE}` y no `{{...}}`
 *
 * El motor de plantillas ya usa `{{...}}`, y viene con una garantía: una ruta
 * sin la casilla de "respuesta dinámica" no se toca jamás. Meter aquí la misma
 * sintaxis obligaba a romper esa garantía o a esconder la configuración detrás
 * de una casilla que habla de otra cosa.
 *
 * Además son mecanismos distintos y conviene que se lean distinto: `{{...}}`
 * son datos de ESTA petición, `${...}` es configuración del despliegue.
 *
 * ## Solo se sustituye lo definido
 *
 * Misma regla que en las plantillas: si la variable no existe en el entorno
 * activo, el texto se queda tal cual en vez de vaciarse. Eso evita destrozar
 * una respuesta que llevara `${...}` por su cuenta, y de paso **es** el aviso
 * que se enseña en el panel: detectar lo indefinido y decidir no sustituirlo
 * son la misma operación.
 */

const crypto = require('crypto');
const sqliteService = require('./sqlite.service');

// `${NOMBRE}`. Se admite letra, número, guion y guion bajo, que es lo que se
// usa por convenio en nombres de variable
const PATRON = /\$\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

/**
 * Copia en memoria del entorno activo.
 *
 * La sustitución corre en el camino de respuesta de cada petición, así que no
 * puede ir a SQLite cada vez. Se refresca cuando algo cambia, que es poco.
 */
let cache = { id: null, name: null, vars: {} };

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        sqliteService.getDatabase().all(sql, params, (err, rows) => {
            if (err) reject(err); else resolve(rows || []);
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        sqliteService.getDatabase().get(sql, params, (err, row) => {
            if (err) reject(err); else resolve(row);
        });
    });
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        sqliteService.getDatabase().run(sql, params, function (err) {
            if (err) reject(err); else resolve(this);
        });
    });
}

// ===== CACHÉ =====

async function recargar() {
    const activo = await dbGet('SELECT * FROM environments WHERE activo = 1');
    if (!activo) {
        cache = { id: null, name: null, vars: {} };
        return cache;
    }

    const filas = await dbAll(
        'SELECT clave, valor FROM environment_vars WHERE environment_id = ?', [activo.id]);

    cache = {
        id: activo.id,
        name: activo.name,
        vars: Object.fromEntries(filas.map(f => [f.clave, f.valor === null ? '' : f.valor]))
    };
    console.log(`[ENV] Entorno activo: ${activo.name} (${filas.length} variables)`);
    return cache;
}

function activo() {
    return cache;
}

// ===== SUSTITUCIÓN =====

/**
 * Nombres de variable que aparecen en un texto, sin repetir
 */
function variablesUsadas(texto) {
    if (!texto || typeof texto !== 'string') return [];
    const encontradas = new Set();
    let m;
    PATRON.lastIndex = 0;
    while ((m = PATRON.exec(texto)) !== null) encontradas.add(m[1]);
    return [...encontradas];
}

/**
 * Sustituye lo que esté definido y deja lo demás intacto.
 *
 * @returns {{ texto: string, indefinidas: string[] }}
 */
function sustituir(texto, vars = cache.vars) {
    if (!texto || typeof texto !== 'string' || texto.indexOf('${') === -1) {
        return { texto, indefinidas: [] };
    }

    const indefinidas = new Set();
    PATRON.lastIndex = 0;
    const salida = texto.replace(PATRON, (completo, nombre) => {
        if (Object.prototype.hasOwnProperty.call(vars, nombre)) return vars[nombre];
        // Sin definir se queda tal cual: ni se destroza el texto ni se pierde
        // la pista de que faltaba algo
        indefinidas.add(nombre);
        return completo;
    });

    return { texto: salida, indefinidas: [...indefinidas] };
}

/**
 * ¿Merece la pena mirar? Evita trabajo en la inmensa mayoría de rutas
 */
function tieneVariables(texto) {
    return typeof texto === 'string' && texto.indexOf('${') !== -1;
}

// ===== ENTORNOS =====

async function listar() {
    const entornos = await dbAll('SELECT * FROM environments ORDER BY name COLLATE NOCASE ASC');
    const salida = [];
    for (const e of entornos) {
        const filas = await dbAll(
            'SELECT clave, valor FROM environment_vars WHERE environment_id = ? ORDER BY clave COLLATE NOCASE ASC',
            [e.id]);
        salida.push({
            id: e.id,
            name: e.name,
            active: e.activo === 1,
            variables: filas.map(f => ({ key: f.clave, value: f.valor === null ? '' : f.valor }))
        });
    }
    return salida;
}

async function crear(nombre, variables = []) {
    const limpio = String(nombre || '').trim();
    if (!limpio) throw new Error('El entorno necesita un nombre');

    const existente = await dbGet('SELECT * FROM environments WHERE name = ? COLLATE NOCASE', [limpio]);
    if (existente) throw new Error(`Ya existe un entorno llamado "${limpio}"`);

    const id = crypto.randomUUID();
    await dbRun('INSERT INTO environments (id, name, activo) VALUES (?, ?, 0)', [id, limpio]);
    if (Array.isArray(variables) && variables.length) await guardarVariables(id, variables);

    console.log(`[ENV] Entorno creado: ${limpio}`);
    return { id, name: limpio };
}

async function eliminar(id) {
    const entorno = await dbGet('SELECT * FROM environments WHERE id = ?', [id]);
    if (!entorno) throw new Error('No existe ese entorno');

    const total = await dbGet('SELECT COUNT(*) as total FROM environments');
    if (total.total <= 1) throw new Error('No se puede borrar el único entorno que queda');

    await dbRun('DELETE FROM environment_vars WHERE environment_id = ?', [id]);
    await dbRun('DELETE FROM environments WHERE id = ?', [id]);

    // Borrar el activo dejaría todo sin resolver: pasa a estarlo otro
    if (entorno.activo === 1) {
        const otro = await dbGet('SELECT id FROM environments ORDER BY name COLLATE NOCASE ASC LIMIT 1');
        if (otro) await dbRun('UPDATE environments SET activo = 1 WHERE id = ?', [otro.id]);
    }

    await recargar();
    console.log(`[ENV] Entorno eliminado: ${entorno.name}`);
    return true;
}

async function activar(id) {
    const entorno = await dbGet('SELECT * FROM environments WHERE id = ?', [id]);
    if (!entorno) throw new Error('No existe ese entorno');

    await dbRun('UPDATE environments SET activo = 0');
    await dbRun('UPDATE environments SET activo = 1 WHERE id = ?', [id]);
    await recargar();
    return { id, name: entorno.name };
}

/**
 * Reemplaza las variables de un entorno. Es un reemplazo entero y no un parche
 * a propósito: es como se borra una variable.
 */
async function guardarVariables(id, variables) {
    const entorno = await dbGet('SELECT * FROM environments WHERE id = ?', [id]);
    if (!entorno) throw new Error('No existe ese entorno');

    await dbRun('DELETE FROM environment_vars WHERE environment_id = ?', [id]);

    for (const v of Array.isArray(variables) ? variables : []) {
        const clave = String(v.key || v.clave || '').trim();
        if (!clave) continue;
        await dbRun(
            'INSERT OR REPLACE INTO environment_vars (environment_id, clave, valor) VALUES (?, ?, ?)',
            [id, clave, v.value === undefined ? (v.valor ?? '') : v.value]);
    }

    if (entorno.activo === 1) await recargar();
    return true;
}

/**
 * Fija una sola variable del entorno activo. Es lo que usan los scripts.
 */
async function fijar(clave, valor) {
    if (!cache.id) throw new Error('No hay ningún entorno activo');
    const limpia = String(clave || '').trim();
    if (!limpia) throw new Error('La variable necesita un nombre');

    await dbRun(
        'INSERT OR REPLACE INTO environment_vars (environment_id, clave, valor) VALUES (?, ?, ?)',
        [cache.id, limpia, valor === undefined || valor === null ? '' : String(valor)]);

    // La caché se actualiza en el sitio: recargar entera por una variable sería
    // una consulta de más en mitad de una petición
    cache.vars[limpia] = valor === undefined || valor === null ? '' : String(valor);
    return true;
}

module.exports = {
    recargar,
    activo,
    sustituir,
    variablesUsadas,
    tieneVariables,
    listar,
    crear,
    eliminar,
    activar,
    guardarVariables,
    fijar,
    PATRON
};
