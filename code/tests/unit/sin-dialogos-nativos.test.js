// Los diálogos del navegador (alert, confirm, prompt) salen con el aspecto del
// sistema, dicen "localhost:3890 dice" y no se pueden estilar. Se sustituyeron
// todos por Dialog, pero la convención es fácil de saltarse sin querer: escribir
// confirm() funciona, así que nada avisa. Esto avisa.

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const CARPETAS = ['views', 'public/js'];

// Su propio fallback usa los nativos a posta, para cuando no está el marcado
const EXENTOS = [path.join('public', 'js', 'dialog.js')];

// Sin punto ni letra delante, para no cazar Dialog.confirm ni el método del
// propio módulo
const NATIVOS = /(?<![.\w])(alert|confirm|prompt)\s*\(/;

function ficheros(dir) {
    const encontrados = [];
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
        const completa = path.join(dir, entrada.name);
        if (entrada.isDirectory()) encontrados.push(...ficheros(completa));
        else if (/\.(ejs|js)$/.test(entrada.name)) encontrados.push(completa);
    }
    return encontrados;
}

describe('el panel no abre ventanas del navegador', () => {
    test('nadie llama a alert, confirm ni prompt', () => {
        const culpables = [];

        for (const carpeta of CARPETAS) {
            for (const fichero of ficheros(path.join(RAIZ, carpeta))) {
                const relativa = path.relative(RAIZ, fichero);
                if (EXENTOS.includes(relativa)) continue;

                fs.readFileSync(fichero, 'utf8').split('\n').forEach((linea, i) => {
                    if (NATIVOS.test(linea)) culpables.push(`${relativa}:${i + 1}  ${linea.trim()}`);
                });
            }
        }

        expect(culpables).toEqual([]);
    });

    test('y la comprobación de arriba sabe distinguir', () => {
        // Sin esto, un regex mal puesto dejaría la prueba en verde para siempre
        expect(NATIVOS.test("if (!confirm('¿seguro?')) return;")).toBe(true);
        expect(NATIVOS.test('const n = prompt("nombre");')).toBe(true);
        expect(NATIVOS.test('alert(mensaje)')).toBe(true);
        // Un punto delante lo salva, que es lo que hace pasar a Dialog.confirm
        // y a window.confirm del propio fallback
        expect(NATIVOS.test('await Dialog.confirm(mensaje)')).toBe(false);
        expect(NATIVOS.test('return Promise.resolve(window.confirm(m));')).toBe(false);

        // Lo que sí marca de más: definir un método llamado confirm. Es la
        // razón de que dialog.js vaya exento, y no un descuido
        expect(NATIVOS.test('  confirm(mensaje, opciones = {}) {')).toBe(true);
    });
});
