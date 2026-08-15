const { compararVersiones, versionMasAlta } = require('../../services/version.service');

describe('version.service', () => {

    describe('compararVersiones', () => {
        it('ordena por número, no por texto', () => {
            // El caso que rompe comparar como cadenas: "0.9.0" > "0.15.0"
            expect(compararVersiones('0.15.0', '0.9.0')).toBeGreaterThan(0);
            expect(compararVersiones('0.9.0', '0.15.0')).toBeLessThan(0);
        });

        it('compara mayor, menor y parche en ese orden', () => {
            expect(compararVersiones('1.0.0', '0.99.99')).toBeGreaterThan(0);
            expect(compararVersiones('0.22.0', '0.21.9')).toBeGreaterThan(0);
            expect(compararVersiones('0.22.1', '0.22.0')).toBeGreaterThan(0);
        });

        it('devuelve 0 cuando son iguales', () => {
            expect(compararVersiones('1.2.3', '1.2.3')).toBe(0);
        });

        it('tolera el prefijo v', () => {
            expect(compararVersiones('v1.2.3', '1.2.3')).toBe(0);
            expect(compararVersiones('v2.0.0', '1.9.9')).toBeGreaterThan(0);
        });

        it('no revienta con partes que faltan o no son números', () => {
            expect(compararVersiones('1', '1.0.0')).toBe(0);
            expect(compararVersiones('1.2', '1.2.0')).toBe(0);
            expect(compararVersiones('basura', '0.0.0')).toBe(0);
        });
    });

    describe('versionMasAlta', () => {
        it('elige la mayor de una lista desordenada', () => {
            expect(versionMasAlta(['0.7.0', '0.15.0', '0.9.0', '0.13.1'])).toBe('0.15.0');
        });

        it('ignora las etiquetas que no son una versión', () => {
            // El registro trae también latest, main y las de sha
            expect(versionMasAlta(['latest', 'main', 'sha-abc123', 'main-9f8e7d', '0.21.0']))
                .toBe('0.21.0');
        });

        it('devuelve null si no hay ninguna versión', () => {
            expect(versionMasAlta(['latest', 'main'])).toBeNull();
            expect(versionMasAlta([])).toBeNull();
            expect(versionMasAlta(null)).toBeNull();
        });

        it('acepta el prefijo v', () => {
            expect(versionMasAlta(['v1.0.0', 'v1.2.0', 'latest'])).toBe('v1.2.0');
        });

        it('no confunde una versión con algo que la contiene', () => {
            expect(versionMasAlta(['1.2.3-rc1', 'main-1.2.4', '1.2.0'])).toBe('1.2.0');
        });
    });
});
