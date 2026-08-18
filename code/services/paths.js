/**
 * Paths
 *
 * Dónde vive `data/`: la base de datos, los ficheros subidos y la carpeta de
 * importación automática.
 *
 * Estaba repetido con `path.join(__dirname, '..', 'data')` en seis sitios, lo
 * que hacía imposible arrancar una segunda instancia sin que pisara los datos
 * de la primera. Con una variable de entorno, las pruebas de navegador levantan
 * el servidor contra un directorio suyo y se pueden tirar sin miedo, y quien
 * despliega puede montar el volumen donde quiera sin tocar código.
 *
 * Sin la variable, se comporta exactamente como antes.
 */

const path = require('path');

const DATA_DIR = process.env.MOCK_SERVER_DATA_DIR
    ? path.resolve(process.env.MOCK_SERVER_DATA_DIR)
    : path.join(__dirname, '..', 'data');

module.exports = {
    DATA_DIR,
    UPLOADS_DIR: path.join(DATA_DIR, 'uploads'),
    IMPORT_DIR: path.join(DATA_DIR, 'import')
};
