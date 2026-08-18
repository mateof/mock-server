const fs = require('fs');
const path = require('path');

/**
 * Deja el directorio de datos vacío antes de arrancar.
 *
 * Cada tirada empieza sin rutas: si se heredara lo de la anterior, una prueba
 * que cuenta filas pasaría o fallaría según lo que dejó la de antes, que es la
 * clase de prueba que se acaba borrando por poco fiable.
 */
module.exports = async () => {
    const datos = path.join(__dirname, '.data');

    if (fs.existsSync(datos)) {
        fs.rmSync(datos, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(datos, 'uploads'), { recursive: true });
    fs.mkdirSync(path.join(datos, 'import'), { recursive: true });

    console.log(`[e2e] datos limpios en ${datos}`);
};
