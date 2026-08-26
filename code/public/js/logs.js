/**
 * La vista del log de peticiones.
 *
 * Vive fuera de la vista porque la comparten dos sitios: la pantalla /logs y el
 * modal de la lista de rutas. El marcado sale del mismo parcial
 * (views/partials/logs-panel.ejs), asi que los identificadores son los mismos y
 * este modulo no necesita saber en cual de los dos esta.
 *
 * Lo unico que cambia es quien lo arranca: la pantalla lo hace al cargar, y el
 * modal al abrirse, para no consultar el log en cada visita a la lista de rutas.
 */
const LogsView = {
  trazaAbierta: null,
  offset: 0,
  limit: 100,
  total: 0,
  live: false,
  timer: null,
  debounce: null,
  entradas: [],
  expandidas: new Set(),

  // Font Awesome 4.7: cualquier nombre de FA5/FA6 se pinta vacio sin avisar
  ICONO_NIVEL: {
    error: 'fa-times-circle', warning: 'fa-exclamation-triangle',
    success: 'fa-check-circle', info: 'fa-info-circle'
  },

  // Los filtros de la pantalla y su valor "sin filtrar"
  FILTROS: { logLevel: '', logType: '', logMethod: '', logStatus: '', logSearch: '', logMinDuration: '', logFrom: '', logTo: '', logTraceId: '' },

  valor(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  },

  parametros() {
    const p = new URLSearchParams();
    const rango = this.valor('logRange');

    if (rango === 'custom') {
      // datetime-local da hora local sin zona; new Date la interpreta como
      // local, que es justo lo que el usuario acaba de escribir
      const desde = this.valor('logFrom');
      const hasta = this.valor('logTo');
      if (desde) p.set('from', String(new Date(desde).getTime()));
      if (hasta) p.set('to', String(new Date(hasta).getTime()));
    } else if (rango) {
      p.set('from', String(Date.now() - Number(rango) * 60000));
    }
    if (this.valor('logLevel')) p.set('level', this.valor('logLevel'));
    if (this.valor('logType')) p.set('type', this.valor('logType'));
    if (this.valor('logMethod')) p.set('method', this.valor('logMethod'));
    if (this.valor('logStatus')) p.set('status', this.valor('logStatus'));
    if (this.valor('logSearch')) p.set('search', this.valor('logSearch'));
    if (this.valor('logMinDuration')) p.set('minDuration', this.valor('logMinDuration'));
    if (this.valor('logTraceId')) p.set('traceId', this.valor('logTraceId'));
    return p;
  },

  // Filtrar por traza abre el rango temporal a todo: si la petición es de
  // hace dos horas, el preajuste de una hora la escondería y parecería que
  // la traza no existe
  filterByTrace(traceId) {
    if (!traceId) return;
    document.getElementById('logTraceId').value = traceId;
    document.getElementById('logRange').value = '';
    this.closeTrace();
    this.apply();
  },

  async openTrace(traceId) {
    this.trazaAbierta = traceId;
    try {
      const traza = await fetch(`/api/logs/trace/${traceId}`).then(r => r.json());
      if (traza.error) { showToast(traza.error, 'warning'); return; }
      this.pintarTraza(traza);
      this.mostrarTraza(true);
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  closeTrace() {
    this.trazaAbierta = null;
    this.mostrarTraza(false);
  },

  /**
   * Cambia la lista por la traza y al reves.
   *
   * Se retiran tambien los filtros y los botones de la lista: en vivo,
   * refrescar, vaciar y crear mocks actuan sobre la busqueda, no sobre la traza
   * que se esta leyendo, y dejarlos puestos invita a pulsarlos creyendo que van
   * con ella. Al volver siguen donde estaban.
   */
  mostrarTraza(visible) {
    const alternar = (id, mostrar) => {
      const el = document.getElementById(id);
      if (el) el.style.display = mostrar ? '' : 'none';
    };
    alternar('logsListSection', !visible);
    alternar('logsFilters', !visible);
    alternar('logsListActions', !visible);
    alternar('logsTracePanel', visible);
    alternar('logsTraceBackBtn', visible);
    alternar('logsHeadingTrace', visible);
    alternar('logsHeadingList', !visible);

    // Se vuelve arriba: la traza empieza por su resumen, y heredar el desplazamiento
    // de una lista larga la dejaria empezada por la mitad
    const cuerpo = document.querySelector('#logsModal .modal-body') ||
      document.scrollingElement;
    if (cuerpo) cuerpo.scrollTop = 0;
  },

  pintarTraza(traza) {
    const esc = (v) => this.esc(v);
    document.getElementById('traceSummary').innerHTML = `
      <div class="trace-summary-main">
        <span class="badge-method">${esc(traza.method || '')}</span>
        <code class="trace-url">${esc(traza.url || '')}</code>
        ${traza.status ? `<span class="logs-status logs-status-${String(traza.status)[0]}xx">${traza.status}</span>` : ''}
      </div>
      <div class="trace-summary-meta">
        <span><i class="fa fa-clock-o"></i> ${traza.duration} ms</span>
        <span><i class="fa fa-list-ol"></i> ${traza.steps} ${t('logs.traceSteps')}</span>
        ${traza.route_id ? `<span><i class="fa fa-sitemap"></i> ${t('logs.traceRoute')} ${traza.route_id}</span>` : ''}
        <code class="trace-id">${esc(traza.trace_id)}</code>
      </div>`;

    // El ancho de cada barra es el hueco hasta el paso siguiente: así se ve
    // dónde se fue el tiempo, que casi siempre es esperando al backend
    const total = Math.max(traza.duration || 0, 1);
    const iconos = {
      request: 'fa-sign-in', route: 'fa-sitemap', condition: 'fa-code-fork',
      wait: 'fa-pause', script: 'fa-magic', 'proxy-request': 'fa-arrow-right',
      'proxy-response': 'fa-arrow-left', fallback: 'fa-life-ring',
      sequence: 'fa-list-ol', template: 'fa-code', latency: 'fa-hourglass-half',
      fault: 'fa-bolt', response: 'fa-sign-out'
    };

    document.getElementById('traceTimeline').innerHTML = traza.entries.map((e, i) => {
      const siguiente = traza.entries[i + 1];
      const hasta = siguiente ? siguiente.offset : (traza.duration || e.offset);
      const ancho = Math.max(1.5, ((hasta - e.offset) / total) * 100);
      const desde = Math.min(98.5, (e.offset / total) * 100);
      const lapso = hasta - e.offset;

      return `
        <div class="trace-step trace-step-${esc(e.level)}">
          <div class="trace-step-head" onclick="LogsView.toggleTraceDetail(${e.id})">
            <span class="trace-step-icon"><i class="fa ${iconos[e.step] || 'fa-circle-o'}"></i></span>
            <span class="trace-step-name">${esc(e.step || e.type)}</span>
            <span class="trace-step-message">${esc(e.message || '')}</span>
            <span class="trace-step-time">+${e.offset} ms</span>
            ${e.details ? '<i class="fa fa-chevron-down trace-step-toggle"></i>' : ''}
          </div>
          <div class="trace-step-bar-rail">
            <div class="trace-step-bar" style="margin-left: ${desde}%; width: ${ancho}%;"
                 title="${lapso} ms"></div>
          </div>
          ${e.details ? `<pre class="trace-step-detail" id="trace-detail-${e.id}" style="display: none;">${esc(JSON.stringify(e.details, null, 2))}</pre>` : ''}
        </div>`;
    }).join('');
  },

  toggleTraceDetail(id) {
    const el = document.getElementById(`trace-detail-${id}`);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
  },

  async apply() {
    if (this.trazaAbierta) this.mostrarTraza(false);
    this.sincronizarRango();
    this.sincronizarTraza();
    this.offset = 0;
    this.entradas = [];
    await this.cargar();
  },

  /**
   * Enseña los campos de fecha solo en modo "a medida" y, la primera vez,
   * los prellena con el rango que se estaba viendo: así el usuario ajusta
   * desde donde estaba en vez de partir de dos campos vacíos.
   */
  sincronizarRango() {
    const aMedida = this.valor('logRange') === 'custom';
    document.getElementById('logCustomRange').style.display = aMedida ? '' : 'none';
    document.getElementById('logCustomRangeTo').style.display = aMedida ? '' : 'none';

    if (aMedida && !this.valor('logFrom') && !this.valor('logTo')) {
      const ahora = new Date();
      const antes = new Date(ahora.getTime() - 60 * 60000);
      document.getElementById('logFrom').value = this.paraInput(antes);
      document.getElementById('logTo').value = this.paraInput(ahora);
    }
  },

  sincronizarTraza() {
    const traza = this.valor('logTraceId');
    document.getElementById('logTraceGroup').style.display = traza ? '' : 'none';
    document.getElementById('logTraceChip').textContent = traza;
  },

  // datetime-local espera hora local en formato YYYY-MM-DDTHH:mm:ss
  paraInput(fecha) {
    const dos = n => String(n).padStart(2, '0');
    return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}` +
           `T${dos(fecha.getHours())}:${dos(fecha.getMinutes())}:${dos(fecha.getSeconds())}`;
  },

  // Escribir en un campo de texto no debe disparar una consulta por tecla
  applyDebounced() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.apply(), 350);
  },

  async refresh() { await this.apply(); },

  async more() {
    this.offset += this.limit;
    await this.cargar({ anexar: true });
  },

  async cargar({ anexar = false } = {}) {
    const p = this.parametros();
    p.set('limit', String(this.limit));
    p.set('offset', String(this.offset));

    try {
      const [datos, stats] = await Promise.all([
        fetch(`/api/logs?${p}`).then(r => r.json()),
        anexar ? Promise.resolve(null) : fetch(`/api/logs/stats?${this.parametros()}`).then(r => r.json())
      ]);

      this.entradas = anexar ? this.entradas.concat(datos.entries) : datos.entries;
      this.pintarTabla(datos);
      if (stats) {
        this.pintarResumen(stats);
        this.pintarHistograma(stats);
        this.rellenarTipos(stats);
      }
      this.actualizarAspas();
    } catch (e) {
      console.error('[logs]', e);
    }
  },

  rellenarTipos(stats) {
    const select = document.getElementById('logType');
    const actual = select.value;
    const tipos = Object.keys(stats.by_type || {}).sort();
    // Se conserva el tipo elegido aunque el filtro actual lo deje sin entradas
    if (actual && !tipos.includes(actual)) tipos.push(actual);
    select.innerHTML = `<option value="">${t('filters.all')}</option>` +
      tipos.map(tipo => `<option value="${tipo}" ${tipo === actual ? 'selected' : ''}>${tipo}</option>`).join('');
  },

  pintarResumen(stats) {
    const nivel = stats.by_level || {};
    const dur = stats.duration || {};
    const tarjeta = (etiqueta, valor, clase) =>
      `<div class="logs-stat ${clase || ''}"><span class="logs-stat-value">${valor}</span><span class="logs-stat-label">${etiqueta}</span></div>`;

    document.getElementById('logsSummary').innerHTML =
      tarjeta(t('logs.total'), stats.total || 0) +
      tarjeta(t('logs.levelError'), nivel.error || 0, 'is-error') +
      tarjeta(t('logs.levelWarning'), nivel.warning || 0, 'is-warning') +
      tarjeta(t('logs.avgDuration'), dur.avg ? Math.round(dur.avg) + ' ms' : '-') +
      tarjeta(t('logs.maxDuration'), dur.max ? dur.max + ' ms' : '-') +
      (stats.storage ? tarjeta(t('logs.stored'), `${stats.storage.written}/${stats.storage.max_rows}`) : '');
  },

  pintarHistograma(stats) {
    const cont = document.getElementById('logsHistogram');
    const eje = document.getElementById('logsHistogramAxis');
    const barras = stats.histogram || [];

    if (barras.length === 0 || !stats.total) {
      cont.innerHTML = '';
      eje.innerHTML = '';
      return;
    }

    const maximo = Math.max(...barras.map(b => b.total)) || 1;
    cont.innerHTML = barras.map(b => {
      const alto = Math.round((b.total / maximo) * 100);
      const trozo = (n, clase) => n > 0
        ? `<div class="logs-bar-part ${clase}" style="flex: ${n};"></div>` : '';
      const titulo = `${new Date(b.from).toLocaleTimeString()} · ${b.total}`;
      return `<div class="logs-bar" style="height: ${Math.max(alto, b.total > 0 ? 4 : 0)}%;" title="${titulo}">
                ${trozo(b.error, 'is-error')}${trozo(b.warning, 'is-warning')}${trozo(b.success, 'is-success')}${trozo(b.info, 'is-info')}
              </div>`;
    }).join('');

    const desde = new Date(barras[0].from);
    const hasta = new Date(barras[barras.length - 1].to);
    eje.innerHTML = `<span>${desde.toLocaleString()}</span><span>${hasta.toLocaleTimeString()}</span>`;
  },

  pintarTabla(datos) {
    // Se guarda para repintar sin volver a consultar (al abrir un detalle)
    if (datos && datos.total !== undefined) this.total = datos.total;

    const cuerpo = document.getElementById('logsBody');
    const vacio = document.getElementById('logsEmpty');

    if (this.entradas.length === 0) {
      cuerpo.innerHTML = '';
      vacio.style.display = 'block';
    } else {
      vacio.style.display = 'none';
      cuerpo.innerHTML = this.entradas.map(e => this.fila(e)).join('');
    }

    document.getElementById('logsCount').textContent =
      t('logs.showing').replace('{{shown}}', this.entradas.length).replace('{{total}}', this.total);
    document.getElementById('logsMoreBtn').style.display =
      this.entradas.length < this.total ? 'inline-flex' : 'none';
  },

  fila(e) {
    const hora = new Date(e.ts_ms).toLocaleTimeString(undefined, { hour12: false }) +
      '.' + String(e.ts_ms % 1000).padStart(3, '0');
    const detalle = e.details
      ? `<button class="btn-icon" onclick="event.stopPropagation(); LogsView.toggleDetalle(${e.id})" title="${t('logs.details')}"><i class="fa fa-chevron-down"></i></button>`
      : '';
    const botonTraza = e.trace_id
      ? `<button class="btn-icon" onclick="event.stopPropagation(); LogsView.openTrace('${e.trace_id}')" title="${t('logs.traceOpen')}"><i class="fa fa-sitemap"></i></button>`
      : '';
    // Solo el tráfico proxy detallado lleva dentro la respuesta del backend,
    // que es lo único con lo que se puede construir un mock
    const botonMock = (e.type === 'proxy-detailed' && e.details && typeof e.details === 'object')
      ? `<button class="btn-icon" onclick="event.stopPropagation(); LogsView.mockFromEntry(${e.id})" title="${t('logs.saveAsMock')}"><i class="fa fa-download"></i></button>`
      : '';
    const abierta = this.expandidas.has(e.id);

    return `
      <tr class="logs-row logs-row-${e.level}${e.trace_id ? ' logs-row-traceable' : ''}"
          ${e.trace_id ? `onclick="LogsView.filterByTrace('${e.trace_id}')" title="${t('logs.traceFilterHint')}"` : ''}>
        <td class="logs-time">${hora}</td>
        <td><span class="logs-level logs-level-${e.level}"><i class="fa ${this.ICONO_NIVEL[e.level] || 'fa-circle-o'}"></i>${e.level}</span></td>
        <td>${e.method ? `<span class="badge-method">${e.method}</span>` : ''}</td>
        <td class="logs-url" title="${this.esc(e.message || '')}">${this.esc(e.url || e.message || '')}</td>
        <td>${e.status !== null && e.status !== undefined ? `<span class="logs-status logs-status-${String(e.status)[0]}xx">${e.status}</span>` : ''}</td>
        <td>${e.duration !== null && e.duration !== undefined ? e.duration + ' ms' : ''}</td>
        <td class="logs-actions">${botonMock}${botonTraza}${detalle}</td>
      </tr>
      ${abierta ? `<tr class="logs-detail-row"><td colspan="7"><pre class="logs-detail">${this.esc(JSON.stringify(e.details, null, 2))}</pre></td></tr>` : ''}
    `;
  },

  toggleDetalle(id) {
    if (this.expandidas.has(id)) this.expandidas.delete(id);
    else this.expandidas.add(id);
    // Repinta con el total ya conocido, sin volver a consultar
    this.pintarTabla();
  },

  toggleLive() {
    this.live = !this.live;
    const btn = document.getElementById('logsLiveBtn');
    const etiqueta = document.getElementById('logsLiveLabel');

    if (this.live) {
      btn.classList.add('is-live');
      etiqueta.textContent = t('logs.livePause');
      btn.querySelector('i').className = 'fa fa-pause';
      this.timer = setInterval(() => this.apply(), 3000);
    } else {
      btn.classList.remove('is-live');
      etiqueta.textContent = t('logs.live');
      btn.querySelector('i').className = 'fa fa-play';
      clearInterval(this.timer);
    }
  },

  clearOne(id) {
    document.getElementById(id).value = this.FILTROS[id];
    this.apply();
  },

  clearAll() {
    Object.entries(this.FILTROS).forEach(([id, vacio]) => {
      document.getElementById(id).value = vacio;
    });
    // El rango vuelve a su preajuste, no a "sin filtro": mirar todo el
    // histórico por defecto sería lento y rara vez es lo que se quiere
    document.getElementById('logRange').value = '60';
    this.apply();
  },

  actualizarAspas() {
    Object.keys(this.FILTROS).forEach(id => {
      const activo = this.valor(id) !== this.FILTROS[id];
      const boton = document.getElementById(`clear-${id}`);
      if (boton) boton.style.display = activo ? 'inline-flex' : 'none';
    });
  },

  // t() devuelve la propia clave cuando no la encuentra, así que hay que
  // compararla para poder caer en el motivo crudo que manda el servidor
  motivo(razon) {
    const clave = 'logs.reason.' + razon;
    const texto = t(clave);
    return texto === clave ? razon : texto;
  },

  /**
   * Convierte una línea concreta en una ruta mock.
   *
   * Se crea activa: pedirlo sobre una entrada concreta es una decisión
   * explícita y es una ruta sola, así que taparla al proxy es lo que se busca.
   */
  async mockFromEntry(id) {
    try {
      const r = await fetch(`/api/logs/${id}/mock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });
      const datos = await r.json();

      if (!r.ok || datos.success === false) {
        showToast(t('logs.mockFailed').replace('{{reason}}', this.motivo(datos.reason)), 'warning');
        return;
      }
      showToast(t('logs.mockCreated').replace('{{path}}', datos.ruta), 'success');
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  /**
   * Convierte en mocks todo el tráfico proxy que casa con los filtros
   * puestos. Nacen desactivadas: activarlas de golpe taparía al proxy del que
   * salieron, y lo normal es querer revisarlas antes.
   */
  async mocksFromResults() {
    if (!await Dialog.confirm(t('logs.confirmToMocks'))) return;

    const p = this.parametros();
    const cuerpo = { active: false, limit: 1000 };
    for (const [clave, valor] of p.entries()) {
      // El nivel y el tipo no viajan: la conversión ya se limita al tráfico
      // proxy detallado, que es el único que lleva la respuesta dentro
      if (clave === 'level' || clave === 'type') continue;
      cuerpo[clave] = valor;
    }

    try {
      const r = await fetch('/api/logs/mocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo)
      });
      const datos = await r.json();

      if (!r.ok) {
        showToast(datos.error || t('logs.mockFailed'), 'error');
        return;
      }
      if (!datos.created && !datos.updated) {
        showToast(t('logs.toMocksNone'), 'warning');
        return;
      }
      showToast(t('logs.toMocksDone')
        .replace('{{created}}', datos.created)
        .replace('{{updated}}', datos.updated)
        .replace('{{skipped}}', datos.skipped), 'success');
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async clear() {
    if (!await Dialog.confirm(t('logs.confirmClear'), { peligro: true, textoOk: t('buttons.clear') })) return;
    // Borra solo lo que se está viendo, que es menos sorprendente que
    // vaciarlo todo cuando hay filtros puestos
    await fetch(`/api/logs?${this.parametros()}`, { method: 'DELETE' });
    await this.apply();
  },

  esc(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  /**
   * Abre el log sin salir de la lista de rutas. Si el modal no está en esta
   * pantalla se cae a la pantalla propia, que sigue existiendo.
   */
  abrir() {
    if (!document.getElementById('logsModal')) {
      window.location.href = '/logs';
      return;
    }
    $('#logsModal').modal('show');
  },

  /** Arranca la vista. Idempotente: el modal la abre cada vez. */
  async init() {
    if (!document.getElementById('logsBody')) return;
    this.closeTrace();
    await this.apply();
  },

  /**
   * Al cerrar el modal se para el seguimiento en vivo. Si no, seguiria
   * consultando cada tres segundos contra una pantalla que ya no se ve.
   */
  pausar() {
    if (this.live) this.toggleLive();
    clearTimeout(this.debounce);
  }
};

// La pantalla /logs se arranca sola al cargar. Dentro del modal se espera a que
// esté abierto: consultar el log en cada visita a la lista de rutas seria pedir
// trabajo al servidor para algo que casi nunca se mira.
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('logsModal');
  if (!modal) return;
  modal.addEventListener('shown.bs.modal', () => LogsView.init());
  modal.addEventListener('hide.bs.modal', () => LogsView.pausar());
});
