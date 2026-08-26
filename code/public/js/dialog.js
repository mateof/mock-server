/**
 * Los diálogos del panel.
 *
 * Sustituyen a alert, confirm y prompt del navegador, que salían con el aspecto
 * del sistema, decían "localhost:3890 dice" y no se podían estilar.
 *
 * Dos decisiones que no son de estilo:
 *
 * - No usan el modal de Bootstrap. Casi todas las llamadas salen desde dentro de
 *   otro modal, y Bootstrap 5 documenta que no soporta uno sobre otro. Con capa
 *   propia el problema no existe.
 * - Devuelven una promesa. Los nativos bloqueaban el hilo, así que quien los
 *   llamaba leía el resultado en la línea siguiente; aquí hay que esperar. Todas
 *   las llamadas del panel estaban ya en funciones async, así que el cambio se
 *   quedó en añadir `await`.
 */
const Dialog = {
  /** Quién resuelve la promesa que está en curso, si hay alguna. */
  _resolver: null,
  /** A dónde devolver el foco al cerrar. */
  _focoPrevio: null,

  ICONOS: {
    pregunta: 'fa-question-circle',
    aviso: 'fa-exclamation-triangle',
    dato: 'fa-pencil',
    info: 'fa-info-circle'
  },

  /**
   * Confirmación. Resuelve a true o false, nunca rechaza: quien llama decide
   * con un if, igual que hacía con confirm().
   */
  confirm(mensaje, opciones = {}) {
    return this._abrir({
      mensaje,
      titulo: opciones.titulo || t('dialog.confirmTitle'),
      icono: opciones.peligro ? 'aviso' : 'pregunta',
      peligro: !!opciones.peligro,
      textoOk: opciones.textoOk || t('buttons.accept'),
      conCancelar: true,
      conEntrada: false
    });
  },

  /** Pide un texto. Resuelve al valor, o a null si se cancela. */
  prompt(mensaje, opciones = {}) {
    return this._abrir({
      mensaje,
      titulo: opciones.titulo || t('dialog.promptTitle'),
      icono: 'dato',
      textoOk: opciones.textoOk || t('buttons.accept'),
      conCancelar: true,
      conEntrada: true,
      valor: opciones.valor || '',
      placeholder: opciones.placeholder || ''
    });
  },

  /** Aviso de un solo botón. Resuelve cuando se cierra. */
  alert(mensaje, opciones = {}) {
    return this._abrir({
      mensaje,
      titulo: opciones.titulo || t('dialog.alertTitle'),
      icono: opciones.icono || 'info',
      textoOk: opciones.textoOk || t('buttons.accept'),
      conCancelar: false,
      conEntrada: false
    });
  },

  _abrir(config) {
    const caja = document.getElementById('appDialog');
    // Sin el marcado no hay diálogo posible; antes de fallar en silencio se cae
    // al del navegador, que es feo pero funciona
    if (!caja) {
      if (config.conEntrada) return Promise.resolve(window.prompt(config.mensaje, config.valor));
      if (config.conCancelar) return Promise.resolve(window.confirm(config.mensaje));
      window.alert(config.mensaje);
      return Promise.resolve(true);
    }

    // Uno cada vez: si quedaba otro abierto se cancela antes de pisarlo
    if (this._resolver) this._cerrar(config.conEntrada ? null : false);

    document.getElementById('appDialogTitle').textContent = config.titulo;
    document.getElementById('appDialogMessage').textContent = config.mensaje;
    document.getElementById('appDialogIcon').className = 'fa ' + this.ICONOS[config.icono];

    const ok = document.getElementById('appDialogOk');
    ok.textContent = config.textoOk;
    ok.className = 'btn-modern ' + (config.peligro ? 'btn-modern-danger' : 'btn-modern-primary');

    const cancelar = document.getElementById('appDialogCancel');
    cancelar.textContent = t('buttons.cancel');
    cancelar.style.display = config.conCancelar ? '' : 'none';

    const entrada = document.getElementById('appDialogInput');
    entrada.style.display = config.conEntrada ? '' : 'none';
    entrada.value = config.valor || '';
    entrada.placeholder = config.placeholder || '';

    // Bootstrap devuelve el foco a su modal en cuanto sale de el, asi que un
    // dialogo colgado del body pierde el foco del campo nada mas abrirse y
    // Escape deja de llegar. En vez de desactivar la trampa en cada modal (y
    // que el proximo que se escriba herede el fallo en silencio), el dialogo se
    // cuelga del modal abierto: para Bootstrap el foco nunca sale, y aqui no
    // hay nada que recordar.
    const modalAbierto = [...document.querySelectorAll('.modal.show')].pop();
    (modalAbierto || document.body).appendChild(caja);

    caja.classList.add('is-open');
    this._focoPrevio = document.activeElement;
    this._conEntrada = config.conEntrada;

    // El foco al campo cuando lo hay, y al botón cuando no: así Enter y Escape
    // funcionan sin tocar el ratón
    (config.conEntrada ? entrada : ok).focus();
    if (config.conEntrada) entrada.select();

    return new Promise(resolve => { this._resolver = resolve; });
  },

  aceptar() {
    const entrada = document.getElementById('appDialogInput');
    this._cerrar(this._conEntrada ? entrada.value : true);
  },

  cancelar() {
    this._cerrar(this._conEntrada ? null : false);
  },

  _cerrar(valor) {
    const caja = document.getElementById('appDialog');
    if (caja) {
      caja.classList.remove('is-open');
      // Vuelve al body: si se queda dentro, al cerrarse el modal se va con el
      if (caja.parentElement !== document.body) document.body.appendChild(caja);
    }

    const resolver = this._resolver;
    this._resolver = null;
    // El foco vuelve a donde estaba: si salió de dentro de un modal, dejarlo
    // suelto deja ese modal sin foco y Escape ya no lo cierra
    if (this._focoPrevio && this._focoPrevio.focus) this._focoPrevio.focus();
    this._focoPrevio = null;

    if (resolver) resolver(valor);
  },

  get abierto() {
    return !!this._resolver;
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const caja = document.getElementById('appDialog');
  if (!caja) return;

  document.getElementById('appDialogOk').addEventListener('click', () => Dialog.aceptar());
  document.getElementById('appDialogCancel').addEventListener('click', () => Dialog.cancelar());
  document.getElementById('appDialogBackdrop').addEventListener('click', () => Dialog.cancelar());

  // En captura y cortando la propagación: si el diálogo salió desde dentro de un
  // modal de Bootstrap, dejar subir la tecla cerraría también ese modal, y el
  // usuario perdería de golpe lo que estaba haciendo por responder que no
  caja.addEventListener('keydown', (e) => {
    if (!Dialog.abierto) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); Dialog.cancelar(); }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); Dialog.aceptar(); }
  }, true);
});
