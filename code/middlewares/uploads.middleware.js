/**
 * Subida de ficheros
 *
 * Las rutas de tipo `file` responden con un fichero que hay que subir primero.
 * La configuración de multer estaba dentro de routes/api.js, que es la API del
 * panel; la API v1 la necesita igual, y con una copia cada una acabarían
 * guardando en sitios distintos o con límites distintos sin que nadie se entere
 * hasta que un fichero no aparezca.
 *
 * El nombre en disco no es el original a propósito: dos rutas con un
 * `datos.json` cada una se pisarían, y un nombre que viene de fuera es además
 * lo que permite escribir donde no se debe. El original se guarda en la fila,
 * que es lo que se enseña y lo que viaja en el Content-Disposition.
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../services/paths');

const UPLOADS_DIR = path.join(config.DATA_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOADS_DIR);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB límite
});

/**
 * Lo que subió multer, en la forma que espera routes.service
 */
function desdeMulter(file) {
    if (!file) return null;
    return { fileName: file.originalname, filePath: file.filename, fileMimeType: file.mimetype };
}

/**
 * Borra un fichero que se subió para una operación que acabó fallando: si no,
 * se queda en disco para siempre y no hay fila que lo reclame
 */
function descartar(file) {
    if (!file || !file.filename) return;
    fs.unlink(path.join(UPLOADS_DIR, file.filename), () => {});
}

module.exports = { upload, UPLOADS_DIR, desdeMulter, descartar };
