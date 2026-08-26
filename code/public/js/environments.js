/**
 * Entornos y sus variables.
 *
 * Vive en un fichero aparte y no dentro de una vista porque el selector está en
 * la barra superior, que comparten la lista de rutas y la pantalla de log.
 *
 * El entorno activo es estado del servidor, no del navegador: decide contra qué
 * se resuelven las variables de todas las rutas, así que cambiarlo desde una
 * pestaña cambia lo que responde el servidor para todo el mundo. Por eso el
 * selector avisa con un toast en vez de cambiar en silencio.
 */
const EnvModule = {
  entornos: [],
  /** Cuál se está editando en el modal, que no tiene por qué ser el activo. */
  editando: null,
  uso: null,

  async init() {
    await this.cargar();

    // El modal se pinta antes de enseñarse, y un elemento oculto mide cero: el
    // ajuste de alto de los valores no encontraba contenido que medir. Se repite
    // cuando ya está a la vista
    const modal = document.getElementById('environmentsModal');
    if (modal) {
      modal.addEventListener('shown.bs.modal', () => {
        document.querySelectorAll('#envVarsContainer .env-var-value')
          .forEach(campo => this.ajustarAlto(campo));
      });
    }
    // Al pulsar fuera se cierra, como el resto de desplegables del panel
    document.addEventListener('click', (e) => {
      const selector = document.getElementById('envSelector');
      if (selector && !selector.contains(e.target)) this.cerrar();
    });
  },

  async cargar() {
    try {
      const datos = await fetch('/api/environments').then(r => r.json());
      this.entornos = datos.environments || [];
      await this.cargarUso();
      this.pintarSelector();
    } catch (e) {
      console.warn('[env] no se pudieron cargar los entornos:', e.message);
    }
  },

  /** Qué rutas piden variables que el entorno activo no define. */
  async cargarUso() {
    try {
      this.uso = await fetch('/api/environments/usage').then(r => r.json());
    } catch (e) {
      this.uso = null;
    }
  },

  activo() {
    return this.entornos.find(e => e.active) || null;
  },

  pintarSelector() {
    const activo = this.activo();
    const nombre = document.getElementById('envActiveName');
    if (nombre) nombre.textContent = activo ? activo.name : '—';

    // El punto de aviso es lo único que dice, sin abrir nada, que hay rutas
    // pidiendo variables que este entorno no tiene
    const punto = document.getElementById('envWarningDot');
    if (punto) {
      const faltan = this.uso && this.uso.routes_with_undefined > 0;
      punto.style.display = faltan ? '' : 'none';
      if (faltan) {
        punto.title = t('env.undefinedCount')
          .replace('{{routes}}', this.uso.routes_with_undefined)
          .replace('{{vars}}', this.uso.undefined_vars.join(', '));
      }
    }

    const lista = document.getElementById('envMenuList');
    if (!lista) return;
    lista.innerHTML = this.entornos.map(e => `
      <button type="button" class="env-menu-item${e.active ? ' is-active' : ''}"
              onclick="EnvModule.activar('${e.id}')">
        <i class="fa ${e.active ? 'fa-check-circle' : 'fa-circle-o'}"></i>
        <span class="env-menu-name">${this.esc(e.name)}</span>
        <span class="env-menu-count">${e.variables.length}</span>
      </button>`).join('');
  },

  toggle() {
    const menu = document.getElementById('envMenu');
    if (menu) menu.classList.toggle('is-open');
  },

  cerrar() {
    const menu = document.getElementById('envMenu');
    if (menu) menu.classList.remove('is-open');
  },

  async activar(id) {
    const entorno = this.entornos.find(e => e.id === id);
    if (!entorno || entorno.active) return this.cerrar();

    try {
      const r = await fetch(`/api/environments/${id}/activate`, { method: 'POST' });
      const datos = await r.json();
      if (!r.ok || !datos.success) throw new Error(datos.error || t('errors.generic'));

      this.cerrar();
      await this.cargar();
      showToast(t('env.switched').replace('{{name}}', entorno.name), 'success');

      // La tabla de rutas puede estar enseñando avisos que dependen del entorno
      if (typeof tabla !== 'undefined' && tabla.ajax) tabla.ajax.reload(null, false);
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  // ===== MODAL =====

  async openManager() {
    this.cerrar();
    await this.cargar();
    this.editando = (this.activo() || this.entornos[0] || null);
    this.pintarModal();
    $('#environmentsModal').modal('show');
  },

  pintarModal() {
    const lista = document.getElementById('envList');
    if (lista) {
      lista.innerHTML = this.entornos.map(e => `
        <div class="env-list-item${this.editando && e.id === this.editando.id ? ' is-selected' : ''}"
             onclick="EnvModule.seleccionar('${e.id}')">
          <div class="env-list-name">
            ${this.esc(e.name)}
            ${e.active ? `<span class="env-badge-active">${t('env.active')}</span>` : ''}
          </div>
          <div class="env-list-meta">${t('env.variableCount').replace('{{count}}', e.variables.length)}</div>
          <button type="button" class="btn-icon btn-icon-danger btn-icon-xs"
                  onclick="event.stopPropagation(); EnvModule.eliminar('${e.id}')"
                  title="${t('buttons.delete')}"><i class="fa fa-trash"></i></button>
        </div>`).join('');
    }

    const titulo = document.getElementById('envVarsTitle');
    if (titulo) titulo.textContent = this.editando ? this.editando.name : '';

    this.pintarVariables();
    this.pintarUso();
  },

  pintarVariables() {
    const cont = document.getElementById('envVarsContainer');
    const vacio = document.getElementById('envVarsEmpty');
    if (!cont) return;

    const variables = this.editando ? this.editando.variables : [];
    vacio.style.display = variables.length ? 'none' : 'block';

    // Se marcan las que alguna ruta pide y este entorno no define
    const faltan = new Set((this.uso && this.editando && this.editando.active)
      ? this.uso.undefined_vars : []);

    // El valor es un textarea y no un input: un token o un certificado no caben
    // en una linea, y en un input solo se ve el trozo por el que va el cursor.
    // Se puede arrastrar por la esquina, y el boton lo abre de golpe
    cont.innerHTML = variables.map((v, i) => `
      <div class="env-var-row" data-index="${i}">
        <input type="text" class="form-control-modern env-var-key" value="${this.esc(v.key)}"
               placeholder="${t('env.keyPlaceholder')}" oninput="EnvModule.editarVariable(${i}, 'key', this.value)">
        <div class="env-var-value-wrap">
          <textarea class="form-control-modern env-var-value" rows="1" spellcheck="false"
                    placeholder="${t('env.valuePlaceholder')}"
                    oninput="EnvModule.editarValor(${i}, this)">${this.esc(v.value)}</textarea>
          <button type="button" class="env-var-expand" onclick="EnvModule.alternarAlto(${i}, this)"
                  title="${t('env.expandValue')}"><i class="fa fa-expand"></i></button>
        </div>
        <button type="button" class="btn-icon btn-icon-danger" onclick="EnvModule.quitarVariable(${i})"
                title="${t('buttons.delete')}"><i class="fa fa-trash"></i></button>
      </div>`).join('');

    cont.querySelectorAll('.env-var-value').forEach(campo => this.ajustarAlto(campo));

    const pista = document.getElementById('envVarsHint');
    if (pista) {
      pista.innerHTML = faltan.size
        ? `<i class="fa fa-exclamation-triangle"></i> ${t('env.missingHere').replace('{{vars}}', [...faltan].join(', '))}`
        : '';
    }
  },

  pintarUso() {
    const caja = document.getElementById('envUsage');
    if (!caja) return;

    const conFallo = (this.uso && this.uso.routes)
      ? this.uso.routes.filter(r => r.undefined_vars.length) : [];

    if (!conFallo.length || !this.editando || !this.editando.active) {
      caja.style.display = 'none';
      return;
    }

    caja.style.display = '';
    document.getElementById('envUsageTitle').textContent =
      t('env.usageTitle').replace('{{count}}', conFallo.length).replace('{{name}}', this.uso.environment);
    document.getElementById('envUsageList').innerHTML = conFallo.map(r => `
      <div class="env-usage-row">
        <span class="badge-method">${(r.method || '').toUpperCase()}</span>
        <code>${this.esc(r.path)}</code>
        <span class="env-usage-vars">${r.undefined_vars.map(v => `\${${this.esc(v)}}`).join(' ')}</span>
      </div>`).join('');
  },

  seleccionar(id) {
    this.editando = this.entornos.find(e => e.id === id) || null;
    this.pintarModal();
  },

  /** Cuatro líneas. Más que eso ya es material para el botón de ampliar. */
  ALTO_MAXIMO: 96,

  /**
   * Da al campo el alto de lo que lleva dentro, hasta el tope.
   *
   * Un textarea de un renglón con un token de trescientos caracteres enseña la
   * primera línea y media de la segunda, cortada: se ve que hay más pero no se
   * lee nada. Con tres líneas de contenido se ven las tres.
   */
  ajustarAlto(campo) {
    if (!campo || campo.dataset.manual === '1') return;
    campo.style.height = 'auto';
    campo.style.height = Math.min(campo.scrollHeight, this.ALTO_MAXIMO) + 'px';
  },

  editarValor(indice, campo) {
    this.editarVariable(indice, 'value', campo.value);
    // Pegar un valor largo es el caso normal, y ahí es donde se agradece
    this.ajustarAlto(campo);
  },

  editarVariable(indice, campo, valor) {
    if (!this.editando) return;
    this.editando.variables[indice][campo] = valor;
  },

  anadirVariable() {
    if (!this.editando) return;
    this.editando.variables.push({ key: '', value: '' });
    this.pintarVariables();
    // El foco al nombre de la nueva: si no, hay que ir a buscarla con el ratón
    const filas = document.querySelectorAll('#envVarsContainer .env-var-key');
    if (filas.length) filas[filas.length - 1].focus();
  },

  /**
   * Abre el valor a varias lineas y lo vuelve a cerrar.
   *
   * Se escribe la altura en linea y no con una clase porque arrastrar la
   * esquina tambien escribe altura en linea: con una clase, el boton dejaria de
   * hacer efecto en cuanto alguien hubiera arrastrado esa fila.
   */
  alternarAlto(indice, boton) {
    const fila = document.querySelector(`.env-var-row[data-index="${indice}"]`);
    if (!fila) return;
    const campo = fila.querySelector('.env-var-value');
    const icono = boton.querySelector('i');
    const abierto = campo.dataset.manual === '1';

    icono.className = abierto ? 'fa fa-expand' : 'fa fa-compress';
    boton.title = abierto ? t('env.expandValue') : t('env.collapseValue');

    if (abierto) {
      // Vuelve a mandar el contenido
      delete campo.dataset.manual;
      this.ajustarAlto(campo);
    } else {
      campo.dataset.manual = '1';
      campo.style.height = '14rem';
      campo.focus();
    }
  },

  quitarVariable(indice) {
    if (!this.editando) return;
    this.editando.variables.splice(indice, 1);
    this.pintarVariables();
  },

  async crear() {
    const nombre = await Dialog.prompt(t('env.newPrompt'), { titulo: t('env.new') });
    if (!nombre || !nombre.trim()) return;

    try {
      const r = await fetch('/api/environments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nombre.trim() })
      });
      const datos = await r.json();
      if (!r.ok || !datos.success) throw new Error(datos.error);

      await this.cargar();
      this.editando = this.entornos.find(e => e.name === nombre.trim()) || null;
      this.pintarModal();
      showToast(t('env.created').replace('{{name}}', nombre.trim()), 'success');
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async eliminar(id) {
    const entorno = this.entornos.find(e => e.id === id);
    if (!entorno) return;
    if (!await Dialog.confirm(t('env.confirmDelete').replace('{{name}}', entorno.name),
                              { peligro: true, textoOk: t('buttons.delete') })) return;

    try {
      const r = await fetch(`/api/environments/${id}`, { method: 'DELETE' });
      const datos = await r.json();
      if (!r.ok || !datos.success) throw new Error(datos.error);

      await this.cargar();
      this.editando = this.activo();
      this.pintarModal();
      showToast(t('env.deleted').replace('{{name}}', entorno.name), 'success');
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async guardar() {
    if (!this.editando) return;

    // Las filas sin nombre se descartan en vez de guardarse vacías: una fila a
    // medio escribir no debería convertirse en una variable sin nombre
    const variables = this.editando.variables.filter(v => v.key && v.key.trim());

    try {
      const r = await fetch(`/api/environments/${this.editando.id}/variables`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables })
      });
      const datos = await r.json();
      if (!r.ok || !datos.success) throw new Error(datos.error);

      await this.cargar();
      this.editando = this.entornos.find(e => e.id === this.editando.id) || null;
      this.pintarModal();
      showToast(t('env.saved'), 'success');
      if (typeof tabla !== 'undefined' && tabla.ajax) tabla.ajax.reload(null, false);
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  esc(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
};

document.addEventListener('DOMContentLoaded', () => EnvModule.init());
