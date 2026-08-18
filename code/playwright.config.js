const path = require('path');

/**
 * Configuración de las pruebas de navegador.
 *
 * El servidor se levanta contra un directorio de datos propio
 * (MOCK_SERVER_DATA_DIR), así que las pruebas pueden crear y borrar rutas sin
 * tocar la base de datos de desarrollo de nadie. El directorio se limpia en
 * tests/e2e/global-setup.js antes de arrancar.
 */
const PUERTO = process.env.E2E_PORT || 3899;
const DATOS = path.join(__dirname, 'tests', 'e2e', '.data');

module.exports = {
    testDir: './tests/e2e',
    testMatch: '**/*.spec.js',
    globalSetup: require.resolve('./tests/e2e/global-setup.js'),

    // Las pruebas comparten un servidor con estado, así que van en serie: en
    // paralelo se pisarían las rutas unas a otras
    fullyParallel: false,
    workers: 1,

    timeout: 30000,
    expect: { timeout: 7000 },

    // En CI una prueba que falla suele ser un fallo de verdad, pero un
    // reintento distingue eso de una carrera puntual del navegador
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

    use: {
        baseURL: `http://127.0.0.1:${PUERTO}`,
        headless: true,
        // Solo del fallo: guardar todo llena el disco y no se mira
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        actionTimeout: 7000
    },

    projects: [
        { name: 'chromium', use: { browserName: 'chromium' } }
    ],

    webServer: {
        command: 'node app.js',
        url: `http://127.0.0.1:${PUERTO}/`,
        reuseExistingServer: false,
        timeout: 30000,
        env: {
            PORT: String(PUERTO),
            MOCK_SERVER_DATA_DIR: DATOS,
            // Sin esto el log de la propia prueba ensucia lo que la prueba mira
            MOCK_SERVER_LOG_MAX_ROWS: '2000'
        }
    }
};
