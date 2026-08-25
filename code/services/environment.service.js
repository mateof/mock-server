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
 * Escapa un valor para poder meterlo dentro de código sin romperlo.
 *
 * Sustituir en un cuerpo y sustituir en una expresión no son lo mismo: un valor
 * con una comilla dentro de `headers.x === '${CLAVE}'` convierte un criterio
 * válido en un error de sintaxis, y el fallo aparece al llegar la petición, no
 * al guardar.
 *
 * Solo toca lo que haría daño, así que un valor normal (`8080`, `abc123`) sale
 * igual y sigue funcionando también fuera de comillas.
 */
function escaparParaCodigo(valor) {
    return String(valor)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
}

/**
 * Sustituye lo que esté definido y deja lo demás intacto.
 *
 * @param {object} opciones  paraCodigo: escapa el valor para que quepa dentro
 *                           de una expresión o un script sin romperlo
 * @returns {{ texto: string, indefinidas: string[] }}
 */
function sustituir(texto, vars = cache.vars, opciones = {}) {
    if (!texto || typeof texto !== 'string' || texto.indexOf('${') === -1) {
        return { texto, indefinidas: [] };
    }

    const indefinidas = new Set();
    PATRON.lastIndex = 0;
    const salida = texto.replace(PATRON, (completo, nombre) => {
        if (Object.prototype.hasOwnProperty.call(vars, nombre)) {
            return opciones.paraCodigo ? escaparParaCodigo(vars[nombre]) : vars[nombre];
        }
        // Sin definir se queda tal cual: ni se destroza el texto ni se pierde
        // la pista de que faltaba algo
        indefinidas.add(nombre);
        return completo;
    });

    return { texto: salida, indefinidas: [...indefinidas] };
}

/**
 * Atajo para los dos sitios donde se sustituye dentro de código: los criterios
 * de las condiciones y los scripts.
 */
