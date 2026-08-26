// Una variable CSS que no existe no avisa de nada: la declaración entera queda
// inválida y la propiedad se va a su valor inicial. `border: 1px solid
// var(--border)` con --border sin definir no pinta un borde de otro color,
// pinta border-style: none. Así estuvo el modal de entornos, sin una sola línea
// de separación, y los hover de la barra superior, sin fondo. Nada fallaba.

const fs = require('fs');
const path = require('path');

const CSS = ['app.css', 'terminal.css', 'style.css']
    .map(f => path.join(__dirname, '..', '..', 'public', 'css', f));

// Se recogen de donde estén, no solo de :root: puede haberlas en un componente
const DEFINICION = /(--[a-zA-Z0-9-]+)\s*:/g;
// Solo las que se usan sin respaldo. `var(--x, algo)` aguanta que --x no exista
const USO_SIN_RESPALDO = /var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g;

function leer() {
    const definidas = new Set();
    const usos = [];

    for (const fichero of CSS) {
        const texto = fs.readFileSync(fichero, 'utf8');
        const nombre = path.basename(fichero);

        for (const m of texto.matchAll(DEFINICION)) definidas.add(m[1]);

        texto.split('\n').forEach((linea, i) => {
            for (const m of linea.matchAll(USO_SIN_RESPALDO)) {
                usos.push({ variable: m[1], donde: `${nombre}:${i + 1}`, linea: linea.trim() });
            }
        });
    }
    return { definidas, usos };
}

/**
 * Nombres que ya venían sin definir de antes.
 *
 * No se arreglan aquí a propósito: son todo `background`, hoy no pintan nada, y
 * darles un valor cambiaría el aspecto de media aplicación. Eso es una decisión
 * de diseño, no una corrección, y merece su propio cambio.
 *
 * La lista solo puede encoger: si se define alguno, la segunda prueba avisa de
 * que sobra aquí.
 */
const PENDIENTES = [
    '--surface-primary', '--surface-secondary', '--surface-tertiary',
    '--bg-primary', '--bg-secondary', '--bg-tertiary',
    '--primary-dark', '--accent-primary', '--radius-md'
];

describe('variables CSS', () => {
    test('no se usa ninguna sin definir que no estuviera ya', () => {
        const { definidas, usos } = leer();
        const huerfanas = usos
            .filter(u => !definidas.has(u.variable) && !PENDIENTES.includes(u.variable))
            .map(u => `${u.donde}  ${u.variable}  ->  ${u.linea}`);

        expect(huerfanas).toEqual([]);
    });

    test('la lista de pendientes no se queda con nombres ya resueltos', () => {
        // Sin esto la lista solo crecería, y taparía justo lo que vigila
        const { definidas, usos } = leer();
        const enUso = new Set(usos.map(u => u.variable));
        const sobran = PENDIENTES.filter(v => definidas.has(v) || !enUso.has(v));

        expect(sobran).toEqual([]);
    });

    test('hay algo que comprobar', () => {
        // Si los regex dejaran de casar, la prueba de arriba pasaría vacía y en
        // verde para siempre
        const { definidas, usos } = leer();
        expect(definidas.size).toBeGreaterThan(20);
        expect(usos.length).toBeGreaterThan(50);
        expect(definidas.has('--border-color')).toBe(true);

        // Y que sepa distinguir un respaldo de una variable a pelo
        expect([...'var(--x, 1rem)'.matchAll(USO_SIN_RESPALDO)]).toHaveLength(0);
        expect([...'var(--x)'.matchAll(USO_SIN_RESPALDO)]).toHaveLength(1);
    });
});