function sustituirEnCodigo(texto) {
    return sustituir(texto, cache.vars, { paraCodigo: true });
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
 * Encuentra un entorno por id o por nombre.
 *
 * Por nombre además del id porque es lo que ve quien llama desde fuera: un
 * asistente lee "pre" en la lista y pedirle que traduzca a uuid es un paso de
 * más que solo sirve para equivocarse.
 */
async function buscar(idONombre) {
    if (!idONombre) return null;
    const porId = await dbGet('SELECT * FROM environments WHERE id = ?', [idONombre]);
    if (porId) return porId;
    return dbGet('SELECT * FROM environments WHERE name = ? COLLATE NOCASE', [String(idONombre)]);
}

/**
 * Fija UNA variable sin tocar las demás.
 *
 * Aparte de guardarVariables a propósito: esa reemplaza el conjunto entero, así
 * que añadir una obliga a leer y reenviar todas, y cualquier olvido las borra.
 * Con esto, añadir una variable no puede llevarse por delante el resto.
 */
async function fijarVariable(idONombre, clave, valor) {
    const entorno = idONombre ? await buscar(idONombre) : await dbGet('SELECT * FROM environments WHERE activo = 1');
    if (!entorno) throw new Error(idONombre ? `No existe el entorno "${idONombre}"` : 'No hay ningún entorno activo');

    const limpia = String(clave || '').trim();
    if (!limpia) throw new Error('La variable necesita un nombre');

    await dbRun(
        'INSERT OR REPLACE INTO environment_vars (environment_id, clave, valor) VALUES (?, ?, ?)',
        [entorno.id, limpia, valor === undefined || valor === null ? '' : String(valor)]);

    if (entorno.activo === 1) await recargar();
    console.log(`[ENV] ${entorno.name}: ${limpia} fijada`);
    return { environment: entorno.name, key: limpia };
}

/**
 * Borra UNA variable, dejando el resto en su sitio
 */
async function borrarVariable(idONombre, clave) {
    const entorno = idONombre ? await buscar(idONombre) : await dbGet('SELECT * FROM environments WHERE activo = 1');
    if (!entorno) throw new Error(idONombre ? `No existe el entorno "${idONombre}"` : 'No hay ningún entorno activo');

    const resultado = await dbRun(
        'DELETE FROM environment_vars WHERE environment_id = ? AND clave = ?', [entorno.id, String(clave)]);

    if (entorno.activo === 1) await recargar();
    return { environment: entorno.name, key: clave, deleted: resultado.changes > 0 };
}

/**
 * Cambia el nombre de un entorno, conservando sus variables y si estaba activo
 */
async function renombrar(idONombre, nuevoNombre) {
    const entorno = await buscar(idONombre);
    if (!entorno) throw new Error(`No existe el entorno "${idONombre}"`);

    const limpio = String(nuevoNombre || '').trim();
    if (!limpio) throw new Error('El entorno necesita un nombre');

    const choca = await dbGet('SELECT id FROM environments WHERE name = ? COLLATE NOCASE AND id != ?',
        [limpio, entorno.id]);
    if (choca) throw new Error(`Ya existe un entorno llamado "${limpio}"`);

    await dbRun('UPDATE environments SET name = ? WHERE id = ?', [limpio, entorno.id]);
    if (entorno.activo === 1) await recargar();

    console.log(`[ENV] Entorno renombrado: ${entorno.name} -> ${limpio}`);
    return { id: entorno.id, name: limpio, previous: entorno.name };
}

/**
 * Añade o cambia varias variables de golpe, sin borrar las que no vengan.
 * Es el complemento de guardarVariables, que sí reemplaza.
 */
async function mezclarVariables(idONombre, variables) {
    const entorno = await buscar(idONombre);
    if (!entorno) throw new Error(`No existe el entorno "${idONombre}"`);

    for (const v of Array.isArray(variables) ? variables : []) {
        const clave = String(v.key || v.clave || '').trim();
        if (!clave) continue;
        await dbRun(
            'INSERT OR REPLACE INTO environment_vars (environment_id, clave, valor) VALUES (?, ?, ?)',
            [entorno.id, clave, v.value === undefined ? (v.valor ?? '') : v.value]);
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

/**
 * Dónde puede una ruta llevar variables, y qué le falta al entorno activo.
 *
 * Vivía duplicado en la API y en el servidor MCP, que es como se consigue que
 * uno de los dos se quede sin mirar un campo nuevo. Los criterios cuelgan de
 * otras tablas, así que hay que ir a buscarlos.
 */
async function analizarUso() {
    // Tarde para no cerrar un ciclo de carga: routes.service tira de este módulo
    const routesService = require('./routes.service');

    const rutas = await routesService.listRoutes({});
    const definidas = new Set(Object.keys(cache.vars || {}));

    const porRuta = [];
    const faltan = new Set();

    for (const r of rutas) {
        const usadas = new Set();
        const anotar = (texto) => variablesUsadas(texto).forEach(v => usadas.add(v));

        // Lo que se guarda en la propia fila
        [r.respuesta, r.customHeaders, r.proxy_request_headers, r.proxy_request_params,
         r.mock_script, r.proxy_pre_script, r.proxy_post_script].forEach(anotar);

        // Y lo que cuelga de ella
        try {
            const condiciones = await sqliteService.getConditionalResponses(r.id);
            condiciones.forEach(c => { anotar(c.criteria); anotar(c.respuesta); anotar(c.customHeaders); });
        } catch (e) { /* una ruta sin condiciones no es un problema */ }

        if (r.tiporespuesta === 'proxy') {
            try {
                const fallbacks = await sqliteService.getAllProxyFallbacks(r.id);
                for (const f of fallbacks) {
                    anotar(f.respuesta);
                    const suyas = await sqliteService.getAllFallbackConditions(f.id);
                    suyas.forEach(c => { anotar(c.criteria); anotar(c.respuesta); });
                }
            } catch (e) { /* idem */ }
        }

        if (usadas.size === 0) continue;

        const sinDefinir = [...usadas].filter(v => !definidas.has(v));
        porRuta.push({
            id: r.id, method: r.tipo, path: r.ruta,
            uses: [...usadas], undefined_vars: sinDefinir
        });
        sinDefinir.forEach(v => faltan.add(v));
    }

    return {
        environment: cache.name,
        routes: porRuta,
        routes_with_undefined: porRuta.filter(r => r.undefined_vars.length).length,
        undefined_vars: [...faltan]
    };
}

module.exports = {
    analizarUso,
    buscar,
    fijarVariable,
    borrarVariable,
    renombrar,
    mezclarVariables,
    recargar,
    activo,
    sustituir,
    sustituirEnCodigo,
    escaparParaCodigo,
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
