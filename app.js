/* Optimizador de rutas — interfaz. JS puro, sin dependencias salvo Leaflet (lib/) y motor.js.
   Toda la matemática está en motor.js (window.MotorRutas). Aquí solo: datos, red opcional (OSRM), pantalla. */
(function () {
  'use strict';

  var Motor = window.MotorRutas || null;
  var OSRM = 'https://router.project-osrm.org';
  var GAP_MS = 1100;            // pausa mínima entre consultas al mismo servidor público (uso justo: ≤ 1 por segundo)
  var BLOQUE_OSRM = 50;         // con más de 100 puntos la tabla se pide por bloques de 50 x 50
  var MAX_PUNTOS_OSRM = 300;    // por encima de esto el servidor público tardaría demasiado: se usa línea recta
  var LS_KEY = 'optimizador-rutas-v1';
  // Paleta categórica FUNCIONAL para distinguir vehículos (excepción documentada al «sin nuevos acentos» de Felt):
  // ámbar, blanco, Lichen y tonos tierra/atlas; todas se dibujan con un borde oscuro (Deep Bog) para contrastar sobre el mapa claro.
  var COLORES = ['#dc8c46', '#ffffff', '#64754b', '#a8431f', '#2f7d7a', '#c9a227', '#7a4a6b', '#d8dcd2', '#8a6a3d', '#4b6a8f'];
  var TIEMPOS = { rapido: 1000, normal: 3000, profundo: 10000 };
  function tiempoValido(k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(TIEMPOS, k); }
  var PERFIL_NINGUNO = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  // Respaldo por si el motor no trae los presets (el real los trae). Sigue siendo un SUPUESTO genérico.
  var PERFIL_LIMA = [1, 1, 1, 1, 1, 1.2, 1.5, 1.9, 1.8, 1.4, 1.2, 1.2, 1.3, 1.3, 1.2, 1.3, 1.5, 1.8, 1.9, 1.6, 1.3, 1.1, 1, 1];

  /* ===================== utilidades ===================== */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v, def) {
    if (typeof v === 'number') return isFinite(v) ? v : def;
    if (v == null) return def;
    var s = String(v).trim().replace(/\s/g, '');
    if (s === '') return def;
    var c = s.lastIndexOf(','), p = s.lastIndexOf('.');
    if (c >= 0 && p >= 0) s = c > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (c >= 0) s = s.replace(',', '.');
    var n = Number(s);
    return isFinite(n) ? n : def;
  }
  function fmt(n, d) {
    if (d == null) d = 1;
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return n.toLocaleString('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function money(n) { return esc(estado.moneda) + ' ' + fmt(n, 2); }
  function moneyTxt(n) { return estado.moneda + ' ' + fmt(n, 2); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function hhmm2min(s) {
    var m = /^\s*(\d{1,2})[:.h](\d{2})(?::\d{2})?\s*$/.exec(s == null ? '' : String(s));
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 47 || mi > 59) return null;
    return h * 60 + mi;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function min2hhmm(m) {
    if (typeof m !== 'number' || !isFinite(m)) return '—';
    m = Math.round(m);
    var d = Math.floor(m / 1440), r = m - d * 1440;
    return pad2(Math.floor(r / 60)) + ':' + pad2(r % 60) + (d > 0 ? ' (+' + d + ')' : '');
  }
  // Ventana horaria [a, b] en minutos; b < a = cruza medianoche (se muestra con (+1)).
  function ventanaTxt(v) {
    if (!v || v.length < 2) return '—';
    var a = v[0], b = v[1];
    if (b < a) b += 1440;
    if (a === 0 && b >= 1440) return '—';
    if (b === 1440) return 'desde ' + min2hhmm(a);
    if (a === 0) return 'hasta ' + min2hhmm(b);
    return min2hhmm(a) + '–' + min2hhmm(b);
  }
  function fmtDur(min) {
    if (typeof min !== 'number' || !isFinite(min)) return '—';
    min = Math.round(min);
    var h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? h + ' h ' + pad2(m) + ' min' : m + ' min';
  }
  // «12,6 km menos» si v > 0, «12,6 km más» si v < 0 (nunca «menos» con un número negativo)
  function menosMas(v, d, unidad, extra) {
    v = typeof v === 'number' && isFinite(v) ? v : 0;
    return fmt(Math.abs(v), d) + ' ' + unidad + (v < 0 ? ' más' : ' menos') + (extra || '');
  }
  function avisoBorde(hora) {
    return '<div class="msg aviso">El mejor momento está en el borde del rango (' + esc(min2hhmm(hora)) + '). Amplía el rango para ver si hay algo mejor.</div>';
  }
  function debounce(fn, ms) {
    var t = null;
    return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); };
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function cederHilo() {
    return new Promise(function (res) {
      var hecho = false;
      function f() { if (!hecho) { hecho = true; res(); } }
      if (window.requestAnimationFrame) requestAnimationFrame(function () { setTimeout(f, 30); });
      setTimeout(f, 250); // si la pestaña está oculta rAF no corre
    });
  }
  function descargar(nombre, texto, mime) {
    var blob = new Blob([texto], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function copiar(texto) {
    function viejo() {
      try {
        var ta = document.createElement('textarea');
        ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) { return false; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(texto).then(function () { return true; }, function () { return viejo(); });
    }
    return Promise.resolve(viejo());
  }
  var toastT = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.hidden = true; }, 3800);
  }
  function getPath(o, path) {
    return path.split('.').reduce(function (a, k) { return a == null ? undefined : a[k]; }, o);
  }
  function setPath(o, path, v) {
    var ks = path.split('.'), last = ks.pop();
    var t = ks.reduce(function (a, k) { return a[k]; }, o);
    t[last] = v;
  }

  /* ===================== estado ===================== */
  var MAX_TIPOS = 8;
  var MAX_PARADAS = 1000;       // tope de paradas (JSON, CSV, pegado, direcciones y alta manual)
  function msgTopeParadas() { return 'Se alcanzó el máximo de ' + MAX_PARADAS + ' paradas.'; }
  var ESTADO_VERSION = 2;
  function tipoVacio(n) {
    return {
      id: 'T' + n, nombre: 'Vehículo ' + n, cantidad: '1', capacidad: '', costo_fijo: '', costo_km: '', costo_hora: '', jornada_h: '',
      salida_modo: 'fija', salida: '08:00', desde: '06:00', hasta: '09:00', paso: '10',
      calc: { km_gal: '', precio_gal: '', desgaste: '' }
    };
  }
  function estadoVacio() {
    var t = tipoVacio(1); t.cantidad = '3';
    return {
      version: ESTADO_VERSION, esEjemplo: false, moneda: 'S/', sigC: 1, sigP: 1, sigT: 2, csvSep: ',',
      deposito: { nombre: 'Depósito', lat: '', lon: '' },
      paradas: [], peajes: [],
      fin: 'deposito',                                        // 'deposito' | 'otro' | 'ultima'
      depositoFinal: { nombre: 'Depósito final', lat: '', lon: '' },
      flota: { tipos: [t] },
      est: { circuidad: '1.35', velocidad: '35' },
      equilibrio: '0',
      objetivo: 'costo', peso_peaje: '1', calles: true, tiempo: 'normal', actual: '',
      perfil: PERFIL_NINGUNO.slice(),
      barrido: { desde: '05:00', hasta: '11:00', paso: '30' },
      // 45 % = valor de EJEMPLO (rotulado en la pestaña Flete, el usuario pone su propio margen); IGV 18 % = ley peruana, editable.
      tarifa: { tipo_margen: 'markup', pct: '45', igv_pct: '18', base: 'mixto', minimo: '', redondeo: '0.1' }
    };
  }
  var estado = estadoVacio();
  var ultimo = null;        // {problema, resultado, actual, legs, verif, usoOSRM, obsoleto, refino, flete}
  var cacheMatriz = null;   // {firma, km, min}
  var cacheLegs = new Map(); // "lat,lon>lat,lon" -> {geom:[[lat,lon]..], km, min}
  var ocupado = false;
  var versionEstado = 0;    // sube con cada cambio de datos / Nuevo / cargar proyecto: sirve para descartar cálculos que quedaron viejos
  var ctlRed = null, cancelado = false; // AbortController compartido de las consultas OSRM del cálculo en curso
  var mapa = null, capaLineas = null, capaMarc = null, modoClic = 'parada';

  function normalizarTipo(t, i, vistos) {
    function S(v) { return v == null ? '' : String(v); }
    var b = tipoVacio(i + 1);
    t = t || {};
    var id = S(t.id) || b.id, base = id, k = 1;
    while (vistos[id]) id = base + '_' + (++k);
    vistos[id] = 1;
    b.id = id;
    b.nombre = S(t.nombre) || b.nombre;
    ['cantidad', 'capacidad', 'costo_fijo', 'costo_km', 'costo_hora', 'jornada_h', 'salida', 'desde', 'hasta', 'paso'].forEach(function (c) {
      if (t[c] != null) b[c] = S(t[c]);
    });
    if (!b.cantidad) b.cantidad = '1';
    b.salida_modo = t.salida_modo === 'auto' ? 'auto' : 'fija';
    if (t.calc) ['km_gal', 'precio_gal', 'desgaste'].forEach(function (c) { if (t.calc[c] != null) b.calc[c] = S(t.calc[c]); });
    return b;
  }

  function normalizarEstado(o) {
    var e = estadoVacio();
    if (!o || typeof o !== 'object') return e;
    function S(v) { return v == null ? '' : String(v); }
    var ver = typeof o.version === 'number' ? o.version : 1;
    e.esEjemplo = !!o.esEjemplo;
    e.moneda = S(o.moneda).slice(0, 6) || 'S/';
    e.csvSep = o.csvSep === ';' ? ';' : ',';
    if (o.deposito) { e.deposito.nombre = S(o.deposito.nombre) || 'Depósito'; e.deposito.lat = S(o.deposito.lat); e.deposito.lon = S(o.deposito.lon); }
    var vistos = Object.create(null);
    function idUnico(id, pref, i) {
      id = S(id) || (pref + (i + 1));
      var base = id, k = 1;
      while (vistos[pref + '|' + id]) { id = base + '_' + (++k); }
      vistos[pref + '|' + id] = 1;
      return id;
    }
    e.paradas = (Array.isArray(o.paradas) ? o.paradas : []).slice(0, MAX_PARADAS).map(function (p, i) {
      p = p || {};
      return {
        id: idUnico(p.id, 'C', i), nombre: S(p.nombre), dir: S(p.dir).slice(0, 300), lat: S(p.lat), lon: S(p.lon), demanda: S(p.demanda), servicio: S(p.servicio),
        ini: S(p.ini), fin: S(p.fin), geo: (p.geo === 'ok' || p.geo === 'dudosa' || p.geo === 'sin') ? p.geo : ''
      };
    });
    e.peajes = (Array.isArray(o.peajes) ? o.peajes : []).slice(0, 500).map(function (p, i) {
      p = p || {};
      return { id: idUnico(p.id, 'P', i), nombre: S(p.nombre), lat: S(p.lat), lon: S(p.lon), costo: S(p.costo), radio: S(p.radio) };
    });
    function maxSuf(arr, letra) {
      var m = 0;
      arr.forEach(function (x) { var r = new RegExp('^' + letra + '(\\d+)$').exec(x.id); if (r) m = Math.max(m, +r[1]); });
      return m + 1;
    }
    e.sigC = Math.max(maxSuf(e.paradas, 'C'), e.paradas.length + 1);
    e.sigP = Math.max(maxSuf(e.peajes, 'P'), e.peajes.length + 1);

    // --- flota: formato v1.1 (tipos) o migración desde v1.0 (un solo tipo)
    var F = o.flota || {}, vt = Object.create(null);
    if (Array.isArray(F.tipos) && F.tipos.length) {
      e.flota.tipos = F.tipos.slice(0, MAX_TIPOS).map(function (t, i) { return normalizarTipo(t, i, vt); });
    } else {
      var t1 = tipoVacio(1);
      t1.nombre = 'Vehículo';
      t1.cantidad = S(F.vehiculos_max) || '3';
      ['capacidad', 'costo_fijo', 'costo_km', 'costo_hora', 'jornada_h'].forEach(function (c) { if (F[c] != null) t1[c] = S(F[c]); });
      if (F.salida != null && S(F.salida) !== '') t1.salida = S(F.salida);
      if (o.calc) ['km_gal', 'precio_gal', 'desgaste'].forEach(function (c) { if (o.calc[c] != null) t1.calc[c] = S(o.calc[c]); });
      e.flota.tipos = [normalizarTipo(t1, 0, vt)];
    }
    e.sigT = Math.max(maxSuf(e.flota.tipos, 'T'), e.flota.tipos.length + 1);
    // punto final de la ruta: proyectos anteriores guardaban solo flota.retorno (false = termina en la última parada)
    e.fin = (o.fin === 'otro' || o.fin === 'ultima' || o.fin === 'deposito') ? o.fin : (F.retorno === false ? 'ultima' : 'deposito');
    if (o.depositoFinal && typeof o.depositoFinal === 'object') {
      e.depositoFinal.nombre = S(o.depositoFinal.nombre).slice(0, 80) || 'Depósito final';
      e.depositoFinal.lat = S(o.depositoFinal.lat); e.depositoFinal.lon = S(o.depositoFinal.lon);
    }
    ['circuidad', 'velocidad'].forEach(function (k) { if (o.est && o.est[k] != null) e.est[k] = S(o.est[k]); });
    if (['0', '0.25', '0.6', '1'].indexOf(S(o.equilibrio)) >= 0) e.equilibrio = S(o.equilibrio);
    if (['costo', 'distancia', 'tiempo'].indexOf(o.objetivo) >= 0) e.objetivo = o.objetivo;
    if (['1', '2', '5'].indexOf(S(o.peso_peaje)) >= 0) e.peso_peaje = S(o.peso_peaje);
    // v1.0 guardaba calles=false por defecto: al migrar se activa (nuevo valor por defecto de v1.1)
    e.calles = ver >= 2 ? !!o.calles : true;
    if (tiempoValido(o.tiempo)) e.tiempo = o.tiempo;
    e.actual = S(o.actual);
    if (Array.isArray(o.perfil) && o.perfil.length === 24) {
      e.perfil = o.perfil.map(function (v) { return clamp(Math.round(num(v, 1) * 10) / 10, 1, 3); });
    }
    ['desde', 'hasta', 'paso'].forEach(function (k) { if (o.barrido && o.barrido[k] != null) e.barrido[k] = S(o.barrido[k]); });
    if (o.tarifa) {
      if (o.tarifa.tipo_margen === 'margen') e.tarifa.tipo_margen = 'margen';
      ['pct', 'igv_pct', 'minimo', 'redondeo'].forEach(function (k) { if (o.tarifa[k] != null) e.tarifa[k] = S(o.tarifa[k]); });
      if (['mixto', 'desvio', 'peso', 'igual'].indexOf(o.tarifa.base) >= 0) e.tarifa.base = o.tarifa.base;
    }
    return e;
  }

  var guardarLocalDeb = debounce(guardarLocal, 400);
  var avisoLS = false, migradoDeV1 = false;
  function guardarLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(estado)); }
    catch (e) { if (!avisoLS) { avisoLS = true; toast('No se pudo autoguardar en este navegador. Usa “Guardar proyecto” para no perder tu trabajo.'); } }
  }
  function cargarLocal() {
    try {
      var t = localStorage.getItem(LS_KEY);
      if (!t) return false;
      var crudo = JSON.parse(t);
      migradoDeV1 = !!crudo && typeof crudo === 'object' && !(typeof crudo.version === 'number' && crudo.version >= ESTADO_VERSION);
      estado = normalizarEstado(crudo);
      return true;
    } catch (e) { return false; }
  }

  /* ===================== ejemplo (ficticio) ===================== */
  function datosEjemplo() {
    var e = estadoVacio();
    e.esEjemplo = true;
    e.deposito = { nombre: 'Almacén central (ejemplo)', lat: '-12.054', lon: '-77.1' };
    // [nombre, lat, lon, demanda, servicio, desde, hasta]  — todo inventado
    var filas = [
      ['Tienda Miraflores', -12.1219, -77.0297, 120, 15, '09:00', '12:00'],
      ['Tienda San Isidro', -12.0977, -77.0365, 90, 10, '08:30', '11:00'],
      ['Bodega Surco', -12.145, -76.993, 150, 20, '', ''],
      ['Minimarket La Molina', -12.085, -76.935, 200, 20, '10:00', '14:00'],
      ['Tienda San Borja', -12.108, -77.003, 80, 10, '', ''],
      ['Oficina Jesús María', -12.07, -77.051, 110, 10, '', ''],
      ['Tienda Lince', -12.0850, -77.034, 60, 10, '', ''],
      ['Bodega Los Olivos', -11.97, -77.07, 180, 20, '08:00', '11:30'],
      ['Tienda San Miguel', -12.078, -77.09, 140, 15, '', ''],
      ['Bodega Villa El Salvador', -12.21, -76.94, 100, 15, '13:00', '17:00'],
      ['Tienda Chorrillos', -12.168, -77.014, 130, 15, '', ''],
      ['Minimarket Ate', -12.026, -76.917, 90, 10, '09:00', '13:00']
    ];
    e.paradas = filas.map(function (f, i) {
      return { id: 'C' + (i + 1), nombre: f[0], dir: '', lat: String(f[1]), lon: String(f[2]), demanda: String(f[3]), servicio: String(f[4]), ini: f[5], fin: f[6], geo: '' };
    });
    e.sigC = filas.length + 1;
    e.peajes = [
      { id: 'P1', nombre: 'Peaje de ejemplo 1', lat: '-12.0965', lon: '-76.969', costo: '5', radio: '300' },
      { id: 'P2', nombre: 'Peaje de ejemplo 2', lat: '-12.189', lon: '-76.977', costo: '4.5', radio: '300' }
    ];
    e.sigP = 3;
    var t1 = tipoVacio(1);
    t1.nombre = 'Camioneta (ejemplo)'; t1.cantidad = '2'; t1.capacidad = '700'; t1.costo_fijo = '40'; t1.costo_km = '0.58'; t1.costo_hora = '12'; t1.jornada_h = '9';
    t1.salida_modo = 'fija'; t1.salida = '08:00';
    t1.calc = { km_gal: '35', precio_gal: '15', desgaste: '0.15' };
    var t2 = tipoVacio(2);
    t2.nombre = 'Camión (ejemplo)'; t2.cantidad = '1'; t2.capacidad = '1500'; t2.costo_fijo = '90'; t2.costo_km = '1.2'; t2.costo_hora = '18'; t2.jornada_h = '9';
    t2.salida_modo = 'auto'; t2.desde = '06:00'; t2.hasta = '09:00'; t2.paso = '10';
    t2.calc = { km_gal: '14', precio_gal: '15', desgaste: '0.1' };
    e.flota.tipos = [t1, t2];
    e.sigT = 3;
    e.perfil = (Motor && Motor.PERFILES_TRAFICO && Motor.PERFILES_TRAFICO.lima_tipico ? Motor.PERFILES_TRAFICO.lima_tipico : PERFIL_LIMA).slice();
    return e;
  }

  /* ===================== cambios y obsolescencia ===================== */
  // Reemplazo total de los datos (Nuevo, ejemplo, cargar proyecto, importar reemplazando): nada del trabajo anterior sobrevive.
  function reiniciarResultados() {
    ultimo = null; cacheMatriz = null; versionEstado++;
    var hj = $('#hojas'); if (hj) hj.innerHTML = '';
    geoCands = Object.create(null); candActual = null;
    var br = $('#busq-res'); if (br) br.innerHTML = '';
  }
  var dibujarDeb = debounce(function () { dibujarMapa(false); }, 120);
  function cambio(o) {
    o = o || {};
    versionEstado++;
    var hj = $('#hojas'); if (hj && hj.firstChild) hj.innerHTML = ''; // una hoja impresa nunca debe salir de un plan viejo
    if (ultimo && !ultimo.obsoleto) {
      ultimo.obsoleto = true;
      var st = $('#stale'); if (st) st.hidden = false;
      actualizarResumenMapa();
      o.mapa = true;
    }
    guardarLocalDeb();
    actualizarContadores();
    if (o.mapa !== false) dibujarDeb();
  }

  /* ===================== formulario ===================== */
  function llenarFormulario() {
    $$('[data-k]').forEach(function (el) {
      var v = getPath(estado, el.dataset.k);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v == null ? '' : v;
    });
    $$('.mon').forEach(function (s) { s.textContent = estado.moneda; });
    $$('[data-ej]').forEach(function (s) { s.hidden = !estado.esEjemplo; });
    $('#banner-ej').hidden = !estado.esEjemplo;
    $('#banner-ej2').hidden = !estado.esEjemplo;
    $('#nota-osrm').hidden = !estado.calles;
    renderParadas(); renderPeajes(); renderTipos(); renderTrafico(); actualizarContadores();
    aplicarFinUI();
  }
  // Selector «dónde termina cada ruta»: marca la opción, muestra el bloque del depósito final y lo que depende de él
  function aplicarFinUI() {
    var otro = estado.fin === 'otro';
    $$('input[name="fin"]').forEach(function (r) { r.checked = r.value === estado.fin; r.closest('.opcion-fin').classList.toggle('sel', r.checked); });
    $('#bloque-fin').hidden = !otro;
    $('#lbl-modo-fin').hidden = !otro;
    $('#ley-fin').hidden = !otro;
    if (!otro && modoClic === 'fin') setModo('parada');
  }

  function actualizarContadores() {
    var n = estado.paradas.length, dem = 0;
    estado.paradas.forEach(function (p) { dem += num(p.demanda, 0); });
    $('#cont-paradas').textContent = '— ' + n + (n === 1 ? ' parada' : ' paradas') + (dem ? ' · demanda total ' + fmt(dem, 0) : '');
  }

  var GEO_ETIQ = { dudosa: 'dirección dudosa: confirma', sin: 'sin resultado: corrige la dirección o ubícala en el mapa' };
  function renderParadas() {
    var tb = $('#tabla-paradas tbody');
    if (!estado.paradas.length) {
      tb.innerHTML = '<tr><td colspan="10" class="vacio">Aún no hay paradas. Busca una dirección, haz clic en el mapa, importa un CSV, pega desde Excel o pulsa “Cargar ejemplo”.</td></tr>';
      return;
    }
    tb.innerHTML = estado.paradas.map(function (p, i) {
      var id = esc(p.id), dud = p.geo === 'dudosa' || p.geo === 'sin';
      return '<tr data-i="' + i + '"' + (dud ? ' class="geo-dud"' : '') + '><td class="id">' + id + (dud ? '<br><span class="geo-tag" title="' + esc(GEO_ETIQ[p.geo]) + '">' + (p.geo === 'sin' ? 'sin ubicar' : 'revisar') + '</span>' : '') + '</td>' +
        '<td><input class="nom" data-f="nombre" aria-label="Nombre de ' + id + '" value="' + esc(p.nombre) + '" autocomplete="off"></td>' +
        '<td><input class="dir" data-f="dir" aria-label="Dirección de ' + id + '" value="' + esc(p.dir) + '" autocomplete="off" placeholder="(opcional)"></td>' +
        '<td><input data-f="lat" inputmode="decimal" aria-label="Latitud de ' + id + '" value="' + esc(p.lat) + '"></td>' +
        '<td><input data-f="lon" inputmode="decimal" aria-label="Longitud de ' + id + '" value="' + esc(p.lon) + '"></td>' +
        '<td><input data-f="demanda" type="number" min="0" step="any" aria-label="Demanda de ' + id + '" value="' + esc(p.demanda) + '"></td>' +
        '<td><input data-f="servicio" type="number" min="0" step="any" aria-label="Minutos de servicio de ' + id + '" value="' + esc(p.servicio) + '"></td>' +
        '<td><input data-f="ini" type="time" aria-label="Ventana desde de ' + id + '" value="' + esc(p.ini) + '"></td>' +
        '<td><input data-f="fin" type="time" aria-label="Ventana hasta de ' + id + '" value="' + esc(p.fin) + '"></td>' +
        '<td class="acc">' + (dud ? '<button class="mini" data-geo-elegir title="Ver otras opciones de esa dirección">Elegir…</button> ' + (p.geo === 'dudosa' ? '<button class="mini" data-geo-ok title="Confirmar el punto actual">✔</button> ' : '') : '') +
        '<button class="mini icono peligro" data-del aria-label="Quitar parada ' + id + '" title="Quitar">✕</button></td></tr>';
    }).join('');
  }

  function renderPeajes() {
    var tb = $('#tabla-peajes tbody');
    if (!estado.peajes.length) {
      tb.innerHTML = '<tr><td colspan="7" class="vacio">No hay peajes. Si tus rutas no pasan por peajes, déjalo así.</td></tr>';
      return;
    }
    tb.innerHTML = estado.peajes.map(function (p, i) {
      var id = esc(p.id);
      return '<tr data-i="' + i + '"><td class="id">' + id + '</td>' +
        '<td><input class="nom" data-f="nombre" aria-label="Nombre del peaje ' + id + '" value="' + esc(p.nombre) + '"></td>' +
        '<td><input data-f="lat" inputmode="decimal" aria-label="Latitud del peaje ' + id + '" value="' + esc(p.lat) + '"></td>' +
        '<td><input data-f="lon" inputmode="decimal" aria-label="Longitud del peaje ' + id + '" value="' + esc(p.lon) + '"></td>' +
        '<td><input data-f="costo" type="number" min="0" step="any" aria-label="Costo del peaje ' + id + '" value="' + esc(p.costo) + '"></td>' +
        '<td><input data-f="radio" type="number" min="1" step="any" aria-label="Radio en metros del peaje ' + id + '" value="' + esc(p.radio) + '"></td>' +
        '<td><button class="mini icono peligro" data-del aria-label="Quitar peaje ' + id + '" title="Quitar">✕</button></td></tr>';
    }).join('');
  }

  /* ----- tipos de vehículo ----- */
  function costoKmCalc(t) {
    var kg = num(t.calc.km_gal, NaN), pg = num(t.calc.precio_gal, NaN), d = num(t.calc.desgaste, 0);
    if (!(kg > 0) || !(pg >= 0)) return NaN;
    return pg / kg + d;
  }
  function textoCalcTipo(t) {
    var v = costoKmCalc(t);
    return isFinite(v) ? moneyTxt0(v, 3) + ' por km' : 'completa km por galón y precio por galón';
  }
  function moneyTxt0(n, d) { return estado.moneda + ' ' + fmt(n, d); }
  function renderTipos() {
    var cont = $('#tipos-lista');
    var multi = estado.flota.tipos.length > 1;
    function campo(i, et, f, tipo, extra) {
      var t = estado.flota.tipos[i], v = getPath(t, f);
      var idc = 't' + i + '-' + f.replace('.', '_');
      return '<div><label for="' + idc + '">' + et + '</label><input id="' + idc + '" data-f="' + f + '" type="' + (tipo || 'text') + '" ' + (extra || '') + ' value="' + esc(v) + '"></div>';
    }
    cont.innerHTML = estado.flota.tipos.map(function (t, i) {
      var auto = t.salida_modo === 'auto';
      var h = '<div class="tipo" data-i="' + i + '"><div class="tipo-cab"><h3>' + esc(t.nombre) + ' <small class="suave">' + esc(t.id) + '</small></h3>' +
        (multi ? '<button class="mini peligro" data-del-tipo>Quitar tipo</button>' : '') + '</div>';
      h += '<div class="grid">' +
        campo(i, 'Nombre', 'nombre', 'text', 'autocomplete="off"') +
        campo(i, 'Cantidad de vehículos', 'cantidad', 'number', 'min="1" step="1"') +
        campo(i, 'Capacidad <span class="ayuda">(misma unidad que la demanda; vacío = sin límite)</span>', 'capacidad', 'number', 'min="0" step="any"') +
        campo(i, 'Costo fijo por vehículo usado <span class="ayuda">(<span class="mon">' + esc(estado.moneda) + '</span>)</span>', 'costo_fijo', 'number', 'min="0" step="any"') +
        campo(i, 'Costo por km <span class="ayuda">(<span class="mon">' + esc(estado.moneda) + '</span> por km)</span>', 'costo_km', 'number', 'min="0" step="any"') +
        campo(i, 'Costo por hora de conductor <span class="ayuda">(<span class="mon">' + esc(estado.moneda) + '</span> por hora)</span>', 'costo_hora', 'number', 'min="0" step="any"') +
        campo(i, 'Jornada máxima <span class="ayuda">(horas; vacío = sin tope)</span>', 'jornada_h', 'number', 'min="0" step="any"') +
        '</div>';
      h += '<fieldset><legend>Hora de salida del depósito</legend><div class="grid">' +
        '<div><label for="t' + i + '-modo">Cómo se decide</label><select id="t' + i + '-modo" data-f="salida_modo">' +
        '<option value="fija"' + (auto ? '' : ' selected') + '>Hora fija (la eliges tú)</option>' +
        '<option value="auto"' + (auto ? ' selected' : '') + '>Que el programa elija la mejor</option></select></div>' +
        (auto
          ? campo(i, 'Salir desde', 'desde', 'time') + campo(i, 'Salir hasta', 'hasta', 'time') + campo(i, 'Probar cada (min)', 'paso', 'number', 'min="1" step="1"')
          : campo(i, 'Hora de salida', 'salida', 'time')) +
        '</div>' + (auto ? '<p class="ayuda">Cada ruta de este tipo sale a la hora, dentro del rango, que le cueste menos (por tráfico, esperas y horas pagadas).</p>' : '') + '</fieldset>';
      h += '<details><summary>Calculadora de costo por km (opcional)</summary><div class="grid" style="margin-top:6px">' +
        campo(i, 'Km por galón', 'calc.km_gal', 'number', 'min="0" step="any"') +
        campo(i, 'Precio por galón (<span class="mon">' + esc(estado.moneda) + '</span>)', 'calc.precio_gal', 'number', 'min="0" step="any"') +
        campo(i, 'Desgaste y mantenimiento por km (<span class="mon">' + esc(estado.moneda) + '</span>)', 'calc.desgaste', 'number', 'min="0" step="any"') +
        '</div><p>Resultado: <b class="calc-res">' + esc(textoCalcTipo(t)) + '</b></p>' +
        '<div class="acciones"><button class="mini" data-usar-calc>Usar como costo por km de este tipo</button></div>' +
        '<p class="ayuda">Precio por galón ÷ km por galón + desgaste por km. Los precios los pones tú: la aplicación no trae ninguno.</p></details>';
      return h + '</div>';
    }).join('');
  }


  /* ----- tráfico ----- */
  // Barras de tráfico: de Lichen claro (1.0, fluido) a ámbar (3.0, muy congestionado), mezcla lineal.
  function colorFactor(v) {
    var t = clamp((v - 1) / 2, 0, 1), c0 = [154, 169, 129], c1 = [220, 140, 70];
    return 'rgb(' + c0.map(function (c, i) { return Math.round(c + (c1[i] - c) * t); }).join(',') + ')';
  }
  function renderTrafico() {
    var cont = $('#traf-barras'), horas = $('#traf-horas');
    if (!cont.children.length) {
      var hb = '', hi = '';
      for (var h = 0; h < 24; h++) {
        hb += '<div class="hbar" data-h="' + h + '"><i><span></span></i></div>';
        hi += '<div><label for="th' + h + '">' + pad2(h) + ' h</label><input id="th' + h + '" type="number" min="1" max="3" step="0.1" data-th="' + h + '" aria-label="Factor de tráfico a las ' + pad2(h) + ':00"></div>';
      }
      cont.innerHTML = hb; horas.innerHTML = hi;
    }
    pintarTrafico();
  }
  function pintarTrafico() {
    for (var h = 0; h < 24; h++) {
      var v = estado.perfil[h];
      var bar = $('.hbar[data-h="' + h + '"] i');
      bar.style.height = Math.max(2, (v - 1) / 2 * 100) + '%';
      bar.style.background = colorFactor(v);
      bar.firstChild.textContent = v > 1 ? v.toFixed(1) : '';
      var inp = $('#th' + h);
      if (document.activeElement !== inp) inp.value = v.toFixed(1);
    }
  }
  function setFactor(h, v) {
    estado.perfil[h] = clamp(Math.round(v * 10) / 10, 1, 3);
    pintarTrafico(); cambio({ mapa: false });
  }
  function ponerPerfil(arr) {
    estado.perfil = arr.map(function (v) { return clamp(Math.round(v * 10) / 10, 1, 3); });
    pintarTrafico(); cambio({ mapa: false });
  }
  /* ===================== CSV / pegar desde Excel ===================== */
  function normClave(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }
  var ALIAS = {
    nombre: ['nombre', 'name', 'cliente', 'parada', 'punto'],
    lat: ['lat', 'latitud', 'latitude'],
    lon: ['lon', 'lng', 'long', 'longitud', 'longitude'],
    demanda: ['demanda', 'carga', 'peso', 'cantidad', 'demand'],
    servicio: ['servicio_min', 'servicio', 'tiempo_servicio', 'min_servicio'],
    ini: ['ventana_ini', 'ventana_inicio', 'ventana_desde', 'desde', 'inicio'],
    fin: ['ventana_fin', 'ventana_hasta', 'hasta', 'fin'],
    dir: ['direccion', 'dir', 'address', 'domicilio', 'direccion_completa']
  };
  function detectarDelim(texto) {
    var primera = (texto.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; })[0]) || '';
    var c = function (ch) { return primera.split(ch).length - 1; };
    var op = [['\t', c('\t')], [';', c(';')], [',', c(',')]];
    var mejor = op[0];
    op.forEach(function (x) { if (x[1] > mejor[1]) mejor = x; });
    return mejor[1] === 0 ? ',' : mejor[0];
  }
  function leerFilas(texto, d) {
    var filas = [], fila = [], cel = '', q = false;
    function cierraFila() {
      fila.push(cel); cel = '';
      if (fila.some(function (x) { return x.trim() !== ''; })) filas.push(fila);
      fila = [];
    }
    for (var i = 0; i < texto.length; i++) {
      var c = texto[i];
      if (q) {
        if (c === '"') { if (texto[i + 1] === '"') { cel += '"'; i++; } else q = false; } else cel += c;
      } else if (c === '"' && cel === '') q = true;
      else if (c === d) { fila.push(cel); cel = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && texto[i + 1] === '\n') i++; cierraFila(); }
      else cel += c;
    }
    cierraFila();
    return filas;
  }
  function normHora(s, avisos, etiqueta) {
    s = String(s == null ? '' : s).trim();
    if (!s) return '';
    var m = hhmm2min(s);
    if (m == null || m >= 1440) { avisos.push('Hora no válida “' + s + '” en ' + etiqueta + ' (se dejó vacía; usa HH:MM).'); return ''; }
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }
  function parsearTabla(texto) {
    texto = String(texto || '').replace(/^﻿/, '');
    var avisos = [], res = { paradas: [], deposito: null, depositoFinal: null, pendientes: [], avisos: avisos };
    if (!texto.trim()) { avisos.push('No hay datos para importar.'); return res; }
    var filas = leerFilas(texto, detectarDelim(texto));
    if (!filas.length) { avisos.push('No hay datos para importar.'); return res; }
    var cols = { nombre: 0, lat: 1, lon: 2, demanda: 3, servicio: 4, ini: 5, fin: 6 };
    var cab = filas[0].map(normClave), idx = Object.create(null);
    Object.keys(ALIAS).forEach(function (k) {
      for (var j = 0; j < cab.length; j++) if (ALIAS[k].indexOf(cab[j]) >= 0 && idx[k] == null) idx[k] = j;
    });
    var conCab = idx.lat != null && idx.lon != null;
    var soloDir = !conCab && idx.dir != null;   // CSV con direcciones pero sin coordenadas
    if (soloDir) {
      cols = Object.create(null);
      Object.keys(ALIAS).forEach(function (k) { cols[k] = idx[k] != null ? idx[k] : -1; });
      filas = filas.slice(1);
      filas.forEach(function (f, n) {
        var d = f[cols.dir] != null ? String(f[cols.dir]).trim() : '';
        if (!d) { avisos.push('Se omitió la fila ' + (n + 2) + ': sin dirección ni coordenadas.'); return; }
        var g = function (k) { var j = cols[k]; return j >= 0 && f[j] != null ? String(f[j]).trim() : ''; };
        var dem = num(g('demanda'), NaN), srv = num(g('servicio'), NaN);
        res.pendientes.push({
          nombre: g('nombre') || d.split(',')[0].slice(0, 40), dir: d, demanda: isFinite(dem) ? String(dem) : '', servicio: isFinite(srv) ? String(srv) : '10',
          ini: normHora(g('ini'), avisos, 'la fila ' + (n + 2)), fin: normHora(g('fin'), avisos, 'la fila ' + (n + 2))
        });
      });
      if (!res.pendientes.length) avisos.push('No se encontró ninguna dirección para buscar.');
      return res;
    }
    if (conCab) {
      cols = Object.create(null);
      Object.keys(ALIAS).forEach(function (k) { cols[k] = idx[k] != null ? idx[k] : -1; });
      filas = filas.slice(1);
    } else if (isNaN(num(filas[0][1], NaN)) && filas[0].length >= 3) {
      avisos.push('No reconocí los encabezados; se asumió el orden nombre, lat, lon, demanda, servicio_min, ventana_ini, ventana_fin.');
      filas = filas.slice(1);
    }
    function cel(f, k) { var j = cols[k]; return j >= 0 && j != null && f[j] != null ? String(f[j]).trim() : ''; }
    filas.forEach(function (f, n) {
      var et = 'la fila ' + (n + 1 + (conCab ? 1 : 0));
      var lat = num(cel(f, 'lat'), NaN), lon = num(cel(f, 'lon'), NaN);
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        avisos.push('Se omitió ' + et + ': latitud/longitud no válidas.'); return;
      }
      var nombre = cel(f, 'nombre');
      if (normClave(nombre) === 'deposito_final') { res.depositoFinal = { nombre: (cel(f, 'dir') || 'Depósito final').slice(0, 80), lat: String(lat), lon: String(lon) }; return; }
      if (normClave(nombre) === 'deposito') { res.deposito = { nombre: 'Depósito', lat: String(lat), lon: String(lon) }; return; }
      var dem = num(cel(f, 'demanda'), NaN), srv = num(cel(f, 'servicio'), NaN);
      res.paradas.push({
        nombre: nombre || 'Parada', dir: cel(f, 'dir').slice(0, 300), geo: '', lat: String(lat), lon: String(lon),
        demanda: isFinite(dem) ? String(dem) : '', servicio: isFinite(srv) ? String(srv) : '10',
        ini: normHora(cel(f, 'ini'), avisos, et), fin: normHora(cel(f, 'fin'), avisos, et)
      });
    });
    if (!res.paradas.length && !res.deposito && !res.depositoFinal) avisos.push('No se encontró ninguna parada válida. Revisa que haya columnas de latitud y longitud (o de dirección).');
    return res;
  }
  function importarTexto(texto, origen) {
    var r = parsearTabla(texto);
    var msgs = r.avisos.slice();
    if (!r.paradas.length && !r.deposito && !r.depositoFinal && !r.pendientes.length) { mostrarMensajes([], msgs, 'No se importó nada.'); return; }
    var modo = ($('input[name="modo-imp"]:checked') || {}).value || 'reemplazar';
    if (modo === 'reemplazar') {
      if (estado.esEjemplo) {
        if (!confirm('Esto reemplaza el EJEMPLO completo (paradas, costos y peajes de ejemplo). ¿Continuar?')) return;
        var csvSep = estado.csvSep;
        estado = estadoVacio(); estado.csvSep = csvSep;
        reiniciarResultados(); renderResultados();
      } else if (estado.paradas.length && !confirm('Se reemplazarán las ' + estado.paradas.length + ' paradas actuales. ¿Continuar?')) return;
      estado.paradas = []; estado.sigC = 1; geoCands = Object.create(null);
    }
    if (r.deposito) { estado.deposito.nombre = r.deposito.nombre; estado.deposito.lat = r.deposito.lat; estado.deposito.lon = r.deposito.lon; }
    if (r.depositoFinal) {   // fila DEPOSITO_FINAL: el archivo trae un depósito final distinto; se carga y la ruta termina ahí
      estado.depositoFinal.nombre = r.depositoFinal.nombre; estado.depositoFinal.lat = r.depositoFinal.lat; estado.depositoFinal.lon = r.depositoFinal.lon;
      estado.fin = 'otro'; msgs.push('El archivo trae un depósito final (“' + r.depositoFinal.nombre + '”): se cargó y cada ruta termina allí. Cambia la opción “Dónde termina cada ruta” si no es lo que quieres.');
    }
    var cupo = Math.max(0, MAX_PARADAS - estado.paradas.length), antes = r.paradas.length + r.pendientes.length;
    if (antes > cupo) {
      r.paradas = r.paradas.slice(0, cupo);
      r.pendientes = r.pendientes.slice(0, Math.max(0, cupo - r.paradas.length));
      msgs.push('El archivo trae ' + antes + ' paradas, pero el máximo es ' + MAX_PARADAS + ': solo se importaron las primeras ' + (r.paradas.length + r.pendientes.length) + '. El resto se ignoró.');
    }
    r.paradas.forEach(function (p) { p.id = 'C' + (estado.sigC++); estado.paradas.push(p); });
    llenarFormulario(); cambio();
    dibujarMapa(true);
    mostrarMensajes([], msgs, null);
    if (r.pendientes.length) { geocodificarLista(r.pendientes); return; }
    toast('Importadas ' + r.paradas.length + ' paradas' + (r.deposito ? ' y el depósito' : '') + (r.depositoFinal ? ' y el depósito final' : '') + ' (' + origen + ').' + (!isFinite(num(estado.deposito.lat, NaN)) ? ' Falta ubicar el depósito.' : ''));
  }
  function csvCelda(v, sep) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s.replace(',', '.')))) s = "'" + s; // evita fórmulas al abrir en Excel
    if (s.indexOf(sep) >= 0 || /["\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function numCsv(n, dec, sep) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    var s = String(Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec));
    return sep === ';' ? s.replace('.', ',') : s;
  }
  function filaCsv(arr, sep) { return arr.map(function (v) { return csvCelda(v, sep); }).join(sep); }
  function exportarParadasCSV() {
    var sep = estado.csvSep === ';' ? ';' : ',';
    var L = [filaCsv(['nombre', 'lat', 'lon', 'demanda', 'servicio_min', 'ventana_ini', 'ventana_fin', 'direccion'], sep)];
    if (estado.esEjemplo) L.push(filaCsv(['EJEMPLO - datos ficticios', '', '', '', '', '', '', ''], sep));
    var d = estado.deposito;
    L.push(filaCsv(['DEPOSITO', d.lat, d.lon, '', '', '', '', ''].map(function (v, i) { return i === 0 ? v : (sep === ';' ? String(v).replace('.', ',') : v); }), sep));
    if (estado.fin === 'otro') {   // depósito final: el nombre va en «direccion» para poder reimportarlo
      var df = estado.depositoFinal;
      L.push(filaCsv(['DEPOSITO_FINAL', df.lat, df.lon, '', '', '', '', df.nombre || ''].map(function (v, i) { return (i === 1 || i === 2) && sep === ';' ? String(v).replace('.', ',') : v; }), sep));
    }
    estado.paradas.forEach(function (p) {
      L.push(filaCsv([p.nombre, p.lat, p.lon, p.demanda, p.servicio, p.ini, p.fin, p.dir || ''].map(function (v, i) { return (i >= 1 && i <= 4 && sep === ';') ? String(v).replace('.', ',') : v; }), sep));
    });
    descargar('paradas.csv', '﻿' + L.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
  }
  function nombreVeh(r) { return r.vehiculo_nombre || ('Vehículo ' + r.vehiculo); }
  function exportarPlanCSV() {
    if (!ultimo) return;
    var sep = estado.csvSep === ';' ? ';' : ',';
    var pr = ultimo.problema, mp = new Map(pr.paradas.map(function (p) { return [p.id, p]; }));
    var cab = ['vehiculo', 'tipo', 'orden', 'id', 'nombre', 'lat', 'lon', 'demanda', 'llegada', 'espera_min', 'inicio_atencion', 'salida', 'km_tramo', 'min_tramo', 'peaje_tramo', 'motivo_no_atendida'];
    var L = [filaCsv(cab, sep)];
    function vacias(n) { var a = []; for (var q = 0; q < n; q++) a.push(''); return a; }
    if (estado.esEjemplo) L.push(filaCsv(['EJEMPLO - datos ficticios'].concat(vacias(cab.length - 1)), sep));
    ultimo.resultado.rutas.forEach(function (r) {
      var nv = nombreVeh(r), tp = r.tipo_nombre || '';
      L.push(filaCsv([nv, tp, 0, 'DEP', pr.deposito.nombre, numCsv(pr.deposito.lat, 6, sep), numCsv(pr.deposito.lon, 6, sep), '', '', '', '', min2hhmm(r.salida_deposito_min), '', '', '', ''], sep));
      r.paradas.forEach(function (s, i) {
        var p = mp.get(s.id) || {};
        L.push(filaCsv([nv, tp, i + 1, s.id, s.nombre, numCsv(p.lat, 6, sep), numCsv(p.lon, 6, sep), numCsv(p.demanda, 2, sep), min2hhmm(s.llegada_min), numCsv(s.espera_min, 1, sep), min2hhmm(s.inicio_servicio_min), min2hhmm(s.salida_min), numCsv(s.km_tramo, 2, sep), numCsv(s.min_tramo, 1, sep), numCsv(s.peaje_tramo, 2, sep), ''], sep));
      });
      var ff = finDe(pr);
      if (ff === 'deposito') L.push(filaCsv([nv, tp, r.paradas.length + 1, 'DEP', pr.deposito.nombre, '', '', '', min2hhmm(r.regreso_min), '', '', '', '', '', '', ''], sep));
      else if (ff === 'otro' && pr.deposito_final) L.push(filaCsv([nv, tp, r.paradas.length + 1, 'FIN', pr.deposito_final.nombre, numCsv(pr.deposito_final.lat, 6, sep), numCsv(pr.deposito_final.lon, 6, sep), '', min2hhmm(r.regreso_min), '', '', '', '', '', '', ''], sep));
    });
    ultimo.resultado.no_atendidas.forEach(function (n) {
      var p = mp.get(n.id) || {};
      L.push(filaCsv(['NO ATENDIDA', '', '', n.id, p.nombre || '', numCsv(p.lat, 6, sep), numCsv(p.lon, 6, sep), numCsv(p.demanda, 2, sep), '', '', '', '', '', '', '', n.motivo], sep));
    });
    descargar('plan-de-rutas.csv', '\uFEFF' + L.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
  }

  /* ===================== proyecto JSON ===================== */
  function guardarProyecto() {
    descargar('proyecto-rutas.json', JSON.stringify({ app: 'optimizador-rutas', version: ESTADO_VERSION, estado: estado }, null, 1), 'application/json');
    toast('Proyecto descargado como proyecto-rutas.json');
  }
  function cargarProyecto(archivo) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var o = JSON.parse(fr.result);
        if (!o || typeof o !== 'object' || !o.estado) throw new Error('forma');
        var verOrig = typeof o.estado.version === 'number' ? o.estado.version : 1;
        var nOrig = Array.isArray(o.estado.paradas) ? o.estado.paradas.length : 0;
        estado = normalizarEstado(o.estado);
        reiniciarResultados();
        llenarFormulario(); renderResultados(); renderFlete(); dibujarMapa(true); guardarLocal();
        toast((nOrig > MAX_PARADAS ? 'El proyecto traía ' + nOrig + ' paradas; solo se cargaron las primeras ' + MAX_PARADAS + '. ' : '') + (verOrig < ESTADO_VERSION ? 'Proyecto de una versión anterior cargado: tu flota pasó a un solo tipo de vehículo y se activaron las calles reales. Revisa “Flota y costos”.' : 'Proyecto cargado.'));
      } catch (e) {
        mostrarMensajes([e && e.name === 'SyntaxError'
          ? 'No se pudo abrir el archivo: no es un JSON válido (puede estar incompleto o dañado). Abre un archivo .json que hayas guardado con “Guardar proyecto”.'
          : 'Ese archivo no parece un proyecto guardado por esta aplicación (.json). Abre uno que hayas guardado con “Guardar proyecto”.'], [], null);
      }
    };
    fr.onerror = function () { mostrarMensajes(['No se pudo leer el archivo.'], [], null); };
    fr.readAsText(archivo);
  }

  /* ===================== mapa ===================== */
  function icono(cls, txt, color, size) {
    return L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: '<div class="mk ' + cls + '"' + (color ? ' style="--c:' + color + '"' : '') + '>' + esc(txt) + '</div>'
    });
  }
  function initMapa() {
    if (!window.L) { $('#mapa').innerHTML = '<p class="vacio">No se pudo cargar el mapa (falta lib/leaflet.js).</p>'; return; }
    mapa = L.map('mapa', { zoomControl: true }).setView([-12.06, -77.03], 11);
    var tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(mapa);
    tiles.on('tileerror', function () { $('#aviso-teselas').hidden = false; });
    tiles.on('tileload', function () { $('#aviso-teselas').hidden = true; });
    capaLineas = L.layerGroup().addTo(mapa);
    capaMarc = L.layerGroup().addTo(mapa);
    mapa.on('click', clicEnMapa);
    window.addEventListener('resize', debounce(function () { mapa.invalidateSize(); }, 150));
    setTimeout(function () { mapa.invalidateSize(); }, 300);
  }
  function r6(x) { return Math.round(x * 1e6) / 1e6; }
  function setModo(m) {
    modoClic = m;
    $$('input[name="modo-mapa"]').forEach(function (r) { r.checked = r.value === m; });
    $('#mapa').classList.toggle('modo-clic', m !== 'nada');
  }
  function clicEnMapa(e) {
    var lat = r6(e.latlng.lat), lon = r6(e.latlng.lng);
    if (ultimo && !ultimo.obsoleto && modoClic !== 'nada') {
      toast('Cambiar los datos hará que el resultado actual quede desactualizado: vuelve a optimizar.');
    }
    if (modoClic === 'parada') {
      if (estado.paradas.length >= MAX_PARADAS) { toast(msgTopeParadas() + ' No se agregó la parada.'); return; }
      var id = 'C' + (estado.sigC++);
      estado.paradas.push({ id: id, nombre: 'Parada ' + id, dir: '', lat: String(lat), lon: String(lon), demanda: '', servicio: '10', ini: '', fin: '', geo: '' });
      renderParadas(); cambio();
      var sc = $('#tabla-paradas').parentNode; sc.scrollTop = sc.scrollHeight;
      toast('Parada ' + id + ' agregada. Edita su nombre y demanda en la tabla.');
    } else if (modoClic === 'deposito') {
      estado.deposito.lat = String(lat); estado.deposito.lon = String(lon);
      $('#dep-lat').value = estado.deposito.lat; $('#dep-lon').value = estado.deposito.lon;
      cambio();
      toast('Depósito ubicado.');
      setModo('parada');
    } else if (modoClic === 'fin') {
      estado.depositoFinal.lat = String(lat); estado.depositoFinal.lon = String(lon);
      $('#fin-lat').value = estado.depositoFinal.lat; $('#fin-lon').value = estado.depositoFinal.lon;
      cambio();
      toast('Depósito final ubicado.');
      setModo('parada');
    } else if (modoClic === 'peaje') {
      var pid = 'P' + (estado.sigP++);
      estado.peajes.push({ id: pid, nombre: 'Peaje ' + pid, lat: String(lat), lon: String(lon), costo: '', radio: '300' });
      renderPeajes(); cambio();
      toast('Peaje ' + pid + ' agregado: escribe su tarifa en la pestaña “3 Peajes”.');
    }
  }
  function popupHtml(titulo, lineas) {
    return '<b>' + esc(titulo) + '</b>' + lineas.map(function (l) { return '<br>' + esc(l); }).join('');
  }
  function dibujarMapa(ajustar) {
    if (!mapa) return;
    capaLineas.clearLayers(); capaMarc.clearLayers();
    var pts = [];
    var vista = ultimo && !ultimo.obsoleto ? ultimo : null;

    if (vista) {
      var pr = vista.problema, res = vista.resultado, mp = new Map(pr.paradas.map(function (p) { return [p.id, p]; }));
      var dep = [pr.deposito.lat, pr.deposito.lon];
      pts.push(dep);
      (pr.peajes || []).forEach(function (pe) { marcarPeaje(pe.lat, pe.lon, pe.nombre, pe.costo, pe.radio_m, false, pts); });
      res.rutas.forEach(function (r, k) {
        var col = COLORES[k % COLORES.length], nv = nombreVeh(r);
        var seq = [dep];
        r.paradas.forEach(function (s) { var p = mp.get(s.id); if (p) seq.push([p.lat, p.lon]); });
        if (finDe(pr) === 'deposito') seq.push(dep);
        else if (finDe(pr) === 'otro' && pr.deposito_final) seq.push([pr.deposito_final.lat, pr.deposito_final.lon]);
        var legs = vista.legs && vista.legs[k];
        for (var t = 0; t < seq.length - 1; t++) {
          var geom = legs && legs[t] && legs[t].geom;
          var trazo = geom || [seq[t], seq[t + 1]], dash = geom ? null : '9 7';
          L.polyline(trazo, { color: '#18210c', weight: geom ? 9 : 8, opacity: .85, dashArray: dash, interactive: false }).addTo(capaLineas);
          L.polyline(trazo, { color: col, weight: geom ? 5 : 4, opacity: 1, dashArray: dash })
            .bindTooltip(esc(nv + (geom ? ' (calles reales)' : ' (línea recta, aprox.)')), { sticky: true }).addTo(capaLineas);
        }
        r.paradas.forEach(function (s, i) {
          var p = mp.get(s.id); if (!p) return;
          pts.push([p.lat, p.lon]);
          L.marker([p.lat, p.lon], { icon: icono('mk-parada con-ruta', String(i + 1), col, 26), title: s.nombre })
            .bindPopup(popupHtml(s.nombre, [nv + ' · parada ' + (i + 1), 'Llega ' + min2hhmm(s.llegada_min) + (s.espera_min > 0.5 ? ' (espera ' + Math.round(s.espera_min) + ' min)' : ''), 'Atiende ' + min2hhmm(s.inicio_servicio_min) + ' · sale ' + min2hhmm(s.salida_min)]))
            .addTo(capaMarc);
        });
      });
      res.no_atendidas.forEach(function (n) {
        var p = mp.get(n.id); if (!p) return;
        pts.push([p.lat, p.lon]);
        L.marker([p.lat, p.lon], { icon: icono('mk-parada sin', '×', '', 26), title: p.nombre })
          .bindPopup(popupHtml(p.nombre, ['NO ATENDIDA', n.motivo])).addTo(capaMarc);
      });
      L.marker(dep, { icon: icono('mk-dep', 'D', '', 30), title: pr.deposito.nombre, zIndexOffset: 500 })
        .bindPopup(popupHtml(pr.deposito.nombre, ['Depósito de salida'])).addTo(capaMarc);
      if (finDe(pr) === 'otro' && pr.deposito_final) {
        pts.push([pr.deposito_final.lat, pr.deposito_final.lon]);
        L.marker([pr.deposito_final.lat, pr.deposito_final.lon], { icon: icono('mk-fin', 'F', '', 30), title: pr.deposito_final.nombre, zIndexOffset: 450 })
          .bindPopup(popupHtml(pr.deposito_final.nombre, ['Depósito final (las rutas terminan aquí)'])).addTo(capaMarc);
      }
    } else {
      var dlat = num(estado.deposito.lat, NaN), dlon = num(estado.deposito.lon, NaN);
      if (isFinite(dlat) && isFinite(dlon)) {
        pts.push([dlat, dlon]);
        L.marker([dlat, dlon], { icon: icono('mk-dep', 'D', '', 30), draggable: true, title: estado.deposito.nombre, zIndexOffset: 500 })
          .bindPopup(popupHtml(estado.deposito.nombre || 'Depósito', ['Depósito de salida', 'Arrástralo para moverlo']))
          .on('dragend', function (ev) {
            var ll = ev.target.getLatLng();
            estado.deposito.lat = String(r6(ll.lat)); estado.deposito.lon = String(r6(ll.lng));
            $('#dep-lat').value = estado.deposito.lat; $('#dep-lon').value = estado.deposito.lon;
            cambio();
          }).addTo(capaMarc);
      }
      if (estado.fin === 'otro') {
        var fla = num(estado.depositoFinal.lat, NaN), flo = num(estado.depositoFinal.lon, NaN);
        if (isFinite(fla) && isFinite(flo)) {
          pts.push([fla, flo]);
          L.marker([fla, flo], { icon: icono('mk-fin', 'F', '', 30), draggable: true, title: estado.depositoFinal.nombre, zIndexOffset: 450 })
            .bindPopup(popupHtml(estado.depositoFinal.nombre || 'Depósito final', ['Depósito final', 'Arrástralo para moverlo']))
            .on('dragend', function (ev) {
              var ll = ev.target.getLatLng();
              estado.depositoFinal.lat = String(r6(ll.lat)); estado.depositoFinal.lon = String(r6(ll.lng));
              $('#fin-lat').value = estado.depositoFinal.lat; $('#fin-lon').value = estado.depositoFinal.lon;
              cambio();
            }).addTo(capaMarc);
        }
      }
      estado.paradas.forEach(function (p, i) {
        var la = num(p.lat, NaN), lo = num(p.lon, NaN);
        if (!isFinite(la) || !isFinite(lo)) return;
        pts.push([la, lo]);
        L.marker([la, lo], { icon: icono('mk-parada' + (p.geo === 'dudosa' ? ' dud' : ''), String(i + 1), '', 26), draggable: true, title: p.nombre })
          .bindPopup(popupHtml(p.nombre || p.id, [p.id + (p.demanda ? ' · demanda ' + p.demanda : ''), p.dir || '', 'Arrástrala para moverla'].filter(Boolean)))
          .on('dragend', function (ev) {
            var ll = ev.target.getLatLng();
            p.lat = String(r6(ll.lat)); p.lon = String(r6(ll.lng));
            p.geo = p.geo === 'ok' ? 'ok' : '';
            var tr = $('#tabla-paradas tbody tr[data-i="' + i + '"]');
            if (tr) { tr.querySelector('[data-f="lat"]').value = p.lat; tr.querySelector('[data-f="lon"]').value = p.lon; }
            cambio();
          }).addTo(capaMarc);
      });
      estado.peajes.forEach(function (pe, i) {
        var la = num(pe.lat, NaN), lo = num(pe.lon, NaN);
        if (!isFinite(la) || !isFinite(lo)) return;
        marcarPeaje(la, lo, pe.nombre || pe.id, num(pe.costo, 0), num(pe.radio, 300), true, pts, function (ll) {
          pe.lat = String(r6(ll.lat)); pe.lon = String(r6(ll.lng));
          var tr = $('#tabla-peajes tbody tr[data-i="' + i + '"]');
          if (tr) { tr.querySelector('[data-f="lat"]').value = pe.lat; tr.querySelector('[data-f="lon"]').value = pe.lon; }
          cambio();
        });
      });
    }
    if (ajustar && pts.length) {
      try { mapa.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15 }); } catch (e) { /* sin puntos válidos */ }
    }
  }
  function marcarPeaje(lat, lon, nombre, costo, radio, arrastrable, pts, alMover) {
    pts.push([lat, lon]);
    if (radio > 0) L.circle([lat, lon], { radius: radio, color: '#18210c', weight: 1, dashArray: '4 4', fillOpacity: .1, interactive: false }).addTo(capaLineas);
    var m = L.marker([lat, lon], { icon: icono('mk-peaje', 'P', '', 22), draggable: !!arrastrable, title: nombre })
      .bindPopup(popupHtml(nombre, ['Peaje · ' + moneyTxt(costo || 0)]));
    if (alMover) m.on('dragend', function (ev) { alMover(ev.target.getLatLng()); });
    m.addTo(capaMarc);
  }

  /* ===================== problema, validación ===================== */
  // El motor v1.1 trae calcularFlete; el v1.0 no. Con v1.0 la flota se aplana a un solo tipo (y se avisa).
  function esMotor11() { return !!(Motor && typeof Motor.calcularFlete === 'function'); }
  function totalVehiculos(pr) {
    if (pr.flota.tipos) return pr.flota.tipos.reduce(function (a, t) { return a + t.cantidad; }, 0);
    return pr.flota.vehiculos_max || 0;
  }
  function paraMotor(pr) {
    if (esMotor11() || !pr.flota.tipos) return pr;
    var t = pr.flota.tipos[0], c = {};
    Object.keys(pr).forEach(function (k) { c[k] = pr[k]; });
    var f = { vehiculos_max: totalVehiculos(pr), costo_fijo: t.costo_fijo, costo_km: t.costo_km, costo_hora: t.costo_hora };
    if (t.capacidad > 0) f.capacidad = t.capacidad;
    if (t.jornada_max_min > 0) f.jornada_max_min = t.jornada_max_min;
    c.flota = f;
    if (t.salida_modo === 'fija' && typeof t.salida_min === 'number') c.salida_min = t.salida_min;
    delete c.equilibrio;
    return c;
  }
  function construirProblema() {
    var E = estado;
    var m11 = esMotor11();
    var tipos = E.flota.tipos.map(function (t, i) {
      var cap = num(t.capacidad, 0), jor = num(t.jornada_h, 0);
      var o = {
        id: t.id, nombre: t.nombre || ('Vehículo ' + (i + 1)), cantidad: Math.max(1, Math.floor(num(t.cantidad, 1))),
        costo_fijo: num(t.costo_fijo, 0), costo_km: num(t.costo_km, 0), costo_hora: num(t.costo_hora, 0)
      };
      if (cap > 0) o.capacidad = cap;
      if (jor > 0) o.jornada_max_min = Math.round(jor * 60);
      if (t.salida_modo === 'auto') {
        var d = hhmm2min(t.desde), h = hhmm2min(t.hasta);
        o.salida_modo = 'auto';
        o.salida_desde_min = d == null ? 360 : d;
        o.salida_hasta_min = h == null ? 540 : h;
        o.salida_paso_min = Math.max(1, Math.round(num(t.paso, 10)));
      } else {
        o.salida_modo = 'fija';
        var s = hhmm2min(t.salida);
        o.salida_min = s == null ? 480 : s;
      }
      return o;
    });
    var primeraFija = tipos.filter(function (t) { return t.salida_modo === 'fija'; })[0];
    var problema = {
      deposito: { id: 'DEP', nombre: E.deposito.nombre || 'Depósito', lat: num(E.deposito.lat, NaN), lon: num(E.deposito.lon, NaN) },
      paradas: E.paradas.map(function (p) {
        var a = hhmm2min(p.ini), b = hhmm2min(p.fin), v = null;
        if (a != null && b != null) v = [a, (b < a && !m11) ? b + 1440 : b];   // b < a = cruza medianoche (el motor v1.1 lo interpreta)
        else if (a != null) v = [a, 1440];
        else if (b != null) v = [0, b];
        return { id: p.id, nombre: p.nombre || p.id, lat: num(p.lat, NaN), lon: num(p.lon, NaN), demanda: num(p.demanda, 0), servicio_min: num(p.servicio, 10), ventana: v };
      }),
      flota: { tipos: tipos },
      salida_min: primeraFija ? primeraFija.salida_min : 480,
      fin: E.fin,
      trafico: { perfil: E.perfil.slice() },
      peajes: E.peajes.filter(function (p) { return isFinite(num(p.lat, NaN)) && isFinite(num(p.lon, NaN)); }).map(function (p) {
        return { id: p.id, nombre: p.nombre || p.id, lat: num(p.lat, 0), lon: num(p.lon, 0), costo: num(p.costo, 0), radio_m: num(p.radio, 300) };
      }),
      objetivo: E.objetivo,
      peso_peaje: num(E.peso_peaje, 1),
      equilibrio: clamp(num(E.equilibrio, 0), 0, 1),
      estimacion: { circuidad: clamp(num(E.est.circuidad, 1.35), 1, 3), velocidad_kmh: clamp(num(E.est.velocidad, 35), 5, 120) }
    };
    // compatibilidad: el motor 1.1 solo conoce retorno_deposito; el 1.2 usa fin (y deposito_final cuando es «otro»)
    if (E.fin === 'ultima') problema.retorno_deposito = false;
    else if (E.fin === 'deposito') problema.retorno_deposito = true;
    if (E.fin === 'otro') problema.deposito_final = { id: 'FIN', nombre: E.depositoFinal.nombre || 'Depósito final', lat: num(E.depositoFinal.lat, NaN), lon: num(E.depositoFinal.lon, NaN) };
    return problema;
  }
  function motorVer() { var m = /^(\d+)\.(\d+)/.exec(String((Motor && Motor.VERSION) || '')); return m ? [+m[1], +m[2]] : [0, 0]; }
  // Textos según dónde termina la ruta (todo lo que venga del usuario se escapa al armar el HTML)
  function nomFin(pr) { return (pr.deposito_final && pr.deposito_final.nombre) || 'Depósito final'; }
  function txtFin(pr) {
    var f = finDe(pr);
    if (f === 'otro') return { f: f, fila: 'Llega al depósito final: ' + nomFin(pr), corto: 'llegada al depósito final', largo: 'Llegada estimada al depósito final (' + nomFin(pr) + ')' };
    if (f === 'ultima') return { f: f, fila: '', corto: 'fin en la última parada', largo: 'Fin estimado de la ruta (en la última parada)' };
    return { f: f, fila: 'Regresa al depósito', corto: 'regreso', largo: 'Regreso estimado' };
  }
  function esMotor12() { var v = motorVer(); return v[0] > 1 || (v[0] === 1 && v[1] >= 2); }
  function finDe(pr) { return pr.fin === 'otro' || pr.fin === 'ultima' ? pr.fin : (pr.retorno_deposito === false ? 'ultima' : 'deposito'); }
  function validarTodo(pr) {
    var errores = [], avisos = [], E = estado;
    if (!isFinite(pr.deposito.lat) || !isFinite(pr.deposito.lon)) errores.push('Falta ubicar el depósito: busca su dirección, escribe su latitud y longitud, o elige “Ubicar depósito” sobre el mapa y haz clic.');
    if (E.fin === 'otro') {
      var fl = pr.deposito_final.lat, fo = pr.deposito_final.lon;
      if (!isFinite(fl) || !isFinite(fo)) errores.push('Falta ubicar el depósito final: busca su dirección, escribe su latitud y longitud, o usa “Ubicar con un clic en el mapa” en “Datos”.');
      else if (Math.abs(fl) > 90 || Math.abs(fo) > 180) errores.push('El depósito final tiene coordenadas fuera de rango.');
      else if (isFinite(pr.deposito.lat) && Math.abs(fl - pr.deposito.lat) < 1e-6 && Math.abs(fo - pr.deposito.lon) < 1e-6) avisos.push('El depósito final está en el mismo punto que el de salida: es lo mismo que “Regresa al mismo depósito”.');
      if (!esMotor12()) errores.push('Esta copia de motor.js (versión ' + ((Motor && Motor.VERSION) || '?') + ') no admite “Termina en otro depósito”. Actualiza motor.js a la versión 1.2 o elige otra opción.');
    }
    if (!E.paradas.length) errores.push('Agrega al menos una parada (dirección, clic en el mapa, importar CSV o “Cargar ejemplo”).');
    E.paradas.forEach(function (p) {
      var la = num(p.lat, NaN), lo = num(p.lon, NaN), n = (p.nombre || p.id);
      if (!isFinite(la) || !isFinite(lo)) errores.push('La parada ' + p.id + ' (' + n + ') no tiene latitud/longitud válidas' + (p.geo === 'sin' ? ' (la dirección no se encontró: corrígela con “Elegir…” o ubícala en el mapa)' : '') + '.');
      else if (Math.abs(la) > 90 || Math.abs(lo) > 180) errores.push('La parada ' + p.id + ' (' + n + ') tiene coordenadas fuera de rango.');
      else if (la > 0 && lo < 0 && Math.abs(la) > 60 && Math.abs(lo) < 60) avisos.push('La parada ' + p.id + ' (' + n + '): ¿latitud y longitud están invertidas?');
      if (p.geo === 'dudosa') avisos.push('La parada ' + p.id + ' (' + n + ') tiene una dirección dudosa: confirma que el punto del mapa es el correcto.');
      var a = hhmm2min(p.ini), b = hhmm2min(p.fin);
      if (a != null && b != null && b < a) avisos.push('La parada ' + p.id + ' (' + n + '): la ventana cruza la medianoche (' + p.ini + ' → ' + p.fin + ' (+1)). Si no era lo que querías, revisa “Desde” y “Hasta”.');
      if (num(p.demanda, 0) < 0) errores.push('La parada ' + p.id + ' tiene demanda negativa.');
    });
    E.peajes.forEach(function (p) {
      if (!isFinite(num(p.lat, NaN)) || !isFinite(num(p.lon, NaN))) avisos.push('El peaje ' + p.id + ' no tiene ubicación válida: se ignorará.');
      else if (p.costo === '' || !isFinite(num(p.costo, NaN))) avisos.push('El peaje ' + p.id + ' no tiene tarifa válida: se asume 0.');
    });
    var tipos = pr.flota.tipos || [];
    if (!tipos.length || totalVehiculos(pr) < 1) errores.push('Indica al menos 1 vehículo en “Flota y costos”.');
    E.flota.tipos.forEach(function (t, i) {
      var n = t.nombre || ('tipo ' + (i + 1)), o = tipos[i];
      if (!o) return;
      if (!(num(t.cantidad, 0) >= 1)) errores.push('El tipo “' + n + '” necesita una cantidad de vehículos de 1 o más.');
      if (t.salida_modo === 'auto') {
        var d = hhmm2min(t.desde), h = hhmm2min(t.hasta);
        if (d == null || h == null) errores.push('El tipo “' + n + '”: indica el rango “Salir desde / hasta” para la salida automática.');
        else if (h < d) errores.push('El tipo “' + n + '”: “Salir hasta” no puede ser anterior a “Salir desde”.');
        if (!(num(t.paso, 10) >= 1)) errores.push('El tipo “' + n + '”: el paso de la salida automática debe ser de 1 minuto o más.');
      } else if (hhmm2min(t.salida) == null) avisos.push('El tipo “' + n + '” no tiene hora de salida válida: se usa 08:00.');
      if (!(o.capacidad > 0)) avisos.push('El tipo “' + n + '” no tiene capacidad: se asume que carga lo que sea (sin límite).');
      if (!(o.costo_km > 0)) avisos.push('El tipo “' + n + '” tiene el costo por km vacío o en 0: los kilómetros no sumarán al costo. Usa la calculadora en “Flota y costos”.');
      if (!(o.jornada_max_min > 0)) avisos.push('El tipo “' + n + '” no tiene jornada máxima: no se limitará la duración de sus rutas.');
    });
    if (tipos.length && tipos.every(function (t) { return t.capacidad > 0; }) && E.paradas.every(function (p) { return !(num(p.demanda, 0) > 0); })) avisos.push('Hay capacidad pero ninguna parada tiene demanda: la capacidad no limitará nada.');
    if (!esMotor11() && tipos.length > 1) avisos.push('Este motor (v' + ((Motor && Motor.VERSION) || '?') + ') solo admite un tipo de vehículo: se usa el primero (' + (tipos[0].nombre) + ') para todos.');
    // mismo conteo que prepararMatriz (salida + paradas + depósito final si termina en otro depósito)
    var nPuntos = puntosDe(pr).length;
    if (E.calles && nPuntos > MAX_PUNTOS_OSRM) avisos.push('Con más de ' + MAX_PUNTOS_OSRM + ' puntos (' + nPuntos + ' contando el depósito de salida' + (E.fin === 'otro' ? ' y el final' : '') + ') las calles reales tardarían demasiado en el servidor público: se usará la estimación en línea recta.');
    else if (E.calles && nPuntos > 100) avisos.push('Con más de 100 puntos (' + nPuntos + ') las distancias por calles se piden al servidor público por bloques (una consulta por segundo): puede tardar uno o dos minutos.');
    // la parada «FIN» chocaría con el id interno del depósito final
    if (E.fin === 'otro') E.paradas.forEach(function (p) {
      if (String(p.id).trim().toUpperCase() === 'FIN') errores.push('La parada ' + p.id + ' (' + (p.nombre || p.id) + ') tiene el código “FIN”, que usa el depósito final. Cámbiale el código o el nombre (por ejemplo “P12”).');
      else if (String(p.nombre || '').trim().toUpperCase() === 'FIN') avisos.push('La parada ' + p.id + ' se llama “FIN” y puede confundirse con el depósito final. Conviene renombrarla (por ejemplo “Cliente FIN”).');
    });
    if (!errores.length && Motor) {
      try {
        var v = Motor.validar(paraMotor(pr));
        (v.errores || []).forEach(function (m) { if (errores.indexOf(m) < 0) errores.push(m); });
        (v.avisos || []).forEach(function (m) {
          // «mismo punto que el de salida»: ya lo avisó la interfaz; el motor dice lo mismo con otras palabras (un solo aviso)
          if (/mismas coordenadas que el de salida/.test(m) && avisos.some(function (a) { return /mismo punto que el de salida/.test(a); })) return;
          if (avisos.indexOf(m) < 0) avisos.push(m);
        });
      } catch (e) { avisos.push('No se pudo ejecutar la validación del motor: ' + e.message); }
    }
    return { ok: errores.length === 0, errores: errores, avisos: avisos };
  }
  function mostrarMensajes(errores, avisos, info) {
    var h = '';
    if (errores.length) h += '<div class="msg error"><b>Corrige esto antes de continuar:</b><ul>' + errores.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></div>';
    if (avisos.length) h += '<div class="msg aviso"><b>Avisos</b> (no impiden calcular):<ul>' + avisos.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></div>';
    if (info) h += '<div class="msg info">' + esc(info) + '</div>';
    $('#msgs').innerHTML = h;
  }

  /* ===================== red: OSRM (calles reales) ===================== */
  // Política de uso justo de los servidores públicos: ≤ 1 consulta por segundo (se reserva el turno antes de esperar).
  var limitesRed = { osrm: 0, nominatim: 0 };
  async function turnoRed(clave, gapMs) {
    var ahora = Date.now(), cuando = Math.max(ahora, limitesRed[clave] + gapMs);
    limitesRed[clave] = cuando;
    if (cuando > ahora) await sleep(cuando - ahora);
  }
  function fetchJson(url, ms, nombreServidor) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, ms || 25000) : null;
    var comp = ctlRed;
    if (ctl && comp) {
      if (comp.signal.aborted) ctl.abort();
      else comp.signal.addEventListener('abort', function () { ctl.abort(); }, { once: true });
    }
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (t) clearTimeout(t);
      if (!r.ok) throw new Error(nombreServidor + ' respondió ' + r.status);
      return r.json();
    }, function (e) {
      if (t) clearTimeout(t);
      if (cancelado && e && e.name === 'AbortError') throw new Error('cancelado por ti');
      throw new Error(e && e.name === 'AbortError' ? nombreServidor + ' tardó demasiado en responder' : 'sin conexión con ' + nombreServidor);
    });
  }
  async function osrmFetch(url, ms) {
    await turnoRed('osrm', GAP_MS);
    return fetchJson(url, ms, 'el servidor de calles');
  }
  function firmaPuntos(pr) {
    return puntosDe(pr).map(function (p) { return p.lat.toFixed(6) + ',' + p.lon.toFixed(6); }).join('|');
  }
  // Límites de bloque [0, ..., n]: hasta 100 puntos = 1 bloque; más = bloques parejos de ≤ BLOQUE_OSRM (mínimo 2 puntos cada uno)
  function bordesBloques(n) {
    var nb = n <= 100 ? 1 : Math.ceil(n / BLOQUE_OSRM), base = Math.floor(n / nb), extra = n % nb, b = [0], i;
    for (i = 0; i < nb; i++) b.push(b[i] + base + (i < extra ? 1 : 0));
    return b;
  }
  function coordsUrl(arr) { return arr.map(function (p) { return p.lon + ',' + p.lat; }).join(';'); }

  // Devuelve {km, min} (matrices (n+1)x(n+1)) o null (con aviso en `avisos`). Nunca lanza.
  // Hasta 100 puntos: una consulta. Más: por bloques de BLOQUE_OSRM x BLOQUE_OSRM (sources/destinations).
  async function prepararMatriz(pr, avisos, alEstado) {
    var pts = puntosDe(pr), n = pts.length;
    if (n > MAX_PUNTOS_OSRM) { avisos.push('Hay ' + n + ' puntos y el servidor público de calles reales no está pensado para tantos (máximo ' + MAX_PUNTOS_OSRM + '): se usa la estimación en línea recta.'); return null; }
    var firma = firmaPuntos(pr);
    if (cacheMatriz && cacheMatriz.firma === firma) return cacheMatriz;
    var c = (pr.estimacion || {}).circuidad || 1.35, v = (pr.estimacion || {}).velocidad_kmh || 35, vacios = 0;
    var km = [], mi = [], i, k;
    for (i = 0; i < n; i++) { km.push(new Array(n).fill(null)); mi.push(new Array(n).fill(null)); }
    // Bloques de tamaño parejo (≤ BLOQUE_OSRM): así ninguno queda con 1 solo punto (la tabla de OSRM pide ≥ 2 coordenadas)
    // y una consulta entre dos bloques nunca pasa de 2 × BLOQUE_OSRM = 100 coordenadas.
    var bordes = bordesBloques(n), nb = bordes.length - 1, total = nb * nb, hecho = 0;
    try {
      for (var I = 0; I < nb; I++) {
        for (var J = 0; J < nb; J++) {
          var i0 = bordes[I], i1 = bordes[I + 1], j0 = bordes[J], j1 = bordes[J + 1];
          var ci = pts.slice(i0, i1), cj = pts.slice(j0, j1), url;
          if (I === J) url = OSRM + '/table/v1/driving/' + coordsUrl(ci) + '?annotations=distance,duration';
          else {
            var src = [], dst = [];
            for (k = 0; k < ci.length; k++) src.push(k);
            for (k = 0; k < cj.length; k++) dst.push(ci.length + k);
            url = OSRM + '/table/v1/driving/' + coordsUrl(ci.concat(cj)) + '?sources=' + src.join(';') + '&destinations=' + dst.join(';') + '&annotations=distance,duration';
          }
          if (alEstado) alEstado('Pidiendo distancias por calles reales… ' + (total > 1 ? 'bloque ' + (++hecho) + ' de ' + total : ''));
          var j = await osrmFetch(url, 40000);
          if (!j || j.code !== 'Ok' || !Array.isArray(j.distances) || !Array.isArray(j.durations)) throw new Error('respuesta inesperada (' + ((j && j.code) || 'sin código') + ')');
          for (var a = 0; a < ci.length; a++) {
            for (var b = 0; b < cj.length; b++) {
              var d = j.distances[a] && j.distances[a][b], t = j.durations[a] && j.durations[a][b];
              km[i0 + a][j0 + b] = (typeof d === 'number' && isFinite(d)) ? d / 1000 : null;
              mi[i0 + a][j0 + b] = (typeof t === 'number' && isFinite(t)) ? t / 60 : null;
            }
          }
        }
      }
    } catch (e) {
      avisos.push('No se pudieron obtener las distancias por calles reales (' + e.message + '). Se usa la estimación en línea recta; el cálculo sigue funcionando.');
      return null;
    }
    for (i = 0; i < n; i++) {
      for (k = 0; k < n; k++) {
        if (i === k) { km[i][k] = 0; mi[i][k] = 0; continue; }
        if (km[i][k] == null || mi[i][k] == null) {
          vacios++;
          var e = Motor && Motor.distanciaKm ? Motor.distanciaKm(pts[i], pts[k]) * c : 0;
          km[i][k] = e; mi[i][k] = e / v * 60;
        }
      }
    }
    if (vacios) avisos.push('OSRM no encontró camino entre ' + vacios + ' pares de puntos (¿alguno está lejos de una calle?); esos pares se estimaron en línea recta.');
    cacheMatriz = { firma: firma, km: km, min: mi };
    return cacheMatriz;
  }

  /* ----- geometría por tramo (leg a leg) con caché por par de puntos ----- */
  function claveLeg(a, b) { return a.lat.toFixed(6) + ',' + a.lon.toFixed(6) + '>' + b.lat.toFixed(6) + ',' + b.lon.toFixed(6); }
  function guardarLeg(clave, leg) {
    if (cacheLegs.size >= 4000) cacheLegs.delete(cacheLegs.keys().next().value);
    cacheLegs.set(clave, leg);
  }
  // seq: [{lat,lon},...]; devuelve [{geom:[[lat,lon]..], km, min}] de longitud seq.length-1. Lanza Error si falla la red.
  async function legsDeRuta(seq) {
    var out = new Array(Math.max(0, seq.length - 1)), faltan = false, t;
    for (t = 0; t < out.length; t++) {
      var lg = cacheLegs.get(claveLeg(seq[t], seq[t + 1]));
      if (lg) out[t] = lg; else faltan = true;
    }
    if (!faltan) return out;
    var i = 0;
    while (i < out.length) {
      var fin = Math.min(i + 79, out.length), sub = seq.slice(i, fin + 1), todos = true;
      for (t = i; t < fin; t++) if (!out[t]) todos = false;
      if (!todos) {
        var j = await osrmFetch(OSRM + '/route/v1/driving/' + coordsUrl(sub) + '?overview=false&steps=true&geometries=geojson', 40000);
        if (!j || j.code !== 'Ok' || !j.routes || !j.routes[0] || !Array.isArray(j.routes[0].legs) || j.routes[0].legs.length !== sub.length - 1) throw new Error('respuesta inesperada del servidor de calles');
        j.routes[0].legs.forEach(function (lg, q) {
          var geom = [];
          (lg.steps || []).forEach(function (st) {
            ((st.geometry && st.geometry.coordinates) || []).forEach(function (c) {
              if (!Array.isArray(c) || !isFinite(c[0]) || !isFinite(c[1])) return;
              var p = [c[1], c[0]], last = geom[geom.length - 1];
              if (!last || last[0] !== p[0] || last[1] !== p[1]) geom.push(p);
            });
          });
          if (geom.length < 2) geom = [[sub[q].lat, sub[q].lon], [sub[q + 1].lat, sub[q + 1].lon]];
          var leg = { geom: geom, km: (lg.distance || 0) / 1000, min: (lg.duration || 0) / 60 };
          guardarLeg(claveLeg(sub[q], sub[q + 1]), leg);
          out[i + q] = leg;
        });
      }
      i = fin;
    }
    return out;
  }

  /* ===================== red: búsqueda de direcciones (Nominatim de OpenStreetMap) ===================== */
  // Todo lo que devuelve Nominatim es TEXTO EXTERNO NO CONFIABLE: siempre se escapa con esc() antes de mostrarlo.
  var GEO_KEY = 'optimizador-rutas-geo-v1', geoCache = null, geoCancelar = false, geoCands = Object.create(null), candActual = null;
  function geoLeerCache() {
    if (geoCache) return geoCache;
    var crudo = null;
    try { crudo = JSON.parse(localStorage.getItem(GEO_KEY) || '{}'); } catch (e) { crudo = null; }
    // sin prototipo: una consulta como «__proto__» o «constructor» no puede tocar los objetos internos
    geoCache = Object.create(null);
    if (crudo && typeof crudo === 'object' && !Array.isArray(crudo)) {
      Object.keys(crudo).forEach(function (k) { var v = crudo[k]; if (v && typeof v === 'object' && Array.isArray(v.res)) geoCache[k] = v; });
    }
    return geoCache;
  }
  function geoGuardarCache() {
    try {
      var c = geoCache || Object.create(null), ks = Object.keys(c);
      if (ks.length > 400) {
        ks.sort(function (a, b) { return (c[a].t || 0) - (c[b].t || 0); });
        ks.slice(0, ks.length - 400).forEach(function (k) { delete c[k]; });
      }
      localStorage.setItem(GEO_KEY, JSON.stringify(c));
    } catch (e) { /* sin almacenamiento: no pasa nada, solo se repiten consultas */ }
  }
  function geoClave(q) { return String(q).trim().toLowerCase().replace(/\s+/g, ' '); }
  function normalizarResultadosGeo(j) {
    var out = [];
    if (!Array.isArray(j)) return out;
    j.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var lat = parseFloat(it.lat), lon = parseFloat(it.lon);
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      out.push({
        lat: r6(lat), lon: r6(lon), nombre: String(it.display_name == null ? '' : it.display_name).slice(0, 300),
        tipo: String(it.addresstype || it.type || '').slice(0, 40), importancia: typeof it.importance === 'number' ? it.importance : 0
      });
    });
    return out.slice(0, 5);
  }
  // {res, cache} ; lanza Error (mensaje claro) si no hay red
  async function geoBuscar(q) {
    var clave = geoClave(q), cache = geoLeerCache();
    if (cache[clave] && Array.isArray(cache[clave].res)) return { res: cache[clave].res, cache: true };
    await turnoRed('nominatim', GAP_MS);
    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=pe&accept-language=es&q=' + encodeURIComponent(q);
    var j = await fetchJson(url, 20000, 'el servicio de direcciones');
    var res = normalizarResultadosGeo(j);
    cache[clave] = { t: Date.now(), res: res };
    geoGuardarCache();
    return { res: res, cache: false };
  }
  var TIPOS_IMPRECISOS = ['city', 'town', 'suburb', 'neighbourhood', 'administrative', 'state', 'county', 'village', 'hamlet', 'quarter', 'city_district', 'district', 'country', 'postcode', 'region', 'province', 'municipality'];
  // 'ok' | 'dudosa' | 'sin'
  function clasificarGeo(q, res) {
    if (!res.length) return 'sin';
    if (res.length >= 2 && res[1].importancia >= 0.85 * res[0].importancia) return 'dudosa';
    if (/\d/.test(q) && TIPOS_IMPRECISOS.indexOf(res[0].tipo) >= 0) return 'dudosa';
    return 'ok';
  }
  function nombreCorto(display) { return String(display).split(',')[0].trim().slice(0, 40) || 'Parada'; }

  /* ===================== búsqueda de direcciones: pantalla ===================== */
  var geoOcupado = false;
  function renderCandidatos(lista, q, objetivo, dest) {
    candActual = { lista: lista, objetivo: objetivo, q: q, dest: dest || null };
    var box = $(dest === 'fin' ? '#fin-res' : '#busq-res'), otra = $(dest === 'fin' ? '#busq-res' : '#fin-res');
    if (otra) otra.innerHTML = '';
    if (!lista.length) {
      box.innerHTML = '<div class="msg aviso">No se encontró “' + esc(q) + '”. Prueba con calle, número y distrito (ej.: Av. Larco 345, Miraflores), o ubícalo con clic en el mapa.</div>';
      return;
    }
    box.innerHTML = '<p class="ayuda">' + (objetivo ? 'Elige la dirección correcta para <b>' + esc(objetivo.id) + '</b>:' : 'Resultados (elige uno):') + '</p>' + lista.map(function (c, i) {
      var botones = dest === 'fin'
        ? '<button class="mini primario" data-cand="fin" data-i="' + i + '">Usar como depósito final</button>'
        : objetivo
        ? '<button class="mini primario" data-cand="usar" data-i="' + i + '">Usar para ' + esc(objetivo.id) + '</button>'
        : '<button class="mini" data-cand="parada" data-i="' + i + '">Agregar como parada</button><button class="mini" data-cand="deposito" data-i="' + i + '">Como depósito</button>' + (estado.fin === 'otro' ? '<button class="mini" data-cand="fin" data-i="' + i + '">Como depósito final</button>' : '') + '<button class="mini" data-cand="peaje" data-i="' + i + '">Como peaje</button>';
      return '<div class="cand"><div class="cand-t">' + esc(c.nombre) + '<br><small class="suave">' + esc(fmt(c.lat, 5)) + ', ' + esc(fmt(c.lon, 5)) + ' · © OpenStreetMap</small></div><div class="cand-b">' + botones + '<button class="mini" data-cand="ver" data-i="' + i + '">Ver en el mapa</button></div></div>';
    }).join('');
  }
  function msgErrorGeo(e) {
    return '<div class="msg aviso">No se pudo buscar la dirección (' + esc(e.message) + '). El resto de la aplicación sigue funcionando: ubica los puntos con clic en el mapa o con latitud y longitud.</div>';
  }
  async function buscarDireccion(dest) {
    var esFin = dest === 'fin';
    var q = $(esFin ? '#fin-q' : '#busq-q').value.trim();
    if (!q) { toast('Escribe una dirección para buscar.'); return; }
    var btn = $(esFin ? '#btn-fin-buscar' : '#btn-buscar'), box = $(esFin ? '#fin-res' : '#busq-res');
    btn.disabled = true;
    box.innerHTML = '<p class="ayuda">Buscando…</p>';
    try {
      var r = await geoBuscar(q);
      renderCandidatos(r.res, q, null, esFin ? 'fin' : null);
    } catch (e) { box.innerHTML = msgErrorGeo(e); }
    finally { btn.disabled = false; }
  }
  function nuevaParada(o) {
    var id = 'C' + (estado.sigC++);
    var p = { id: id, nombre: o.nombre || ('Parada ' + id), dir: o.dir || '', lat: o.lat != null ? String(o.lat) : '', lon: o.lon != null ? String(o.lon) : '', demanda: o.demanda || '', servicio: o.servicio || '10', ini: o.ini || '', fin: o.fin || '', geo: o.geo || '' };
    estado.paradas.push(p);
    return p;
  }
  function accionCandidato(accion, c) {
    if (accion === 'ver') {
      if (mapa) { mapa.setView([c.lat, c.lon], 16); L.popup().setLatLng([c.lat, c.lon]).setContent(esc(c.nombre)).openOn(mapa); }
      return;
    }
    if (accion === 'parada') {
      if (estado.paradas.length >= MAX_PARADAS) { toast(msgTopeParadas()); return; }
      var p = nuevaParada({ nombre: nombreCorto(c.nombre), dir: c.nombre, lat: c.lat, lon: c.lon, geo: 'ok' });
      renderParadas(); cambio();
      toast('Parada ' + p.id + ' agregada (' + nombreCorto(c.nombre) + '). Ponle demanda en la tabla.');
    } else if (accion === 'deposito') {
      estado.deposito.nombre = nombreCorto(c.nombre); estado.deposito.lat = String(c.lat); estado.deposito.lon = String(c.lon);
      $('#dep-nombre').value = estado.deposito.nombre; $('#dep-lat').value = estado.deposito.lat; $('#dep-lon').value = estado.deposito.lon;
      cambio(); toast('Depósito ubicado.');
      if (modoClic === 'deposito') setModo('parada');
    } else if (accion === 'fin') {
      estado.depositoFinal.nombre = nombreCorto(c.nombre); estado.depositoFinal.lat = String(c.lat); estado.depositoFinal.lon = String(c.lon);
      $('#fin-nombre').value = estado.depositoFinal.nombre; $('#fin-lat').value = estado.depositoFinal.lat; $('#fin-lon').value = estado.depositoFinal.lon;
      cambio(); toast('Depósito final ubicado.');
      if (modoClic === 'fin') setModo('parada');
    } else if (accion === 'peaje') {
      var pid = 'P' + (estado.sigP++);
      estado.peajes.push({ id: pid, nombre: nombreCorto(c.nombre), lat: String(c.lat), lon: String(c.lon), costo: '', radio: '300' });
      renderPeajes(); cambio(); toast('Peaje ' + pid + ' agregado: escribe su tarifa en la pestaña “3 Peajes”.');
    } else if (accion === 'usar' && candActual && candActual.objetivo) {
      var q = estado.paradas.filter(function (x) { return x.id === candActual.objetivo.id; })[0];
      if (!q) return;
      q.lat = String(c.lat); q.lon = String(c.lon); q.dir = c.nombre; q.geo = 'ok';
      renderParadas(); cambio(); $('#busq-res').innerHTML = '';
      toast('Parada ' + q.id + ' actualizada.');
    }
    if (mapa && accion !== 'usar') mapa.setView([c.lat, c.lon], Math.max(mapa.getZoom(), 14));
    else if (mapa) mapa.setView([c.lat, c.lon], Math.max(mapa.getZoom(), 14));
  }
  async function elegirParaParada(id) {
    var p = estado.paradas.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var q = (p.dir || p.nombre || '').trim(), box = $('#busq-res');
    if (!q) { box.innerHTML = '<div class="msg aviso">La parada ' + esc(id) + ' no tiene dirección escrita: escríbela en la columna “Dirección” o ubícala en el mapa.</div>'; return; }
    $('#card-busqueda').scrollIntoView({ block: 'nearest' });
    try {
      var lista = geoCands[id];
      if (!lista) { box.innerHTML = '<p class="ayuda">Buscando…</p>'; lista = (await geoBuscar(q)).res; }
      renderCandidatos(lista, q, { id: id });
    } catch (e) { box.innerHTML = msgErrorGeo(e); }
  }
  function parsearListaDirecciones(texto) {
    var items = [];
    String(texto || '').split(/\r?\n/).forEach(function (ln) {
      ln = ln.trim();
      if (!ln) return;
      var partes = ln.indexOf('\t') >= 0 ? ln.split('\t') : (ln.indexOf('|') >= 0 ? ln.split('|') : [ln]);
      partes = partes.map(function (s) { return s.trim(); });
      if (partes.length >= 2 && partes[1]) items.push({ nombre: partes[0].slice(0, 60), dir: partes[1] });
      else if (partes[0]) items.push({ nombre: '', dir: partes[0] });
    });
    return items;
  }
  // items: [{nombre, dir, demanda?, servicio?, ini?, fin?}]. Una consulta por segundo; las dudosas quedan amarillas.
  async function geocodificarLista(items, desdeTextarea) {
    if (geoOcupado) { toast('Ya hay una búsqueda de direcciones en curso.'); return; }
    var cupoP = MAX_PARADAS - estado.paradas.length;
    if (cupoP <= 0) { toast(msgTopeParadas() + ' No se buscaron las direcciones.'); return; }
    var MAXL = Math.min(100, cupoP), recortado = items.length > MAXL;
    if (recortado) items = items.slice(0, MAXL);
    geoOcupado = true; geoCancelar = false;
    $('#btn-geo-lista').disabled = true; $('#btn-geo-cancelar').hidden = false;
    var est = $('#geo-estado'), cuenta = { ok: 0, dudosa: 0, sin: 0 }, hechos = 0, falla = null, n = items.length;
    try {
      for (var i = 0; i < n; i++) {
        if (geoCancelar) break;
        var it = items[i];
        est.textContent = 'Buscando ' + (i + 1) + ' de ' + n + ': ' + it.dir;
        var r;
        try { r = await geoBuscar(it.dir); } catch (e) { falla = e.message; break; }
        var flag = clasificarGeo(it.dir, r.res), c = r.res[0] || null;
        var p = nuevaParada({
          nombre: it.nombre || nombreCorto(c ? c.nombre : it.dir), dir: c ? c.nombre : it.dir, lat: c ? c.lat : '', lon: c ? c.lon : '',
          demanda: it.demanda, servicio: it.servicio, ini: it.ini, fin: it.fin, geo: flag
        });
        if (!c) p.dir = it.dir;
        geoCands[p.id] = r.res; cuenta[flag]++; hechos++;
        renderParadas(); cambio();
      }
    } finally {
      geoOcupado = false;
      $('#btn-geo-lista').disabled = false; $('#btn-geo-cancelar').hidden = true;
    }
    var msg = 'Listo: ' + cuenta.ok + ' ubicadas' + (cuenta.dudosa ? ', ' + cuenta.dudosa + ' dudosas (en amarillo: confírmalas o usa “Elegir…”)' : '') + (cuenta.sin ? ', ' + cuenta.sin + ' sin resultado (corrígelas o ubícalas en el mapa)' : '') + '.';
    if (geoCancelar) msg += ' Cancelaste: faltaron ' + (n - hechos) + ' direcciones.';
    if (falla) msg = 'Se detuvo tras ' + hechos + ' de ' + n + ' direcciones (' + falla + '). ' + (hechos ? msg + ' ' : '') + 'Las que faltan quedaron en la caja de la lista: reintenta cuando haya conexión.';
    if (recortado) msg += ' (Solo se procesaron las primeras ' + MAXL + ' direcciones: ' + (MAXL < 100 ? 'el máximo de ' + MAX_PARADAS + ' paradas' : 'el servicio es de uso justo') + '.)';
    est.textContent = msg;
    var ta = $('#geo-lista');
    if (hechos < n) {
      ta.value = items.slice(hechos).map(function (x) { return (x.nombre ? x.nombre + ' | ' : '') + x.dir; }).join('\n');
      var det = ta.closest('details'); if (det && !det.open) det.open = true;
    } else if (desdeTextarea) ta.value = '';
    if (hechos) { dibujarMapa(true); }
  }

  /* ===================== optimizar ===================== */
  function progresoIniciar(idBarra, ms) {
    var b = $(idBarra);
    b.hidden = false;
    b.classList.remove('corre', 'espera', 'listo');
    void b.offsetWidth;
    if (ms > 0) { b.style.setProperty('--dur', ms + 'ms'); b.classList.add('corre'); }
    else b.classList.add('espera');
  }
  function progresoFin(idBarra, ok) {
    var b = $(idBarra);
    b.classList.remove('corre', 'espera');
    if (ok) b.classList.add('listo'); else b.classList.remove('listo');
  }
  function setOcupado(v) {
    ocupado = v;
    $('#btn-optimizar').disabled = v || !Motor;
    $('#btn-barrido').disabled = v || !Motor;
    $('#btn-optimizar').textContent = v ? 'Calculando…' : 'Optimizar rutas';
    var bc = $('#btn-cancelar'); if (bc) bc.hidden = !v;
    var of = $('#btn-optimizar-fijo'), cf = $('#btn-cancelar-fijo'), ef = $('#estado-fijo');
    if (of) { of.disabled = v || !Motor; of.textContent = v ? 'Calculando…' : 'Optimizar rutas'; }
    if (cf) cf.hidden = !v;
    if (ef && !v) ef.hidden = true;
    if (v) { cancelado = false; ctlRed = typeof AbortController !== 'undefined' ? new AbortController() : null; }
    else ctlRed = null;
  }
  function cancelarCalculo() {
    if (!ocupado) return;
    cancelado = true;
    if (ctlRed) ctlRed.abort();
    hiloCancelar();
    $('#estado-calc').textContent = 'Cancelando…';
  }
  // Un cálculo queda «viejo» si cambiaron los datos (o se cargó otro proyecto) mientras esperaba la red.
  function avisarDescartado(motivo) {
    progresoFin('#prog', false);
    $('#estado-calc').textContent = motivo;
    mostrarMensajes([], [motivo], null);
  }

  function parsearActual(texto, paradas) {
    var out = { rutas: [], errores: [], avisos: [] };
    var lineas = texto.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!lineas.length) return null;
    var porId = Object.create(null), porNombre = Object.create(null);
    paradas.forEach(function (p) {
      porId[p.id.toLowerCase()] = p.id;
      var k = (p.nombre || '').trim().toLowerCase();
      if (k && !porNombre[k]) porNombre[k] = p.id;
    });
    var usadas = Object.create(null), desconocidos = [], dup = [];
    lineas.forEach(function (ln) {
      ln = ln.replace(/^\s*(veh[ií]culo|cami[oó]n|ruta|unidad)\s*\d*\s*:/i, '');
      var ids = [];
      ln.split(/\s*[,;>→]+\s*|\s+-\s+/).map(function (t) { return t.trim(); }).filter(Boolean).forEach(function (t) {
        var id = porId[t.toLowerCase()] || porNombre[t.toLowerCase()];
        if (!id) { desconocidos.push(t); return; }
        if (usadas[id]) { dup.push(id); return; }
        usadas[id] = true; ids.push(id);
      });
      if (ids.length) out.rutas.push(ids);
    });
    if (desconocidos.length) out.errores.push('En “Tu ruta actual” no reconozco: ' + desconocidos.slice(0, 6).join(', ') + (desconocidos.length > 6 ? '…' : '') + '. Usa el ID de la tabla (ej. C3) o el nombre exacto.');
    if (dup.length) out.errores.push('En “Tu ruta actual” se repiten: ' + dup.slice(0, 6).join(', ') + '.');
    var faltan = paradas.filter(function (p) { return !usadas[p.id]; });
    if (faltan.length) out.errores.push('En “Tu ruta actual” faltan ' + faltan.length + ' paradas (' + faltan.slice(0, 5).map(function (p) { return p.id; }).join(', ') + (faltan.length > 5 ? '…' : '') + '). Para comparar con justicia deben estar todas.');
    return out;
  }

  /* ----- índices y secuencias de una ruta (0 = depósito, 1..n = paradas en el orden del problema) ----- */
  function mapaIndices(pr) {
    var m = Object.create(null);
    pr.paradas.forEach(function (p, i) { m[p.id] = i + 1; });
    return m;
  }
  // 0 = depósito de salida, 1..n = paradas, n+1 = depósito final (solo si fin = «otro»)
  function puntosDe(pr) { var a = [pr.deposito].concat(pr.paradas); if (finDe(pr) === 'otro' && pr.deposito_final) a.push(pr.deposito_final); return a; }
  function indicesRuta(pr, r, mi) {
    var idx = [0];
    r.paradas.forEach(function (s) { if (mi[s.id] != null) idx.push(mi[s.id]); });
    var f = finDe(pr);
    if (f === 'deposito') idx.push(0);
    else if (f === 'otro') idx.push(pr.paradas.length + 1);
    return idx;
  }
  function firmaPlan(res) {
    return res.rutas.map(function (r) { return r.paradas.map(function (s) { return s.id; }).join('>'); }).sort().join('|');
  }

  /* ----- cálculo en un hilo aparte (Web Worker) ----- */
  // Con el hilo aparte la pantalla sigue viva y «Cancelar» funciona al instante. Si el navegador no lo permite
  // (por ejemplo abriendo index.html con doble clic) o el hilo no arranca, se calcula en el hilo principal como antes.
  var hilo = null, hiloOk = (typeof Worker !== 'undefined' && /^https?:$/.test(location.protocol)), hiloSeq = 0, hiloPend = null;
  function hiloCerrar() {
    if (hilo) { try { hilo.terminate(); } catch (e) { /* nada */ } hilo = null; }
  }
  function hiloAbrir() {
    if (hilo) return hilo;
    hilo = new Worker('trabajador.js');
    hilo.onmessage = function (ev) {
      var m = ev.data || {}, p = hiloPend;
      if (!p || m.id !== p.id) return;
      if (m.tipo === 'progreso') { if (p.onProg) p.onProg(m.p); return; }
      hiloPend = null; p.huboRespuesta = true;
      if (m.tipo === 'fin') p.ok(m.r); else p.ok({ ok: false, errores: ['Error interno del motor: ' + m.mensaje] });
    };
    hilo.onerror = function (ev) {
      var p = hiloPend; hiloCerrar();
      if (ev && ev.preventDefault) ev.preventDefault();
      if (p) { hiloPend = null; p.fallo(new Error('hilo')); }
    };
    return hilo;
  }
  // op: 'optimizar' | 'barrer'. Devuelve el resultado del motor, o { cancelado: true } si el usuario canceló.
  function motorAparte(op, args, opts, onProg) {
    var enPrincipal = function () {
      return cederHilo().then(function () {
        try {
          if (op === 'optimizar') return Motor.optimizar(args, opts);
          return Motor.barrerHoraSalida(args, opts);
        } catch (e) { return { ok: false, errores: ['Error interno del motor: ' + e.message] }; }
      });
    };
    if (!hiloOk) return enPrincipal();
    return new Promise(function (ok) {
      var id = ++hiloSeq, listo = false;
      var fin = function (v) { if (!listo) { listo = true; ok(v); } };
      try { hiloAbrir(); } catch (e) { hiloOk = false; hiloCerrar(); enPrincipal().then(fin); return; }
      hiloPend = {
        id: id, onProg: onProg, ok: fin,
        fallo: function () { hiloOk = false; enPrincipal().then(fin); },
        cancelar: function () { fin({ cancelado: true }); }
      };
      hilo.postMessage({ id: id, op: op, args: args, opts: opts });
    });
  }
  function hiloCancelar() {
    var p = hiloPend; hiloPend = null;
    hiloCerrar();
    if (p && p.cancelar) p.cancelar();
  }

  // Ejecuta el motor sin congelar la pantalla y muestra el avance real (mejor costo hasta ahora).
  async function correrMotor(problema, ms, idBarra) {
    $('#estado-calc').textContent = 'Calculando… (hasta ' + Math.round(ms / 1000) + ' s)' + (hiloOk ? '' : '. La pantalla puede quedar quieta unos segundos.');
    progresoIniciar(idBarra, ms);
    await cederHilo();
    var t0 = performance.now();
    var res = await motorAparte('optimizar', paraMotor(problema), { semilla: 1, tiempo_ms: ms }, function (p) {
      if (cancelado || !p) return;
      $('#estado-calc').textContent = 'Calculando… mejor costo hasta ahora ' + moneyTxt(p.mejor_costo) + ' · ' + fmt(p.iteraciones, 0) + ' pruebas · ' + Math.min(100, Math.round((p.fraccion || 0) * 100)) + ' %';
    });
    if (res && res.cancelado) return res;
    if (res) res.seg = ((performance.now() - t0) / 1000).toFixed(1);
    return res;
  }

  async function optimizarClick() {
    if (ocupado) return;
    if (!Motor) { mostrarMensajes(['No se cargó motor.js; no se puede optimizar.'], [], null); return; }
    $('#estado-calc').textContent = '';
    var problema = construirProblema();
    var v = validarTodo(problema);
    mostrarMensajes(v.errores, v.avisos, null);
    if (!v.ok) { $('#msgs').scrollTop = 0; return; }
    var avisosRed = [];
    var ver0 = versionEstado;
    setOcupado(true);
    var usoOSRM = false;
    try {
      if (estado.calles) {
        $('#estado-calc').textContent = 'Pidiendo distancias por calles reales a OSRM…';
        progresoIniciar('#prog', 0);
        await cederHilo();
        var m = await prepararMatriz(problema, avisosRed, function (t) { $('#estado-calc').textContent = t; });
        if (cancelado) { avisarDescartado('Cancelaste el cálculo. No se cambió ningún resultado.'); return; }
        if (versionEstado !== ver0) { avisarDescartado('Cambiaste datos mientras se calculaba: ese resultado se descartó para no mostrarte un plan viejo. Pulsa “Optimizar rutas” otra vez.'); return; }
        if (m) { problema.matriz = { km: m.km, min: m.min }; usoOSRM = true; }
      }
      var ms = tiempoValido(estado.tiempo) ? TIEMPOS[estado.tiempo] : 3000;
      var res = await correrMotor(problema, ms, '#prog');
      if (cancelado || (res && res.cancelado)) { avisarDescartado('Cancelaste el cálculo. No se cambió ningún resultado.'); return; }
      if (versionEstado !== ver0) { avisarDescartado('Cambiaste datos mientras se calculaba: ese resultado se descartó para no mostrarte un plan viejo. Pulsa “Optimizar rutas” otra vez.'); return; }
      if (!res || !res.ok) {
        progresoFin('#prog', false);
        $('#estado-calc').textContent = 'No se pudo calcular.';
        mostrarMensajes((res && res.errores) || ['El motor no devolvió resultado.'], v.avisos.concat(avisosRed), null);
        return;
      }
      progresoFin('#prog', true);
      $('#estado-calc').textContent = 'Listo en ' + res.seg + ' s' + (res.iteraciones ? ' · ' + fmt(res.iteraciones, 0) + ' iteraciones' : '') + '.';

      // comparación con "tu ruta actual"
      var actual = null, avisosAct = [];
      var pa = parsearActual(estado.actual || '', estado.paradas.map(function (p) { return { id: p.id, nombre: p.nombre }; }));
      if (pa) {
        if (pa.errores.length) avisosAct = pa.errores.concat(['No se calculó el ahorro contra tu ruta actual.']);
        else {
          try { var ev = Motor.evaluarRutas(paraMotor(problema), pa.rutas); if (ev && ev.ok !== false) actual = ev; else avisosAct.push('No se pudo evaluar tu ruta actual: ' + ((ev && ev.errores) || []).join(' ')); }
          catch (e) { avisosAct.push('No se pudo evaluar tu ruta actual: ' + e.message); }
        }
      }
      ultimo = { problema: problema, resultado: res, actual: actual, legs: [], verif: [], usoOSRM: usoOSRM, obsoleto: false, ms: res.seg, refino: null, flete: null, legsError: null, avisosRed: avisosRed };
      mostrarMensajes([], v.avisos.concat(avisosRed, avisosAct), null);
      renderResultados();
      renderFlete();
      irTab('res');
      dibujarMapa(true);
      guardarLocal();
      if (usoOSRM && res.rutas.length) await afinarConCalles(ultimo, ms, v.avisos.concat(avisosAct));
    } finally {
      setOcupado(false);
    }
  }

  /* ----- calles reales: geometría por tramo + peajes verificados + reoptimización (máx. 2) ----- */
  async function obtenerLegs(ctx) {
    var pr = ctx.problema, pts = puntosDe(pr), mi = mapaIndices(pr);
    ctx.legs = [];
    for (var k = 0; k < ctx.resultado.rutas.length; k++) {
      if (ctx !== ultimo) throw new Error('cancelado');
      var idx = indicesRuta(pr, ctx.resultado.rutas[k], mi);
      $('#estado-calc').textContent = 'Trazando las rutas por calles reales… vehículo ' + (k + 1) + ' de ' + ctx.resultado.rutas.length;
      ctx.legs[k] = await legsDeRuta(idx.map(function (q) { return pts[q]; }));
    }
  }
  function costoGeom(geom, peajes) {
    var hallados = Motor.peajesEnGeometria(geom, peajes) || [], c = 0;
    hallados.forEach(function (p) { c += p.costo || 0; });
    return { hallados: hallados, costo: c };
  }
  function calcularVerif(ctx) {
    var pr = ctx.problema;
    ctx.verif = ctx.resultado.rutas.map(function (r, k) {
      var legs = ctx.legs[k];
      if (!legs) return { ok: false, error: ctx.legsError || 'sin geometría' };
      var hallados = [], costo = 0, km = 0;
      legs.forEach(function (lg) {
        km += lg.km || 0;
        if (pr.peajes.length) { var g = costoGeom(lg.geom, pr.peajes); hallados = hallados.concat(g.hallados); costo += g.costo; }
      });
      return { ok: true, hallados: hallados, costoReal: costo, costoPlan: (r.costo && r.costo.peajes) || 0, km: km };
    });
  }
  async function afinarConCalles(ctx, ms, avisosPrevios) {
    var pr = ctx.problema, hayPeajes = pr.peajes.length > 0, reopt = 0, peajeMat = null, quedaDif = false;
    var costoInicial = ctx.resultado.totales.peajes, mi = mapaIndices(pr);
    try {
      if (hayPeajes) { peajeMat = Motor.construirMatrices(paraMotor(pr)).peaje.map(function (f) { return f.slice(); }); }
      for (var iter = 0; iter <= 2; iter++) {
        if (ctx !== ultimo) return;
        progresoIniciar('#prog', 0);
        await obtenerLegs(ctx);
        if (ctx !== ultimo) return;
        calcularVerif(ctx);
        if (!hayPeajes) break;
        var cambios = 0;
        ctx.resultado.rutas.forEach(function (r, k) {
          var idx = indicesRuta(pr, r, mi);
          ctx.legs[k].forEach(function (lg, t) {
            var real = costoGeom(lg.geom, pr.peajes).costo, a = idx[t], b = idx[t + 1];
            if (Math.abs(peajeMat[a][b] - real) > 1e-9) { peajeMat[a][b] = real; cambios++; }
          });
        });
        quedaDif = cambios > 0;
        if (!cambios || iter === 2) break;
        $('#estado-calc').textContent = 'Los peajes de la ruta real cambian el costo: recalculando el plan (' + (reopt + 1) + ' de 2)…';
        pr.matriz.peaje = peajeMat;
        var firmaAntes = firmaPlan(ctx.resultado);
        var res2 = await correrMotor(pr, Math.max(1000, Math.round(ms * 0.6)), '#prog');
        if (ctx !== ultimo) return;
        if (cancelado || (res2 && res2.cancelado)) { quedaDif = true; break; }
        if (!res2 || !res2.ok) break;
        reopt++;
        res2.supuestos = res2.supuestos || [];
        ctx.resultado = res2; ctx.flete = null;
        renderResultados(); renderFlete(); dibujarMapa(false);
        if (firmaPlan(res2) === firmaAntes) { quedaDif = false; }
      }
      ctx.refino = { reopt: reopt, costoInicial: costoInicial, quedaDif: quedaDif, hayPeajes: hayPeajes };
      progresoFin('#prog', true);
      $('#estado-calc').textContent = 'Listo: rutas trazadas por calles reales' + (hayPeajes ? ' y pasos por peaje verificados' : '') + (reopt ? ' (plan recalculado ' + reopt + (reopt === 1 ? ' vez' : ' veces') + ').' : '.');
    } catch (e) {
      if (ctx !== ultimo) return;
      ctx.legsError = e.message;
      progresoFin('#prog', false);
      $('#estado-calc').textContent = 'No se pudo completar el trazado por calles reales.';
      mostrarMensajes([], (avisosPrevios || []).concat(ctx.avisosRed || [], ['No se pudo trazar la ruta por calles reales (' + e.message + '). Las rutas se muestran como línea recta (aprox.) y los peajes quedan con la detección en línea recta, sin verificar.']), null);
    }
    if (ctx !== ultimo) return;
    renderResultados(); renderFlete(); dibujarMapa(false);
  }

  /* ===================== resultados ===================== */
  function urlMaps(seg) {
    function f(p) { return p[0] + ',' + p[1]; }
    var u = 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(f(seg[0])) + '&destination=' + encodeURIComponent(f(seg[seg.length - 1]));
    var w = seg.slice(1, -1);
    if (w.length) u += '&waypoints=' + encodeURIComponent(w.map(f).join('|'));
    return u + '&travelmode=driving';
  }
  function enlacesMaps(pr, r) {
    var mp = Object.create(null);
    pr.paradas.forEach(function (p) { mp[p.id] = p; });
    var pts = [[pr.deposito.lat, pr.deposito.lon]];
    r.paradas.forEach(function (s) { if (mp[s.id]) pts.push([mp[s.id].lat, mp[s.id].lon]); });
    var fm = finDe(pr);
    if (fm === 'deposito') pts.push([pr.deposito.lat, pr.deposito.lon]);
    else if (fm === 'otro' && pr.deposito_final) pts.push([pr.deposito_final.lat, pr.deposito_final.lon]);
    var out = [], i = 0;
    while (i < pts.length - 1) {
      var fin = Math.min(i + 10, pts.length - 1);   // origen + 9 waypoints + destino
      out.push({ url: urlMaps(pts.slice(i, fin + 1)), desde: i, hasta: fin });
      i = fin;
    }
    return out;
  }

  function tipoDeRuta(pr, r) {
    var ts = (pr.flota && pr.flota.tipos) || [];
    for (var i = 0; i < ts.length; i++) if (ts[i].id === r.tipo) return ts[i];
    return ts[0] || null;
  }

  function tablaRuta(r, pr) {
    var mp = Object.create(null);
    pr.paradas.forEach(function (p) { mp[p.id] = p; });
    var sumKm = 0, sumPj = 0;
    var h = '<div class="tabla-scroll"><table class="res"><thead><tr><th>#</th><th>Parada</th><th>Ventana</th><th class="num">Llega</th><th class="num">Espera</th><th class="num">Atiende</th><th class="num">Sale</th><th class="num">Km</th><th class="num">Peaje</th></tr></thead><tbody>';
    h += '<tr class="extra"><td></td><td>Sale del depósito: ' + esc(pr.deposito.nombre) + '</td><td></td><td></td><td></td><td></td><td class="num">' + min2hhmm(r.salida_deposito_min) + '</td><td></td><td></td></tr>';
    r.paradas.forEach(function (s, i) {
      var p = mp[s.id] || {};
      sumKm += s.km_tramo || 0; sumPj += s.peaje_tramo || 0;
      h += '<tr><td>' + (i + 1) + '</td><td>' + esc(s.nombre) + ' <small class="suave">' + esc(s.id) + '</small></td><td>' + esc(ventanaTxt(p.ventana)) + '</td><td class="num">' + min2hhmm(s.llegada_min) + '</td><td class="num">' + (s.espera_min > 0.5 ? Math.round(s.espera_min) + ' min' : '—') + '</td><td class="num">' + min2hhmm(s.inicio_servicio_min) + '</td><td class="num">' + min2hhmm(s.salida_min) + '</td><td class="num">' + fmt(s.km_tramo, 1) + '</td><td class="num">' + (s.peaje_tramo > 0 ? fmt(s.peaje_tramo, 2) : '—') + '</td></tr>';
    });
    if (finDe(pr) !== 'ultima') {
      var kmR = Math.max(0, (r.km || 0) - sumKm), pjR = Math.max(0, ((r.costo && r.costo.peajes) || 0) - sumPj);
      h += '<tr class="extra"><td></td><td>' + esc(txtFin(pr).fila) + '</td><td></td><td class="num">' + min2hhmm(r.regreso_min) + '</td><td></td><td></td><td></td><td class="num">' + fmt(kmR, 1) + '</td><td class="num">' + (pjR > 0.005 ? fmt(pjR, 2) : '—') + '</td></tr>';
    }
    return h + '</tbody></table></div>';
  }
  function desgloseCosto(c) {
    var items = [['Fijo', c.fijo, '#64754b'], ['Combustible y desgaste (km)', c.km, '#ffffff'], ['Conductor (horas)', c.hora, '#b7c4a3'], ['Peajes', c.peajes, '#dc8c46']];
    var tot = c.total || 1;
    var barra = '<div class="costos-barra" role="img" aria-label="Desglose del costo">' + items.map(function (it) {
      return '<i style="width:' + Math.max(0, it[1] / tot * 100).toFixed(2) + '%;background:' + it[2] + '" title="' + esc(it[0]) + '"></i>';
    }).join('') + '</div>';
    var ley = '<div class="costos-leyenda">' + items.map(function (it) {
      return '<span style="--c:' + it[2] + '">' + esc(it[0]) + ': <b>' + money(it[1]) + '</b></span>';
    }).join('') + '<span style="--c:transparent">Total: <b>' + money(c.total) + '</b></span></div>';
    return barra + ley;
  }

  /* ----- jornada por conductor (barras) y equilibrio ----- */
  var NIVEL_EQ = { '0.25': 'algo', '0.6': 'bastante', '1': 'mucho' };
  function barrasJornada(U) {
    var rs = U.resultado.rutas, pr = U.problema, T = U.resultado.totales;
    if (!rs.length) return '';
    var escala = 0, jmax = 0, jmin = Infinity;
    rs.forEach(function (r) {
      jmax = Math.max(jmax, r.min_jornada); jmin = Math.min(jmin, r.min_jornada);
      var t = tipoDeRuta(pr, r);
      escala = Math.max(escala, r.min_jornada, (t && t.jornada_max_min) || 0);
    });
    if (!(escala > 0)) return '';
    var h = '<h3>Jornada de cada conductor</h3><div class="jornadas">';
    rs.forEach(function (r, k) {
      var t = tipoDeRuta(pr, r), lim = t && t.jornada_max_min ? t.jornada_max_min : 0;
      h += '<div class="jor-fila"><span class="jor-nom"><span class="chip" style="background:' + COLORES[k % COLORES.length] + '"></span>' + esc(nombreVeh(r)) + '</span>' +
        '<span class="jor-barra" role="img" aria-label="' + esc(nombreVeh(r) + ': ' + fmtDur(r.min_jornada)) + '"><i style="width:' + (100 * r.min_jornada / escala).toFixed(1) + '%;background:' + COLORES[k % COLORES.length] + '"></i>' +
        (lim ? '<b class="jor-lim" style="left:' + Math.min(100, 100 * lim / escala).toFixed(1) + '%" title="Jornada máxima: ' + esc(fmtDur(lim)) + '"></b>' : '') + '</span>' +
        '<span class="jor-val">' + esc(fmtDur(r.min_jornada)) + '</span></div>';
    });
    h += '</div>';
    var des = typeof T.desequilibrio_min === 'number' ? T.desequilibrio_min : (jmax - jmin);
    var nivel = NIVEL_EQ[String(pr.equilibrio)] || null;
    h += '<p class="ayuda">' + (rs.length > 1 ? 'Diferencia entre el conductor más cargado y el menos cargado: <b>' + esc(fmtDur(des)) + '</b>. ' : '') + 'La marca vertical es la jornada máxima de ese tipo de vehículo.</p>';
    if (nivel) {
      var ce = U.resultado.costo_equilibrio, sigueDes = rs.length > 1 && des >= 60;
      h += '<p class="ayuda">Equilibrio de jornadas: <b>' + nivel + '</b>. ' + (typeof ce === 'number'
        ? (ce > 0.005 ? 'Equilibrar costó aproximadamente <b>' + money(ce) + '</b> más que el plan que solo busca el menor costo (cifra aproximada).' : (sigueDes ? '' : 'En este caso equilibrar no costó más (cifra aproximada).'))
        : '') + '</p>';
      if (sigueDes) {
        var hayCosto = typeof ce === 'number' && ce > 0.005;
        h += '<div class="msg aviso">Aunque pediste equilibrar, la diferencia entre conductores sigue siendo de ' + esc(Math.floor(des / 60) + ' h ' + Math.round(des % 60) + ' min') + ': con la capacidad, las ventanas y las paradas que tienes no se pudo repartir mejor' + (hayCosto ? ' sin subir mucho el costo' : '') + (String(pr.equilibrio) !== '1' ? ' (o prueba “mucho”)' : '') + '.</div>';
      }
    } else if (rs.length > 1) {
      h += '<p class="ayuda">Las jornadas no se equilibran (opción “Equilibrar jornadas” en “Flota y costos”: No).</p>';
    }
    return h;
  }

  /* ----- mini gráfico: costo según la hora de salida de una ruta ----- */
  function miniSalida(r) {
    var alt = (r.salida_alternativas || []).filter(function (a) { return a && typeof a.salida_min === 'number'; });
    if (!r.salida_auto || alt.length < 2) return '';
    var visto = Object.create(null);
    alt = alt.filter(function (a) { if (visto[a.salida_min]) return false; visto[a.salida_min] = 1; return true; }).sort(function (a, b) { return a.salida_min - b.salida_min; });
    var cs = alt.filter(function (a) { return typeof a.costo === 'number'; }).map(function (a) { return a.costo; });
    if (!cs.length) return '';
    var lo = Math.min.apply(null, cs), hi = Math.max.apply(null, cs), rango = (hi - lo) || Math.max(1, hi * 0.05);
    var base = lo - rango * 0.25, W = 320, H = 96, ml = 4, mb = 18, mt = 6, ph = H - mb - mt, bw = (W - 2 * ml) / alt.length;
    var svg = '<svg class="mini-salida" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Costo de ' + esc(nombreVeh(r)) + ' según la hora de salida; la elegida es ' + esc(min2hhmm(r.salida_deposito_min)) + '">';
    var cadaX = Math.ceil(alt.length / 6), idxElegido = -99;
    alt.forEach(function (a, i) { if (Math.abs(a.salida_min - r.salida_deposito_min) < 0.5) idxElegido = i; });
    alt.forEach(function (a, i) {
      var x = ml + i * bw, elegido = Math.abs(a.salida_min - r.salida_deposito_min) < 0.5;
      if (typeof a.costo === 'number') {
        var bh = Math.max(2, ph * (a.costo - base) / (hi - base)), y = mt + ph - bh;
        svg += '<rect class="barra' + (elegido ? ' mejor' : '') + '" x="' + (x + bw * 0.1).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw * 0.8).toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="1.5"><title>Salida ' + esc(min2hhmm(a.salida_min)) + ': ' + esc(moneyTxt(a.costo)) + '</title></rect>';
      } else {
        svg += '<rect class="barra mala" x="' + (x + bw * 0.1).toFixed(1) + '" y="' + (mt + ph - 3) + '" width="' + (bw * 0.8).toFixed(1) + '" height="3"><title>Salida ' + esc(min2hhmm(a.salida_min)) + ': no es posible</title></rect>';
      }
      if ((i % cadaX === 0 && Math.abs(i - idxElegido) * bw >= 50) || elegido) {
        var ancla = i === 0 ? 'start' : (i === alt.length - 1 ? 'end' : 'middle'), tx = i === 0 ? x + 1 : (i === alt.length - 1 ? x + bw - 1 : x + bw / 2);
        svg += '<text x="' + tx.toFixed(1) + '" y="' + (H - 5) + '" text-anchor="' + ancla + '"' + (elegido ? ' style="font-weight:700"' : '') + '>' + esc(min2hhmm(a.salida_min)) + '</text>';
      }
    });
    return svg + '</svg><p class="ayuda">Costo de esta ruta según la hora de salida (la escala no empieza en cero, para que se vean las diferencias). Barra resaltada = la elegida.</p>';
  }

  /* ----- peajes verificados con la ruta real ----- */
  function htmlVerif(U, k) {
    var pr = U.problema;
    if (!pr.peajes.length) return '';
    if (!U.usoOSRM) return '<div class="verif">Peajes: detección en línea recta (sin calles reales no se pueden verificar con la ruta).</div>';
    var v = U.verif && U.verif[k];
    if (!v) return U.legsError ? '<div class="verif aviso-v">Peajes sin verificar con la ruta real: no se pudo trazar la ruta por calles.</div>' : '<div class="verif">Verificando peajes con la ruta real…</div>';
    if (!v.ok) return '<div class="verif aviso-v">Peajes sin verificar con la ruta real (' + esc(v.error) + ').</div>';
    var grupos = Object.create(null), orden = [];
    v.hallados.forEach(function (p) {
      var id = p.id || p.nombre;
      if (!grupos[id]) { grupos[id] = { nombre: p.nombre || p.id, n: 0, costo: 0 }; orden.push(id); }
      grupos[id].n++; grupos[id].costo += p.costo || 0;
    });
    var lista = orden.length ? orden.map(function (id) { var g = grupos[id]; return esc(g.nombre) + (g.n > 1 ? ' ×' + g.n : '') + ' (' + money(g.costo) + ')'; }).join(', ') : 'ninguno';
    var dif = v.costoReal - v.costoPlan;
    return '<div class="verif ok-v"><b>Pasos por peaje verificados con la ruta real (la tarifa sigue siendo la que ingresaste):</b> ' + lista + '. ' +
      (Math.abs(dif) > 0.005 ? 'Difiere del plan: el plan contaba ' + money(v.costoPlan) + ' y la ruta real trae ' + money(v.costoReal) + ' (' + (dif > 0 ? '+' : '−') + money(Math.abs(dif)) + ').' : 'Coincide con lo planificado (' + money(v.costoPlan) + ').') + '</div>';
  }
  function textoRefino(U) {
    var pr = U.problema, rf = U.refino, t = '';
    if (U.usoOSRM) {
      if (U.legsError) return '<div class="verif aviso-v">No se pudo trazar las rutas por calles reales (' + esc(U.legsError) + '): se muestran como línea recta (aprox.)' + (pr.peajes.length ? ' y los peajes quedan sin verificar con la ruta real' : '') + '.</div>';
      if (!rf) return '<div class="verif">' + (ocupado ? 'Trazando las rutas por calles reales' + (pr.peajes.length ? ' y verificando los peajes' : '') + '…' : '') + '</div>';
      t = 'Rutas trazadas por calles reales.';
      if (rf.hayPeajes) {
        var final = U.resultado.totales.peajes;
        t = '<b>Pasos por peaje verificados con la ruta real (la tarifa sigue siendo la que ingresaste).</b> ';
        if (rf.reopt > 0) t += 'Para eso se recalculó el plan ' + rf.reopt + (rf.reopt === 1 ? ' vez' : ' veces') + ': los peajes pasaron de ' + money(rf.costoInicial) + ' (estimación en línea recta) a ' + money(final) + ' con la ruta real.';
        else t += 'La estimación en línea recta ya coincidía con la ruta real (' + money(final) + ').';
        if (rf.quedaDif) t += ' Todavía hay pequeñas diferencias en algunos tramos (se detallan en cada vehículo).';
      }
      return '<div class="verif ok-v">' + t + '</div>';
    }
    return '<div class="verif">' + (estado.calles ? 'No se pudieron obtener calles reales: ' : 'Calles reales desactivadas: ') + 'distancias estimadas en línea recta × ' + esc(pr.estimacion.circuidad) + (pr.peajes.length ? '; los peajes se detectan en línea recta (sin verificar)' : '') + '. Las rutas del mapa son líneas rectas (aprox.).</div>';
  }

  function renderResultados() {
    var cont = $('#res-contenido');
    if (!ultimo) {
      actualizarResumenMapa();
      cont.innerHTML = '<div class="card vacio"><b>Aún no hay resultados.</b><br>Completa los datos y pulsa “Optimizar rutas”. Mientras tanto puedes buscar la mejor hora de salida más abajo.</div>';
      return;
    }
    var U = ultimo, res = U.resultado, pr = U.problema, T = res.totales, h = '';
    var mpP = Object.create(null);
    pr.paradas.forEach(function (p) { mpP[p.id] = p; });
    h += '<div class="stale" id="stale" ' + (U.obsoleto ? '' : 'hidden') + '>Cambiaste datos después de calcular: estos resultados ya no corresponden. Vuelve a pulsar “Optimizar rutas”.</div>';
    if (estado.esEjemplo) h += '<div class="banner-ej">EJEMPLO – datos ficticios. Las cifras de abajo no representan ninguna operación real.</div>';

    // tarjeta de totales
    h += '<div class="card"><h2>Resumen del plan</h2><div class="kpis">' +
      '<div class="kpi grande-k"><span>Costo total</span><b>' + money(T.costo) + '</b></div>' +
      '<div class="kpi"><span>Kilómetros</span><b>' + fmt(T.km, 1) + '</b></div>' +
      '<div class="kpi"><span>Horas de jornada (suma)</span><b>' + fmt(T.min_jornada_total / 60, 1) + ' h</b></div>' +
      '<div class="kpi"><span>Peajes</span><b>' + money(T.peajes) + '</b></div>' +
      '<div class="kpi"><span>Vehículos usados</span><b>' + T.vehiculos_usados + ' de ' + totalVehiculos(pr) + '</b></div>' +
      '<div class="kpi"><span>Paradas atendidas</span><b>' + T.atendidas + ' de ' + (T.atendidas + T.no_atendidas) + '</b></div></div>';

    var ah = res.ahorro || {};
    if (ah.costo > 0.005) {
      h += '<div class="ahorro">Ahorro frente al método simple (' + esc((res.base && res.base.descripcion) || 'vecino más cercano') + '): <b>' + money(ah.costo) + '</b>' + (ah.costo_pct != null ? ' (' + fmt(ah.costo_pct, 1) + ' %)' : '') + ' · ' + (ah.km < -0.05
        ? 'usa ' + fmt(-ah.km, 1) + ' km más que el método simple pero cuesta ' + money(ah.costo) + ' menos (en total)'
        : menosMas(ah.km, 1, 'km')) + ' · ' + menosMas(ah.min, 0, 'min', ' de jornada') + '.</div>';
    } else if (ah.km > 0.05 || ah.min > 0.5) {
      h += '<div class="ahorro neutro">Frente al método simple (' + esc((res.base && res.base.descripcion) || 'vecino más cercano') + '): ' + fmt(ah.km, 1) + ' km y ' + fmt(ah.min, 0) + ' min de diferencia, pero el costo no baja (' + money(ah.costo || 0) + '). Es normal si elegiste minimizar km o tiempo, si equilibras las jornadas o si usas «evitar peajes» (el programa acepta pagar más a cambio de otra meta).</div>';
    } else {
      h += '<div class="ahorro neutro">Frente al método simple (' + esc((res.base && res.base.descripcion) || 'vecino más cercano') + ') no hay ahorro en costo: ya era igual de bueno para estos datos (o el costo subió por equilibrar jornadas o «evitar peajes»).</div>';
    }
    if (U.actual) {
      var ca = U.actual.totales.costo, d = ca - T.costo, pct = ca > 0 ? d / ca * 100 : 0;
      var extra = U.actual.no_atendidas && U.actual.no_atendidas.length ? ' <br><small>Ojo: con tu ruta actual ' + U.actual.no_atendidas.length + ' parada(s) no se podrían atender (' + esc(U.actual.no_atendidas.map(function (n) { return n.id + ': ' + n.motivo; }).join('; ')) + '), así que la comparación no es del todo pareja.</small>' : '';
      if (d > 0.005) h += '<div class="ahorro">Ahorro frente a tu ruta actual (' + money(ca) + ', ' + fmt(U.actual.totales.km, 1) + ' km): <b>' + money(d) + '</b> (' + fmt(pct, 1) + ' %) · ' + menosMas(U.actual.totales.km - T.km, 1, 'km') + '.' + extra + '</div>';
      else h += '<div class="ahorro neutro">Tu ruta actual cuesta ' + money(ca) + ' y la optimizada ' + money(T.costo) + ': no se encontró una mejora.' + extra + '</div>';
    }
    h += textoRefino(U);
    h += barrasJornada(U);
    h += '<div class="acciones"><button id="btn-exp-plan">Descargar plan (CSV)</button><button id="btn-imprimir" class="primario">Imprimir / PDF (hoja por conductor)</button><button id="btn-ir-flete">Calcular el flete a cobrar</button></div></div>';

    // no atendidas
    if (res.no_atendidas && res.no_atendidas.length) {
      h += '<div class="noat" role="alert"><b>⚠ ' + res.no_atendidas.length + ' parada(s) NO atendida(s):</b><ul>' + res.no_atendidas.map(function (n) {
        var p = mpP[n.id];
        return '<li><b>' + esc(p ? p.nombre : n.id) + '</b> <small>(' + esc(n.id) + ')</small> — ' + esc(n.motivo) + '</li>';
      }).join('') + '</ul></div>';
    }

    // por vehículo
    res.rutas.forEach(function (r, k) {
      var col = COLORES[k % COLORES.length], t = tipoDeRuta(pr, r);
      var cap = r.capacidad != null ? r.capacidad : (t && t.capacidad ? t.capacidad : null);
      var ut = r.utilizacion_pct != null ? r.utilizacion_pct : (cap ? 100 * r.carga / cap : null);
      h += '<details class="card veh" open><summary><span class="chip" style="background:' + col + '"></span>' + esc(nombreVeh(r)) + ' <span class="resumen-linea">· sale ' + esc(min2hhmm(r.salida_deposito_min)) + ' · ' + r.paradas.length + ' paradas · ' + fmt(r.km, 1) + ' km · ' + fmtDur(r.min_jornada) + ' · carga ' + fmt(r.carga, 0) + (cap ? ' / ' + fmt(cap, 0) + ' (' + fmt(ut, 0) + ' %)' : '') + ' · ' + money(r.costo.total) + '</span></summary>';
      if (r.salida_auto) {
        var t2 = t || {};
        h += '<p class="ayuda">Hora de salida elegida por el programa: <b>' + esc(min2hhmm(r.salida_deposito_min)) + '</b>' + (t2.salida_desde_min != null ? ' (rango permitido ' + esc(min2hhmm(t2.salida_desde_min)) + '–' + esc(min2hhmm(t2.salida_hasta_min)) + ')' : '') + '. Se elige la que deja más barata esta ruta (tráfico, esperas por ventanas y horas pagadas).</p>' + miniSalida(r);
      }
      if (r.salida_auto) {
        var tb = t || {}, pasoB = tb.salida_paso_min || 10, sd = r.salida_deposito_min;
        if (typeof sd === 'number' && ((typeof tb.salida_desde_min === 'number' && Math.abs(sd - tb.salida_desde_min) < pasoB) || (typeof tb.salida_hasta_min === 'number' && Math.abs(sd - tb.salida_hasta_min) < pasoB))) h += avisoBorde(sd);
      }
      h += tablaRuta(r, pr);
      h += '<p class="ayuda">Conducción ' + fmtDur(r.min_conduccion) + ' · espera ' + fmtDur(r.min_espera) + ' · atención ' + fmtDur(r.min_servicio) + ' · ' + txtFin(pr).corto + ' ' + min2hhmm(r.regreso_min) + '</p>';
      h += desgloseCosto(r.costo);
      if (r.peajes && r.peajes.length) {
        h += '<p class="ayuda">Peajes planificados: ' + r.peajes.map(function (p) { return esc(p.nombre || p.id) + ' (' + money(p.costo) + ')'; }).join(', ') + '</p>';
      }
      h += htmlVerif(U, k);
      var en = enlacesMaps(pr, r);
      h += '<div class="mapas-links"><b>Google Maps (en orden):</b>' + en.map(function (e, i) {
        return '<div class="l"><a href="' + esc(e.url) + '" target="_blank" rel="noopener">Abrir ' + (en.length > 1 ? 'tramo ' + (i + 1) + ' de ' + en.length : 'ruta') + '</a><button class="mini" data-copiar="' + esc(e.url) + '">Copiar enlace</button></div>';
      }).join('') + (en.length > 1 ? '<small class="suave">Google Maps admite 9 paradas intermedias por enlace, por eso la ruta se parte en tramos.</small>' : '') + '</div>';
      h += '</details>';
    });

    // supuestos
    var sup = (res.supuestos || []).slice();
    var hayDir = estado.paradas.some(function (p) { return p.dir || p.geo; });
    var propios = [
      'Tráfico: ' + (esTraficoPlano() ? 'sin tráfico (todas las horas con factor 1.0).' : 'perfil por hora definido por ti (no es tráfico en vivo ni datos medidos por esta aplicación).'),
      U.usoOSRM ? 'Distancias y tiempos por calles reales de OSRM (a flujo libre; el tráfico lo aplica tu perfil).' + (pr.peajes.length ? ' Los peajes se calcularon primero en línea recta y luego se verificaron con la geometría real de cada tramo' + (U.refino ? '' : ' (en curso)') + '.' : '') : (estado.calles ? 'Las calles reales no estuvieron disponibles (revisa los avisos): se usó la estimación en línea recta.' : null),
      hayDir ? 'Las ubicaciones obtenidas a partir de direcciones vienen de OpenStreetMap (Nominatim, © colaboradores de OpenStreetMap) y pueden ser inexactas: confirma las marcadas en amarillo.' : null,
      finDe(pr) === 'otro' ? 'Cada ruta termina en el depósito final «' + nomFin(pr) + '» (no regresa al de salida); el costo incluye ese último tramo.' : (finDe(pr) === 'ultima' ? 'Cada ruta termina en su última parada: no hay tramo de regreso y el costo no incluye volver al depósito.' : null),
      'Costos (por km, por hora, fijo) y tarifas de peaje: los escribiste tú; la aplicación no trae precios.',
      'Los tiempos de atención y las ventanas horarias son los de la tabla; si llegas antes de la ventana esperas.',
      'Resultado de una búsqueda heurística con tiempo limitado: no se garantiza que sea el óptimo absoluto en problemas grandes.'
    ];
    propios = propios.filter(Boolean);
    if (sup.some(function (x) { return /^Cada ruta termina/.test(String(x)); })) propios = propios.filter(function (x) { return !/^Cada ruta termina/.test(x); });
    if (estado.esEjemplo) propios.unshift('Los datos son de EJEMPLO, ficticios.');
    h += '<div class="card supuestos"><h3>Supuestos de este cálculo</h3><ul>' + sup.concat(propios).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' +
      (res.avisos && res.avisos.length ? '<h3>Avisos del motor</h3><ul>' + res.avisos.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '') +
      '<p class="ayuda">Motor v' + esc(Motor && Motor.VERSION || '?') + (res.semilla != null ? ' · semilla ' + esc(res.semilla) : '') + (res.iteraciones ? ' · ' + fmt(res.iteraciones, 0) + ' iteraciones' : '') + (res.ms ? ' · ' + fmt(res.ms, 0) + ' ms' : '') + '</p></div>';
    cont.innerHTML = h;
    actualizarResumenMapa();
  }
  function esTraficoPlano() { return estado.perfil.every(function (v) { return v === 1; }); }

  /* ===================== mejor hora de salida ===================== */
  async function barrido() {
    if (ocupado) return;
    if (!Motor) return;
    var desde = hhmm2min(estado.barrido.desde), hasta = hhmm2min(estado.barrido.hasta), paso = Math.max(5, Math.round(num(estado.barrido.paso, 30)));
    var out = $('#barrido-res');
    if (desde == null || hasta == null || hasta < desde) { out.innerHTML = '<div class="msg error">Revisa “Desde” y “Hasta”: deben ser horas válidas y “Hasta” no puede ser menor que “Desde”.</div>'; return; }
    var puntos = Math.floor((hasta - desde) / paso) + 1;
    if (puntos > 40) { out.innerHTML = '<div class="msg error">Son ' + puntos + ' horas distintas; aumenta el paso (máximo 40 puntos).</div>'; return; }
    var pr = construirProblema(), v = validarTodo(pr);
    mostrarMensajes(v.errores, v.avisos, null);
    if (!v.ok) { out.innerHTML = '<div class="msg error">Corrige primero los datos (ver mensajes abajo a la izquierda).</div>'; return; }
    var verB = versionEstado;
    setOcupado(true);
    try {
      var avisosRed = [];
      if (estado.calles) {
        out.innerHTML = '<div class="msg info">Pidiendo distancias por calles reales…</div>';
        var m = await prepararMatriz(pr, avisosRed);
        if (cancelado) { out.innerHTML = '<div class="msg aviso">Cancelaste la búsqueda de la mejor hora.</div>'; return; }
        if (versionEstado !== verB) { out.innerHTML = '<div class="msg aviso">Cambiaste datos mientras se calculaba: se descartó ese resultado. Vuelve a pulsar “Buscar mejor hora de salida”.</div>'; return; }
        if (m) pr.matriz = { km: m.km, min: m.min };
        if (avisosRed.length) mostrarMensajes([], v.avisos.concat(avisosRed), null);
      }
      var porPunto = { rapido: 250, normal: 600, profundo: 1500 }[estado.tiempo] || 600;
      var total = puntos * porPunto;
      out.innerHTML = '<div class="msg info">Calculando ' + puntos + ' horas de salida (≈ ' + Math.ceil(total / 1000) + ' s)' + (hiloOk ? '. Puedes cancelar cuando quieras.' : '. La pantalla puede quedar quieta hasta terminar…') + '</div>';
      progresoIniciar('#prog-barrido', total);
      await cederHilo();
      var r = await motorAparte('barrer', paraMotor(pr), { desde_min: desde, hasta_min: hasta, paso_min: paso, tiempo_ms_por_punto: porPunto });
      if (cancelado || (r && r.cancelado)) { progresoFin('#prog-barrido', false); out.innerHTML = '<div class="msg aviso">Cancelaste la búsqueda de la mejor hora.</div>'; return; }
      if (versionEstado !== verB) { progresoFin('#prog-barrido', false); out.innerHTML = '<div class="msg aviso">Cambiaste datos mientras se calculaba: se descartó ese resultado. Vuelve a pulsar “Buscar mejor hora de salida”.</div>'; return; }
      progresoFin('#prog-barrido', !(r && r.ok === false));
      renderBarrido(r, pr);
    } finally { setOcupado(false); }
  }
  function renderBarrido(r, pr) {
    var out = $('#barrido-res'), pts = null, mejor = null;
    if (r && r.ok === false) { out.innerHTML = '<div class="msg error">' + esc((r.errores || ['El motor no pudo calcular el barrido.']).join(' ')) + '</div>'; return; }
    if (Array.isArray(r)) { pts = r; mejor = r.mejor; }
    else if (r && typeof r === 'object') {
      pts = r.puntos || r.resultados || r.items || r.barrido || null;
      if (!pts) Object.keys(r).forEach(function (k) { if (!pts && Array.isArray(r[k])) pts = r[k]; });
      mejor = r.mejor;
    }
    if (!pts || !pts.length) { out.innerHTML = '<div class="msg error">El motor no devolvió resultados para el barrido.</div>'; return; }
    if (mejor && typeof mejor === 'object') mejor = pts.indexOf(mejor);
    if (typeof mejor !== 'number' || mejor < 0 || mejor >= pts.length) {
      mejor = 0;
      pts.forEach(function (p, i) {
        var b = pts[mejor];
        if ((p.no_atendidas || 0) < (b.no_atendidas || 0) || ((p.no_atendidas || 0) === (b.no_atendidas || 0) && p.costo < b.costo)) mejor = i;
      });
    }
    var maxC = Math.max.apply(null, pts.map(function (p) { return p.costo; })), minC = Math.min.apply(null, pts.map(function (p) { return p.costo; }));
    var W = 640, H = 250, ml = 56, mr = 8, mt = 26, mb = 44, pw = W - ml - mr, ph = H - mt - mb;
    var top = maxC * 1.08 || 1;
    var bw = pw / pts.length;
    var svg = '<svg class="barrido" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Costo total según la hora de salida. Mejor hora: ' + min2hhmm(pts[mejor].salida_min) + '">';
    for (var g = 0; g <= 4; g++) {
      var yv = top * g / 4, y = mt + ph - ph * g / 4;
      svg += '<line class="eje" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/><text x="' + (ml - 5) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + fmt(yv, 0) + '</text>';
    }
    var cadaX = Math.ceil(pts.length / 14);
    pts.forEach(function (p, i) {
      var bh = Math.max(1, ph * p.costo / top), x = ml + i * bw + bw * 0.12, y = mt + ph - bh;
      var cls = 'barra' + (i === mejor ? ' mejor' : '') + (p.no_atendidas > 0 ? ' mala' : '');
      svg += '<rect class="' + cls + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw * 0.76).toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2"><title>Salida ' + min2hhmm(p.salida_min) + ': ' + money(p.costo) + (p.no_atendidas > 0 ? ' · ' + p.no_atendidas + ' sin atender' : '') + '</title></rect>';
      if (i % cadaX === 0 || i === mejor) svg += '<text x="' + (x + bw * 0.38).toFixed(1) + '" y="' + (H - mb + 15) + '" text-anchor="middle"' + (i === mejor ? ' style="font-weight:700"' : '') + '>' + min2hhmm(p.salida_min) + '</text>';
      if (i === mejor) svg += '<text x="' + (x + bw * 0.38).toFixed(1) + '" y="' + (y - 5).toFixed(1) + '" text-anchor="middle" style="font-weight:700">Mejor</text>';
    });
    svg += '<text x="' + (ml + pw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">Hora de salida del depósito</text>';
    svg += '<text x="12" y="' + (mt + ph / 2) + '" transform="rotate(-90 12 ' + (mt + ph / 2) + ')" text-anchor="middle">Costo total (' + esc(estado.moneda) + ')</text></svg>';
    var b = pts[mejor], dif = maxC - b.costo;
    var h = svg + '<div class="ahorro">Mejor hora de salida: <b>' + min2hhmm(b.salida_min) + '</b> con un costo de <b>' + money(b.costo) + '</b>' + (b.no_atendidas > 0 ? ' (⚠ deja ' + b.no_atendidas + ' sin atender)' : '') + (dif > 0.005 ? '. Salir a la peor hora costaría ' + money(dif) + ' más.' : '. Para estos datos la hora de salida casi no cambia el costo.') + '</div>';
    if (pts.length > 1 && (mejor === 0 || mejor === pts.length - 1)) h += avisoBorde(b.salida_min);
    if (pts.some(function (p) { return p.no_atendidas > 0; })) h += '<p class="ayuda">Barras rojizas: con esa hora quedan paradas sin atender (por ejemplo, ventanas que ya no se alcanzan).</p>';
    h += '<div class="acciones"><button id="btn-usar-hora" data-min="' + b.salida_min + '">Usar ' + min2hhmm(b.salida_min) + ' como hora de salida de todos los tipos</button></div><p class="ayuda">Esto deja a todos los tipos de vehículo con salida fija a las ' + esc(min2hhmm(b.salida_min)) + ' (también a los que tenían salida automática).</p>';
    h += '<details><summary>Ver tabla</summary><div class="tabla-scroll"><table class="res"><thead><tr><th>Salida</th><th class="num">Costo</th><th class="num">Km</th><th class="num">Horas</th><th class="num">Peajes</th><th class="num">Sin atender</th></tr></thead><tbody>' +
      pts.map(function (p, i) { return '<tr' + (i === mejor ? ' style="font-weight:700"' : '') + '><td>' + min2hhmm(p.salida_min) + '</td><td class="num">' + fmt(p.costo, 2) + '</td><td class="num">' + fmt(p.km, 1) + '</td><td class="num">' + fmt((p.min_jornada_total || 0) / 60, 1) + '</td><td class="num">' + fmt(p.peajes, 2) + '</td><td class="num">' + (p.no_atendidas || 0) + '</td></tr>'; }).join('') +
      '</tbody></table></div></details>';
    out.innerHTML = h;
  }

  /* ===================== flete a cobrar ===================== */
  var BASES_TXT = {
    mixto: 'mitad según cuánto alarga la ruta cada cliente y mitad según su carga × distancia desde el depósito',
    desvio: 'según cuánto alarga la ruta cada cliente (kilómetros, minutos y peajes que aporta)',
    peso: 'según su carga × distancia desde el depósito (toneladas-km)',
    igual: 'en partes iguales entre los clientes del mismo vehículo'
  };
  function tarifaDeEstado() {
    var T = estado.tarifa, pct = num(T.pct, NaN);
    var o = {
      tipo_margen: T.tipo_margen === 'margen' ? 'margen' : 'markup',
      igv_pct: num(T.igv_pct, 0),
      base_prorrateo: T.base,
      minimo_parada: num(T.minimo, 0),
      redondeo: num(T.redondeo, 0)
    };
    if (isFinite(pct)) o.pct = pct;   // sin porcentaje el motor responde «indica el margen»
    return o;
  }
  function calcularFleteUI() {
    if (!ultimo) return null;
    if (!esMotor11()) return { ok: false, errores: ['Este motor.js (v' + ((Motor && Motor.VERSION) || '?') + ') no incluye el cálculo de flete. Usa la versión 1.1 o posterior.'] };
    var t = tarifaDeEstado(), f;
    try { f = Motor.calcularFlete(ultimo.problema, ultimo.resultado, t); }
    catch (e) { f = { ok: false, errores: ['Error al calcular el flete: ' + e.message] }; }
    ultimo.flete = { tarifa: t, res: f };
    return f;
  }
  function fletePct(x) { return typeof x === 'number' && isFinite(x) ? fmt(x, 1) + ' %' : '—'; }

  function renderFlete() {
    var cont = $('#flete-contenido');
    if (!cont) return;
    if (!ultimo) {
      cont.innerHTML = '<div class="card vacio"><b>Aún no hay rutas calculadas.</b><br>El flete se calcula a partir del costo de cada ruta: primero pulsa “Optimizar rutas” y vuelve aquí.</div>';
      return;
    }
    var f = calcularFleteUI(), U = ultimo, h = '';
    if (U.obsoleto) h += '<div class="stale">Cambiaste datos después de calcular las rutas: este flete corresponde al último cálculo. Vuelve a pulsar “Optimizar rutas” para actualizarlo.</div>';
    if (estado.esEjemplo) h += '<div class="banner-ej">EJEMPLO – datos ficticios: este flete no representa ninguna operación real.</div>';
    if (!f.ok) {
      h += '<div class="msg error"><b>No se pudo calcular el flete:</b><ul>' + (f.errores || ['Error desconocido.']).map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></div>';
      cont.innerHTML = h;
      return;
    }
    var T = f.totales, igvP = num(estado.tarifa.igv_pct, 0), pisoIgv = (f.piso.flete_sin_igv || 0) * igvP / 100;
    h += '<div class="card"><h2>Resumen del flete</h2><div class="kpis">' +
      '<div class="kpi"><span>Tu costo (real)</span><b>' + money(T.costo) + '</b></div>' +
      '<div class="kpi grande-k"><span>Flete sin IGV</span><b>' + money(T.flete_sin_igv) + '</b></div>' +
      (igvP > 0 ? '<div class="kpi"><span>IGV (' + esc(fmt(igvP, igvP % 1 ? 1 : 0)) + ' %)</span><b>' + money(T.igv) + '</b></div>' : '') +
      '<div class="kpi"><span>' + (igvP > 0 ? 'Total con IGV' : 'Total') + '</span><b>' + money(T.flete_total) + '</b></div>' +
      '<div class="kpi"><span>Ganancia (sin IGV)</span><b>' + money(T.ganancia) + '</b></div>' +
      '<div class="kpi"><span>Markup sobre costo</span><b>' + fletePct(T.markup_pct) + '</b></div>' +
      '<div class="kpi"><span>Margen sobre precio</span><b>' + fletePct(T.margen_pct) + '</b></div></div>';
    h += '<div class="ahorro neutro">Piso para no perder: <b>' + money(f.piso.flete_sin_igv) + '</b> sin IGV' + (igvP > 0 ? ' (' + money(f.piso.flete_sin_igv + pisoIgv) + ' con IGV)' : '') + ' en total para esta carga de trabajo. Por debajo de eso pierdes dinero, aunque el cliente acepte.</div>';
    var aj = [];
    if (Math.abs(T.ajuste_redondeo || 0) > 0.005) aj.push('el redondeo sumó ' + moneyTxt(T.ajuste_redondeo));
    if (Math.abs(T.ajuste_minimos || 0) > 0.005) aj.push('el mínimo por parada sumó ' + moneyTxt(T.ajuste_minimos));
    if (aj.length) h += '<p class="ayuda">Sobre el precio teórico (costo con el margen aplicado): ' + esc(aj.join(' y ')) + '.</p>';
    if (f.no_atendidas && f.no_atendidas.length) h += '<div class="noat" role="alert"><b>Sin flete (no atendidas):</b> ' + esc(f.no_atendidas.join(', ')) + '. Esas paradas no tienen ruta; revisa por qué en Resultados.</div>';
    h += '<p class="msg aviso">Este flete depende por completo de los costos que ingresaste (costo por km, por hora, fijo, peajes) y del margen que elegiste. Si esos números no son reales, el precio tampoco lo será. No es una tarifa oficial.</p></div>';

    // por ruta
    h += '<div class="card"><h2>Por vehículo (ruta)</h2><div class="tabla-scroll"><table class="res"><thead><tr><th>Vehículo</th><th class="num">Costo</th><th class="num">Precio sin IGV</th><th class="num">IGV</th><th class="num">Total</th><th class="num">Por km</th><th class="num">Por hora</th><th class="num">Utilización</th></tr></thead><tbody>' +
      f.rutas.map(function (r) {
        return '<tr><td>' + esc(r.vehiculo_nombre) + '</td><td class="num">' + money(r.costo) + '</td><td class="num">' + money(r.precio_sin_igv) + '</td><td class="num">' + money(r.igv) + '</td><td class="num"><b>' + money(r.precio_total) + '</b></td><td class="num">' + (r.por_km != null ? money(r.por_km) : '—') + '</td><td class="num">' + (r.por_hora != null ? money(r.por_hora) : '—') + '</td><td class="num">' + (r.utilizacion_pct != null ? fmt(r.utilizacion_pct, 0) + ' %' : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="ayuda">“Por km” y “por hora” = precio sin IGV ÷ kilómetros y ÷ horas de jornada de esa ruta. “Utilización” = carga ÷ capacidad.</p></div>';

    // por cliente
    var mpP = Object.create(null);
    U.problema.paradas.forEach(function (p) { mpP[p.id] = p; });
    var mpR = Object.create(null);
    f.rutas.forEach(function (r) { mpR[r.vehiculo] = r.vehiculo_nombre; });
    h += '<div class="card"><h2>Por cliente</h2><div class="tabla-scroll"><table class="res"><thead><tr><th>Cliente</th><th>Vehículo</th><th class="num">Demanda</th><th class="num" title="Parte del costo real de la ruta que se le asignó (dato interno, no se imprime en la cotización)">Costo asignado (interno)</th><th class="num">Flete sin IGV</th><th class="num">IGV</th><th class="num">Flete con IGV</th></tr></thead><tbody>' +
      f.paradas.map(function (p) {
        return '<tr><td>' + esc(p.nombre) + ' <small class="suave">' + esc(p.id) + '</small></td><td>' + esc(mpR[p.vehiculo] || ('Vehículo ' + p.vehiculo)) + '</td><td class="num">' + fmt(p.demanda, 0) + '</td><td class="num">' + money(p.costo_asignado) + '</td><td class="num"><b>' + money(p.flete_sin_igv) + '</b></td><td class="num">' + money(p.igv) + '</td><td class="num"><b>' + money(p.flete_total) + '</b></td></tr>';
      }).join('') + '</tbody><tfoot><tr><td colspan="3">Total</td><td class="num">' + money(T.costo) + '</td><td class="num">' + money(T.flete_sin_igv) + '</td><td class="num">' + money(T.igv) + '</td><td class="num">' + money(T.flete_total) + '</td></tr></tfoot></table></div>' +
      '<div class="acciones"><button id="btn-fl-copiar">Copiar CSV</button><button id="btn-fl-csv">Descargar CSV</button><button id="btn-fl-cotiz" class="primario">Imprimir cotizaciones (BORRADOR)</button></div>' +
      '<p class="ayuda">Las cotizaciones salen una por cliente, con el flete sin IGV, el IGV y el total. No muestran tu costo ni tu margen. Son un BORRADOR para que las revises: no son una factura ni un comprobante de pago.</p></div>';

    // explicación
    var tp = U.flete.tarifa, base = BASES_TXT[tp.base_prorrateo] || BASES_TXT.mixto;
    h += '<div class="card"><h2>Cómo se calculó</h2><ol class="explica">' +
      '<li>Se toma el <b>costo real de cada ruta</b>, calculado con tus costos: parte fija del vehículo, kilómetros, horas del conductor y peajes.</li>' +
      '<li>Ese costo se <b>reparte entre los clientes de la misma ruta</b>, ' + esc(base) + '. Cada parte del costo (km, horas, peajes) se reparte por separado. Es un criterio comercial: otro reparto daría otros precios por cliente, pero el total de la ruta es el mismo.</li>' +
      '<li>A la parte de cada cliente se le aplica el <b>' + (tp.tipo_margen === 'margen' ? 'margen: precio = costo ÷ (1 − ' + esc(fmt(tp.pct, 1)) + ' %)' : 'markup: precio = costo × (1 + ' + esc(fmt(tp.pct, 1)) + ' %)') + '</b>.</li>' +
      '<li>Si pusiste un <b>mínimo por parada</b>, ningún cliente paga menos que eso; si pusiste <b>redondeo</b>, el flete sube hasta el múltiplo más cercano hacia arriba.</li>' +
      '<li>Al final se suma el <b>IGV</b> (' + esc(fmt(tp.igv_pct, 1)) + ' %) sobre el flete de cada cliente.</li></ol>';
    if (f.supuestos && f.supuestos.length) h += '<details><summary>Supuestos del motor</summary><ul>' + f.supuestos.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></details>';
    h += '</div>';
    cont.innerHTML = h;
  }
  var renderFleteDeb = debounce(function () { renderFlete(); }, 250);

  function textoFleteCSV() {
    var f = ultimo && ultimo.flete && ultimo.flete.res;
    if (!f || !f.ok) return null;
    var sep = estado.csvSep === ';' ? ';' : ',';
    var mp = Object.create(null);
    ultimo.problema.paradas.forEach(function (p) { mp[p.id] = p; });
    var nv = Object.create(null);
    f.rutas.forEach(function (r) { nv[r.vehiculo] = r.vehiculo_nombre; });
    var igvP = num(estado.tarifa.igv_pct, 0);
    var cab = ['id', 'cliente', 'direccion', 'vehiculo', 'demanda', 'costo_asignado', 'flete_sin_igv', 'igv', 'flete_total'];
    var L = [filaCsv(cab, sep)];
    function vac(n) { var a = []; for (var i = 0; i < n; i++) a.push(''); return a; }
    L.push(filaCsv(['BORRADOR - no es comprobante de pago' + (estado.esEjemplo ? ' - EJEMPLO datos ficticios' : '')].concat(vac(cab.length - 1)), sep));
    var dirDe = Object.create(null);
    estado.paradas.forEach(function (p) { dirDe[p.id] = p.dir || ''; });
    f.paradas.forEach(function (p) {
      L.push(filaCsv([p.id, p.nombre, dirDe[p.id] || '', nv[p.vehiculo] || ('Vehiculo ' + p.vehiculo), numCsv(p.demanda, 2, sep), numCsv(p.costo_asignado, 2, sep), numCsv(p.flete_sin_igv, 2, sep), numCsv(p.igv, 2, sep), numCsv(p.flete_total, 2, sep)], sep));
    });
    var T = f.totales;
    L.push(filaCsv(['TOTAL', '', '', '', '', numCsv(T.costo, 2, sep), numCsv(T.flete_sin_igv, 2, sep), numCsv(T.igv, 2, sep), numCsv(T.flete_total, 2, sep)], sep));
    L.push(filaCsv(['IGV aplicado (%)', numCsv(igvP, 2, sep), '', '', '', '', '', '', ''], sep));
    L.push(filaCsv(['Moneda', estado.moneda, '', '', '', '', '', '', ''], sep));
    return L.join('\r\n') + '\r\n';
  }

  /* ===================== hojas imprimibles ===================== */
  function hojaFechaHoy() { return new Date().toLocaleDateString('es-PE', { year: 'numeric', month: 'long', day: 'numeric' }); }
  function construirHojas() {
    if (!ultimo) return;
    var U = ultimo, pr = U.problema, mp = Object.create(null);
    pr.paradas.forEach(function (p) { mp[p.id] = p; });
    var hoy = hojaFechaHoy();
    $('#hojas').innerHTML = U.resultado.rutas.map(function (r) {
      var en = enlacesMaps(pr, r);
      return '<section class="hoja"><h2>Hoja de ruta — ' + esc(nombreVeh(r)) + (estado.esEjemplo ? ' <span class="etiqueta-ej">EJEMPLO – datos ficticios</span>' : '') + '</h2>' +
        '<p>Fecha de impresión: ' + esc(hoy) + ' · Salida del depósito (' + esc(pr.deposito.nombre) + '): <b>' + esc(min2hhmm(r.salida_deposito_min)) + '</b> · ' + esc(txtFin(pr).largo) + ': <b>' + esc(min2hhmm(r.regreso_min)) + '</b><br>' +
        r.paradas.length + ' paradas · ' + fmt(r.km, 1) + ' km · carga ' + fmt(r.carga, 0) + ' · Conductor: ______________________ · Placa: ____________</p>' +
        '<table><thead><tr><th>#</th><th>Cliente / parada</th><th>Llegada</th><th>Atención</th><th>Salida</th><th>Demanda</th><th>Ventana</th><th>Recibido (firma)</th></tr></thead><tbody>' +
        r.paradas.map(function (s, i) {
          var p = mp[s.id] || {};
          return '<tr><td>' + (i + 1) + '</td><td>' + esc(s.nombre) + '<br><small>' + esc(s.id) + ' · ' + (p.lat != null ? esc(p.lat.toFixed(5) + ', ' + p.lon.toFixed(5)) : '') + '</small></td><td>' + esc(min2hhmm(s.llegada_min)) + '</td><td>' + esc(min2hhmm(s.inicio_servicio_min)) + '</td><td>' + esc(min2hhmm(s.salida_min)) + '</td><td>' + fmt(p.demanda || 0, 0) + '</td><td>' + esc(ventanaTxt(p.ventana)) + '</td><td class="firma"></td></tr>';
        }).join('') + (finDe(pr) === 'otro' ? '<tr><td></td><td><b>' + esc(txtFin(pr).fila) + '</b><br><small>' + (pr.deposito_final ? esc(pr.deposito_final.lat.toFixed(5) + ', ' + pr.deposito_final.lon.toFixed(5)) : '') + '</small></td><td>' + esc(min2hhmm(r.regreso_min)) + '</td><td></td><td></td><td></td><td></td><td class="firma"></td></tr>' : '') + '</tbody></table>' +
        '<p><b>Navegación (Google Maps):</b></p>' + en.map(function (e, i) { return '<p><small>' + (en.length > 1 ? 'Tramo ' + (i + 1) + ': ' : '') + '<a href="' + esc(e.url) + '">' + esc(e.url) + '</a></small></p>'; }).join('') +
        '<p class="pie">Horas estimadas con el perfil de tráfico definido por el planificador (no es tráfico en vivo). Pueden variar en la calle.</p></section>';
    }).join('');
  }
  function construirCotizaciones() {
    var f = ultimo && ultimo.flete && ultimo.flete.res;
    if (!f || !f.ok) return false;
    var pr = ultimo.problema, hoy = hojaFechaHoy(), igvP = num(estado.tarifa.igv_pct, 0), dirDe = Object.create(null);
    estado.paradas.forEach(function (p) { dirDe[p.id] = p.dir || ''; });
    $('#hojas').innerHTML = f.paradas.map(function (p, i) {
      return '<section class="hoja cotiz"><div class="sello">BORRADOR — no es un comprobante de pago</div>' +
        '<h2>Cotización de flete' + (estado.esEjemplo ? ' <span class="etiqueta-ej">EJEMPLO – datos ficticios</span>' : '') + '</h2>' +
        '<table class="kv"><tbody>' +
        '<tr><th>Fecha</th><td>' + esc(hoy) + '</td></tr>' +
        '<tr><th>Cotización N.º</th><td>______ (completar)</td></tr>' +
        '<tr><th>Cliente</th><td>' + esc(p.nombre) + ' <small>(' + esc(p.id) + ')</small></td></tr>' +
        '<tr><th>Dirección de entrega</th><td>' + esc(dirDe[p.id] || '—') + '</td></tr>' +
        '<tr><th>Servicio</th><td>Transporte y entrega desde ' + esc(pr.deposito.nombre) + '</td></tr>' +
        '<tr><th>Carga</th><td>' + esc(fmt(p.demanda, 0)) + (p.demanda ? '' : ' (no indicada)') + '</td></tr>' +
        '</tbody></table>' +
        '<table><thead><tr><th>Concepto</th><th class="num">Importe (' + esc(estado.moneda) + ')</th></tr></thead><tbody>' +
        '<tr><td>Flete (sin IGV)</td><td class="num">' + esc(fmt(p.flete_sin_igv, 2)) + '</td></tr>' +
        (igvP > 0 ? '<tr><td>IGV (' + esc(fmt(igvP, igvP % 1 ? 1 : 0)) + ' %)</td><td class="num">' + esc(fmt(p.igv, 2)) + '</td></tr>' : '') +
        '<tr><td><b>Total</b></td><td class="num"><b>' + esc(fmt(p.flete_total, 2)) + '</b></td></tr></tbody></table>' +
        '<p>Validez de la oferta: ______ días · Condiciones de pago: ______________________</p>' +
        '<p class="pie">Documento referencial preparado con una herramienta de planificación de rutas. Es un BORRADOR sujeto a revisión y aprobación de la gerencia; no es una factura, boleta ni comprobante de pago y no tiene valor tributario. Cotización ' + (i + 1) + ' de ' + f.paradas.length + '.</p></section>';
    }).join('');
    return true;
  }

  /* ===================== mapa: tamaño, ampliar y resumen superpuesto ===================== */
  var ALTO_MAPA_KEY = 'optimizador-rutas-mapa-alto';
  function refrescarMapa() { if (mapa) { setTimeout(function () { mapa.invalidateSize(); }, 30); setTimeout(function () { mapa.invalidateSize(); }, 250); } }
  function mapaAmpliado() { return $('#mapa-zona').classList.contains('ampliado'); }
  function altoMapaActual() { return Math.round($('#mapa-caja').getBoundingClientRect().height); }
  // Límites del alto del mapa: en teléfono nunca más del 55 % de la ventana (para que «Optimizar» siga a la vista)
  function limitesAlto() {
    var movil = window.innerWidth < 900, min = movil ? 240 : 380;   // 240 = min-height del CSS en teléfono
    return { min: min, max: Math.max(min, Math.round(window.innerHeight * (movil ? 0.55 : 0.92))) };
  }
  // px = 0 vuelve al alto automático (≈ 58 % de la ventana en escritorio, ≈ 42 % en teléfono).
  // Con el mapa ampliado no se mide ni se guarda nada (la caja ampliada ocupa toda la pantalla).
  function fijarAltoMapa(px, guardar) {
    if (mapaAmpliado()) return;
    var caja = $('#mapa-caja'), L = limitesAlto();
    if (!px) caja.style.height = '';
    else caja.style.height = clamp(Math.round(px), L.min, L.max) + 'px';
    if (guardar) { try { if (px) localStorage.setItem(ALTO_MAPA_KEY, String(clamp(Math.round(px), L.min, L.max))); else localStorage.removeItem(ALTO_MAPA_KEY); } catch (e) { /* sin almacenamiento */ } }
    actualizarAsa();
    refrescarMapa();
  }
  // La manija es un «separator» enfocable: expone el alto actual a los lectores de pantalla
  function actualizarAsa() {
    var asa = $('#mapa-asa'), L = limitesAlto(), h = altoMapaActual();
    if (!asa || mapaAmpliado()) return;
    asa.setAttribute('aria-valuemin', String(L.min));
    asa.setAttribute('aria-valuemax', String(L.max));
    asa.setAttribute('aria-valuenow', String(clamp(h, L.min, L.max)));
    asa.setAttribute('aria-valuetext', 'Alto del mapa: ' + h + ' píxeles');
  }
  // «Ampliar mapa» como diálogo: el resto de la página queda inerte, el foco se queda dentro y vuelve al botón al cerrar
  var inertes = [];
  function aislarResto(si) {
    var z = $('#mapa-zona'), nodo = z;
    if (si) {
      inertes = [];
      while (nodo && nodo !== document.documentElement) {
        var padre = nodo.parentElement;
        if (!padre) break;
        for (var h = padre.firstElementChild; h; h = h.nextElementSibling) {
          if (h === nodo || /^(SCRIPT|STYLE|LINK|META)$/.test(h.tagName)) continue;
          inertes.push({ el: h, inert: !!h.inert, hidden: h.getAttribute('aria-hidden') });
          h.inert = true; h.setAttribute('aria-hidden', 'true');
        }
        nodo = padre;
      }
    } else {
      inertes.forEach(function (o) {
        o.el.inert = o.inert;
        if (o.hidden == null) o.el.removeAttribute('aria-hidden'); else o.el.setAttribute('aria-hidden', o.hidden);
      });
      inertes = [];
    }
  }
  function enfocablesMapa() {
    return $$('#mapa-zona button, #mapa-zona input, #mapa-zona select, #mapa-zona a[href], #mapa-zona [tabindex]').filter(function (el) {
      return !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden]') && el.getClientRects().length > 0;
    });
  }
  function ampliarMapa(si) {
    var z = $('#mapa-zona'), b = $('#btn-mapa-ampliar');
    if (si === mapaAmpliado()) return;
    z.classList.toggle('ampliado', si);
    document.body.classList.toggle('mapa-ampliado', si);
    if (si) { z.setAttribute('role', 'dialog'); z.setAttribute('aria-modal', 'true'); z.setAttribute('aria-label', 'Mapa ampliado'); }
    else { z.removeAttribute('role'); z.removeAttribute('aria-modal'); z.setAttribute('aria-label', 'Mapa'); }
    aislarResto(si);
    b.textContent = si ? 'Volver (Esc)' : 'Ampliar mapa';
    b.setAttribute('aria-expanded', si ? 'true' : 'false');
    $('#btn-mapa-mas').disabled = si; $('#btn-mapa-menos').disabled = si;
    refrescarMapa();
    if (si) b.focus(); else { b.focus({ preventScroll: true }); actualizarAsa(); }
  }
  /* ----- resumen superpuesto: se puede plegar y se recuerda la elección ----- */
  var RESUMEN_KEY = 'optimizador-rutas-resumen-plegado';
  function resumenPlegado() {
    try { var v = localStorage.getItem(RESUMEN_KEY); if (v === '1') return true; if (v === '0') return false; } catch (e) { /* nada */ }
    return window.innerWidth < 560;   // sin elección guardada: plegado en teléfono para no tapar el mapa
  }
  function fijarResumenPlegado(si, guardar) {
    var el = $('#mapa-resumen'), b = $('#btn-resumen-plegar');
    el.classList.toggle('plegado', si);
    if (b) { b.textContent = si ? 'Mostrar resumen' : 'Ocultar resumen'; b.setAttribute('aria-expanded', si ? 'false' : 'true'); }
    if (guardar) { try { localStorage.setItem(RESUMEN_KEY, si ? '1' : '0'); } catch (e) { /* sin almacenamiento */ } }
  }
  function enlazarMapaUI() {
    try { var g = parseInt(localStorage.getItem(ALTO_MAPA_KEY), 10); if (g > 0) fijarAltoMapa(g, false); } catch (e) { /* nada */ }
    actualizarAsa();
    window.addEventListener('resize', function () {
      if (mapaAmpliado()) return;
      var caja = $('#mapa-caja'), h = parseInt(caja.style.height, 10);
      if (h > 0) fijarAltoMapa(h, false);   // vuelve a aplicar los topes (p. ej. al girar el teléfono); no guarda
      else actualizarAsa();
    });
    $('#btn-mapa-mas').addEventListener('click', function () { fijarAltoMapa(altoMapaActual() + 80, true); });
    $('#btn-mapa-menos').addEventListener('click', function () { fijarAltoMapa(altoMapaActual() - 80, true); });
    $('#btn-mapa-ampliar').addEventListener('click', function () { ampliarMapa(!mapaAmpliado()); });
    document.addEventListener('keydown', function (e) {
      if (!mapaAmpliado()) return;
      if (e.key === 'Escape') { e.preventDefault(); ampliarMapa(false); return; }
      if (e.key !== 'Tab') return;
      // trampa de foco: Tab y Mayús+Tab dan la vuelta dentro del mapa ampliado
      var f = enfocablesMapa();
      if (!f.length) { e.preventDefault(); return; }
      var primero = f[0], ultimoF = f[f.length - 1], act = document.activeElement;
      if (e.shiftKey && (act === primero || f.indexOf(act) < 0)) { e.preventDefault(); ultimoF.focus(); }
      else if (!e.shiftKey && (act === ultimoF || f.indexOf(act) < 0)) { e.preventDefault(); primero.focus(); }
    });
    var asa = $('#mapa-asa'), y0 = 0, h0 = 0, arrastrandoAsa = false;
    asa.addEventListener('pointerdown', function (e) { if (mapaAmpliado()) return; arrastrandoAsa = true; y0 = e.clientY; h0 = altoMapaActual(); try { asa.setPointerCapture(e.pointerId); } catch (x) { /* nada */ } e.preventDefault(); });
    asa.addEventListener('pointermove', function (e) { if (arrastrandoAsa) fijarAltoMapa(h0 + (e.clientY - y0), false); });
    ['pointerup', 'pointercancel'].forEach(function (n) { asa.addEventListener(n, function () { if (arrastrandoAsa) { arrastrandoAsa = false; fijarAltoMapa(altoMapaActual(), true); } }); });
    asa.addEventListener('keydown', function (e) {
      var paso = e.key === 'PageUp' || e.key === 'PageDown' ? 160 : 40;
      if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); fijarAltoMapa(altoMapaActual() - paso, true); }
      else if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); fijarAltoMapa(altoMapaActual() + paso, true); }
      else if (e.key === 'Home') { e.preventDefault(); fijarAltoMapa(0, true); }                       // alto automático
      else if (e.key === 'End') { e.preventDefault(); fijarAltoMapa(limitesAlto().max, true); }       // alto máximo permitido
    });
    $('#mapa-resumen').addEventListener('click', function (e) {
      if (e.target.closest('#btn-resumen-plegar')) { fijarResumenPlegado(!$('#mapa-resumen').classList.contains('plegado'), true); return; }
      if (!e.target.closest('#btn-resumen-ver')) return;
      if (mapaAmpliado()) ampliarMapa(false);   // devuelve el foco al botón «Ampliar mapa»
      irTab('res');
      var t = $('.tabs'); if (t && t.scrollIntoView) t.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
  // Panel pequeño sobre el mapa con el resultado vigente (todo número pasa por fmt/money; los textos por esc)
  function actualizarResumenMapa() {
    var el = $('#mapa-resumen');
    if (!el) return;
    if (!ultimo || !ultimo.resultado || !ultimo.resultado.totales) { el.hidden = true; el.innerHTML = ''; return; }
    var T = ultimo.resultado.totales, ah = ultimo.resultado.ahorro || {}, vp = ultimo.problema;
    el.innerHTML = '<button type="button" id="btn-resumen-plegar" class="mini mr-plegar" aria-controls="mr-cuerpo" aria-expanded="true">Ocultar resumen</button><div id="mr-cuerpo" class="mr-cuerpo">' +
      '<div class="mr-linea"><b>' + money(T.costo) + '</b> · ' + fmt(T.km, 1) + ' km · ' + esc(T.vehiculos_usados) + (T.vehiculos_usados === 1 ? ' vehículo' : ' vehículos') + '</div>' +
      (ultimo.obsoleto ? '<div class="mr-linea mr-obs">Desactualizado: cambiaste datos</div>' : (ah.costo > 0.005 ? '<div class="mr-linea">Ahorro: ' + money(ah.costo) + '</div>' : '')) +
      '<div class="mr-linea mr-fin">' + esc(finDe(vp) === 'otro' ? 'Termina en ' + nomFin(vp) : (finDe(vp) === 'ultima' ? 'Termina en la última parada' : 'Regresa al depósito')) + '</div>' +
      '<button type="button" id="btn-resumen-ver" class="mini">Ver resultados</button></div>';
    el.hidden = false;
    fijarResumenPlegado(resumenPlegado(), false);
  }

  /* ===================== pestañas ===================== */
  var TABS = ['datos', 'flota', 'peajes', 'trafico', 'res', 'flete'];
  function irTab(id) {
    TABS.forEach(function (t) {
      var sel = t === id;
      $('#tab-' + t).setAttribute('aria-selected', sel ? 'true' : 'false');
      $('#tab-' + t).tabIndex = sel ? 0 : -1;
      $('#pane-' + t).hidden = !sel;
    });
    if (id === 'flete') renderFlete();
    if (mapa) setTimeout(function () { mapa.invalidateSize(); }, 50);
  }

  function actualizarCalcTipos() {
    $$('#tipos-lista .tipo').forEach(function (card) {
      var t = estado.flota.tipos[+card.dataset.i], r = card.querySelector('.calc-res');
      if (t && r) r.textContent = textoCalcTipo(t);
    });
  }

  /* ===================== eventos ===================== */
  function enlazar() {
    enlazarMapaUI();
    // botón fijo de abajo (celular): hace lo mismo que el botón grande y refleja su estado
    var of = $('#btn-optimizar-fijo'), cf = $('#btn-cancelar-fijo'), ec = $('#estado-calc'), ef = $('#estado-fijo');
    if (of) of.addEventListener('click', optimizarClick);
    if (cf) cf.addEventListener('click', cancelarCalculo);
    if (ec && ef && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () { ef.textContent = ec.textContent; ef.hidden = !(ocupado && ec.textContent); }).observe(ec, { childList: true, characterData: true, subtree: true });
    }
    var tt = $('#toast'); if (tt) tt.addEventListener('click', function () { tt.hidden = true; });

    // pestañas
    $$('.tabs [role="tab"]').forEach(function (b, i, all) {
      b.addEventListener('click', function () { irTab(b.id.replace('tab-', '')); });
      b.addEventListener('keydown', function (e) {
        var j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
        if (j == null) return;
        j = (j + all.length) % all.length;
        all[j].focus(); irTab(all[j].id.replace('tab-', '')); e.preventDefault();
      });
    });

    // campos vinculados al estado
    document.addEventListener('input', function (e) {
      var el = e.target.closest ? e.target.closest('[data-k]') : null;
      if (!el) return;
      var k = el.dataset.k;
      setPath(estado, k, el.type === 'checkbox' ? el.checked : el.value);
      if (k === 'moneda') { if (!estado.moneda) estado.moneda = 'S/'; $$('.mon').forEach(function (s) { s.textContent = estado.moneda; }); actualizarCalcTipos(); renderFleteDeb(); }
      if (k === 'calles') $('#nota-osrm').hidden = !estado.calles;
      // la tarifa solo cambia el precio, no las rutas: no invalida los resultados
      if (k.indexOf('tarifa.') === 0) { guardarLocalDeb(); renderFleteDeb(); return; }
      var soloMapa = (k === 'deposito.lat' || k === 'deposito.lon' || k === 'deposito.nombre' || k.indexOf('depositoFinal.') === 0);
      cambio({ mapa: soloMapa });
    });

    // tipos de vehículo
    var tl = $('#tipos-lista');
    tl.addEventListener('input', function (e) {
      var card = e.target.closest('.tipo'), f = e.target.dataset.f;
      if (!card || !f) return;
      var t = estado.flota.tipos[+card.dataset.i];
      if (!t) return;
      setPath(t, f, e.target.value);
      if (f === 'nombre') { var h3 = card.querySelector('h3'); if (h3 && h3.firstChild) h3.firstChild.nodeValue = (e.target.value || 'Vehículo') + ' '; }
      if (f.indexOf('calc.') === 0) card.querySelector('.calc-res').textContent = textoCalcTipo(t);
      if (f === 'salida_modo') {
        var i = +card.dataset.i;
        renderTipos();
        var s = $('#t' + i + '-modo'); if (s) s.focus();
      }
      cambio({ mapa: false });
    });
    tl.addEventListener('click', function (e) {
      var card = e.target.closest('.tipo');
      if (!card) return;
      var i = +card.dataset.i, t = estado.flota.tipos[i];
      if (!t) return;
      if (e.target.closest('[data-del-tipo]')) {
        if (estado.flota.tipos.length < 2) return;
        estado.flota.tipos.splice(i, 1);
        renderTipos(); cambio({ mapa: false });
      } else if (e.target.closest('[data-usar-calc]')) {
        var v = costoKmCalc(t);
        if (!isFinite(v)) { toast('Completa km por galón y precio por galón primero.'); return; }
        t.costo_km = String(Math.round(v * 1000) / 1000);
        var inp = card.querySelector('[data-f="costo_km"]'); if (inp) inp.value = t.costo_km;
        cambio({ mapa: false });
        toast('Costo por km de “' + (t.nombre || 'este tipo') + '”: ' + estado.moneda + ' ' + t.costo_km);
      }
    });
    $('#btn-agregar-tipo').addEventListener('click', function () {
      if (estado.flota.tipos.length >= MAX_TIPOS) { toast('Máximo ' + MAX_TIPOS + ' tipos de vehículo.'); return; }
      var n = estado.sigT++, usados = Object.create(null);
      estado.flota.tipos.forEach(function (t) { usados[t.id] = 1; });
      var t = tipoVacio(n);
      while (usados[t.id]) { n = estado.sigT++; t = tipoVacio(n); }
      t.nombre = 'Vehículo tipo ' + (estado.flota.tipos.length + 1);
      estado.flota.tipos.push(t);
      renderTipos(); cambio({ mapa: false });
      var nuevo = $('#tipos-lista .tipo:last-child [data-f="nombre"]'); if (nuevo) { nuevo.focus(); nuevo.select(); }
    });

    // tabla de paradas / peajes
    function tabla(selector, arr, alBorrar) {
      var t = $(selector + ' tbody');
      t.addEventListener('input', function (e) {
        var tr = e.target.closest('tr'), f = e.target.dataset.f;
        if (!tr || !f || tr.dataset.i == null) return;
        arr()[+tr.dataset.i][f] = e.target.value;
        cambio({ mapa: f === 'lat' || f === 'lon' || f === 'nombre' });
      });
      t.addEventListener('click', function (e) {
        var b = e.target.closest('[data-del]');
        if (!b) return;
        var tr = b.closest('tr');
        arr().splice(+tr.dataset.i, 1);
        alBorrar(); cambio();
      });
    }
    tabla('#tabla-paradas', function () { return estado.paradas; }, renderParadas);
    tabla('#tabla-peajes', function () { return estado.peajes; }, renderPeajes);

    // paradas: si se corrige a mano la ubicación, la marca de dirección dudosa ya no aplica
    $('#tabla-paradas tbody').addEventListener('change', function (e) {
      var tr = e.target.closest('tr'), f = e.target.dataset.f;
      if (!tr || (f !== 'lat' && f !== 'lon')) return;
      var p = estado.paradas[+tr.dataset.i];
      if (p && (p.geo === 'dudosa' || p.geo === 'sin')) { p.geo = ''; renderParadas(); dibujarMapa(false); }
    });
    $('#tabla-paradas tbody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr');
      if (!tr || tr.dataset.i == null) return;
      var p = estado.paradas[+tr.dataset.i];
      if (!p) return;
      if (e.target.closest('[data-geo-elegir]')) elegirParaParada(p.id);
      else if (e.target.closest('[data-geo-ok]')) { p.geo = 'ok'; renderParadas(); cambio(); toast('Dirección de ' + p.id + ' confirmada.'); }
    });

    $('#btn-agregar-fila').addEventListener('click', function () {
      if (estado.paradas.length >= MAX_PARADAS) { toast(msgTopeParadas()); return; }
      nuevaParada({});
      renderParadas(); cambio();
      var tr = $('#tabla-paradas tbody tr:last-child [data-f="nombre"]'); if (tr) { tr.focus(); tr.select(); }
    });
    $('#btn-quitar-todas').addEventListener('click', function () {
      if (!estado.paradas.length) return;
      if (!confirm('¿Quitar las ' + estado.paradas.length + ' paradas?')) return;
      estado.paradas = []; renderParadas(); cambio();
    });
    $('#btn-agregar-peaje').addEventListener('click', function () {
      var id = 'P' + (estado.sigP++);
      estado.peajes.push({ id: id, nombre: 'Peaje ' + id, lat: '', lon: '', costo: '', radio: '300' });
      renderPeajes(); cambio();
    });
    $('#btn-quitar-peajes').addEventListener('click', function () {
      if (!estado.peajes.length) return;
      if (!confirm('¿Quitar todos los peajes?')) return;
      estado.peajes = []; renderPeajes(); cambio();
    });

    // búsqueda de direcciones
    $('#btn-buscar').addEventListener('click', function () { buscarDireccion(); });
    $('#busq-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); buscarDireccion(); } });
    function clicCandidato(e) {
      var b = e.target.closest('[data-cand]');
      if (!b || !candActual) return;
      var c = candActual.lista[+b.dataset.i];
      if (c) accionCandidato(b.dataset.cand, c);
    }
    $('#busq-res').addEventListener('click', clicCandidato);
    $('#fin-res').addEventListener('click', clicCandidato);
    $('#btn-fin-buscar').addEventListener('click', function () { buscarDireccion('fin'); });
    $('#fin-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); buscarDireccion('fin'); } });
    $('#btn-fin-mapa').addEventListener('click', function () {
      setModo('fin');
      toast('Haz clic en el mapa donde terminan las rutas.');
      var mz = $('#mapa-zona'); if (mz) mz.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    $$('input[name="fin"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        estado.fin = r.value;
        aplicarFinUI();
        cambio();
        if (r.value === 'otro') toast('Ahora fija el depósito final: busca su dirección, haz clic en el mapa o escribe su latitud y longitud.');
      });
    });
    $('#btn-geo-lista').addEventListener('click', function () {
      var items = parsearListaDirecciones($('#geo-lista').value);
      if (!items.length) { toast('Escribe o pega al menos una dirección (una por línea).'); return; }
      geocodificarLista(items, true);
    });
    $('#btn-geo-cancelar').addEventListener('click', function () { geoCancelar = true; $('#geo-estado').textContent = 'Cancelando…'; });

    $('#btn-ejemplo').addEventListener('click', function () {
      if (estado.paradas.length && !estado.esEjemplo && !confirm('Se reemplazarán tus datos actuales por el ejemplo. ¿Continuar?')) return;
      var csvSep = estado.csvSep;
      estado = datosEjemplo(); estado.csvSep = csvSep;
      reiniciarResultados();
      llenarFormulario(); renderResultados(); renderFlete(); mostrarMensajes([], [], null);
      setModo('parada'); dibujarMapa(true); guardarLocal();
      toast('Ejemplo cargado: datos ficticios de Lima. Pulsa “Optimizar rutas”.');
    });
    $('#btn-nuevo').addEventListener('click', function () {
      if (!confirm('Se borrarán todos los datos de esta pantalla (el archivo de proyecto guardado no se toca). ¿Empezar de cero?')) return;
      estado = estadoVacio(); reiniciarResultados();
      llenarFormulario(); renderResultados(); renderFlete(); mostrarMensajes([], [], null);
      $('#estado-calc').textContent = ''; progresoFin('#prog', false);
      $('#barrido-res').innerHTML = ''; $('#busq-res').innerHTML = ''; $('#fin-res').innerHTML = ''; $('#geo-estado').textContent = '';
      setModo('deposito'); dibujarMapa(false); guardarLocal(); irTab('datos');
      toast('Listo: empieza ubicando el depósito en el mapa o buscando su dirección.');
    });

    // CSV
    $('#btn-csv-importar').addEventListener('click', function () { $('#file-csv').click(); });
    $('#file-csv').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { importarTexto(String(fr.result), 'CSV'); };
      fr.onerror = function () { mostrarMensajes(['No se pudo leer el archivo.'], [], null); };
      fr.readAsText(f);
      e.target.value = '';
    });
    $('#btn-csv-exportar').addEventListener('click', exportarParadasCSV);
    $('#btn-pegar-importar').addEventListener('click', function () {
      var t = $('#pegar-excel').value;
      importarTexto(t, 'pegado desde Excel');
      $('#pegar-excel').value = '';
    });

    // proyecto
    $('#btn-proy-guardar').addEventListener('click', guardarProyecto);
    $('#btn-proy-cargar').addEventListener('click', function () { $('#file-proy').click(); });
    $('#file-proy').addEventListener('change', function (e) { var f = e.target.files[0]; if (f) cargarProyecto(f); e.target.value = ''; });

    // modo de clic
    $$('input[name="modo-mapa"]').forEach(function (r) { r.addEventListener('change', function () { setModo(r.value); }); });

    // tráfico
    $('#btn-traf-ninguno').addEventListener('click', function () { ponerPerfil(Motor && Motor.PERFILES_TRAFICO ? Motor.PERFILES_TRAFICO.ninguno : PERFIL_NINGUNO); });
    $('#btn-traf-lima').addEventListener('click', function () { ponerPerfil(Motor && Motor.PERFILES_TRAFICO && Motor.PERFILES_TRAFICO.lima_tipico ? Motor.PERFILES_TRAFICO.lima_tipico : PERFIL_LIMA); });
    $('#traf-horas').addEventListener('input', function (e) {
      var h = e.target.dataset.th;
      if (h == null) return;
      var v = num(e.target.value, NaN);
      if (isFinite(v)) setFactor(+h, v);
    });
    $('#traf-horas').addEventListener('change', function (e) { if (e.target.dataset.th != null) pintarTrafico(); });
    var barras = $('#traf-barras'), arrastrando = false;
    function aplicarBarra(e) {
      var r = barras.getBoundingClientRect();
      var h = clamp(Math.floor((e.clientX - r.left) / r.width * 24), 0, 23);
      var v = 1 + 2 * (r.bottom - e.clientY) / r.height;
      setFactor(h, clamp(v, 1, 3));
    }
    barras.addEventListener('pointerdown', function (e) { arrastrando = true; try { barras.setPointerCapture(e.pointerId); } catch (x) { /* nada */ } aplicarBarra(e); });
    barras.addEventListener('pointermove', function (e) { if (arrastrando) aplicarBarra(e); });
    ['pointerup', 'pointercancel'].forEach(function (n) { barras.addEventListener(n, function () { arrastrando = false; }); });

    // optimizar y resultados
    $('#btn-optimizar').addEventListener('click', optimizarClick);
    $('#btn-cancelar').addEventListener('click', cancelarCalculo);
    $('#btn-barrido').addEventListener('click', barrido);
    $('#res-contenido').addEventListener('click', function (e) {
      var c = e.target.closest('[data-copiar]');
      if (c) { copiar(c.dataset.copiar).then(function (ok) { toast(ok ? 'Enlace copiado.' : 'No se pudo copiar; selecciónalo y cópialo a mano.'); }); return; }
      if (e.target.closest('#btn-exp-plan')) exportarPlanCSV();
      if (e.target.closest('#btn-imprimir')) {
        if (ultimo && ultimo.obsoleto) { toast('Cambiaste datos después de calcular: vuelve a optimizar antes de imprimir las hojas de ruta.'); return; }
        construirHojas(); setTimeout(function () { window.print(); }, 50);
      }
      if (e.target.closest('#btn-ir-flete')) irTab('flete');
    });
    $('#barrido-res').addEventListener('click', function (e) {
      var b = e.target.closest('#btn-usar-hora');
      if (!b) return;
      var m = +b.dataset.min, hh = pad2(Math.floor((m % 1440) / 60)) + ':' + pad2(m % 60);
      estado.flota.tipos.forEach(function (t) { t.salida_modo = 'fija'; t.salida = hh; });
      renderTipos();
      cambio({ mapa: false });
      toast('Todos los tipos de vehículo ahora salen a las ' + hh + ' (hora fija). Vuelve a pulsar “Optimizar rutas”.');
    });

    // flete
    $('#btn-flete-calc').addEventListener('click', function () {
      if (!ultimo) { toast('Primero calcula las rutas con “Optimizar rutas”.'); return; }
      renderFlete(); toast('Flete recalculado.');
    });
    $('#flete-contenido').addEventListener('click', function (e) {
      if (e.target.closest('#btn-fl-copiar')) {
        var t = textoFleteCSV();
        if (t) copiar(t).then(function (ok) { toast(ok ? 'CSV del flete copiado: pégalo en Excel.' : 'No se pudo copiar; usa “Descargar CSV”.'); });
      } else if (e.target.closest('#btn-fl-csv')) {
        var t2 = textoFleteCSV();
        if (t2) descargar('flete.csv', '﻿' + t2, 'text/csv;charset=utf-8');
      } else if (e.target.closest('#btn-fl-cotiz')) {
        if (ultimo && ultimo.obsoleto) { toast('Cambiaste datos después de calcular: vuelve a optimizar antes de imprimir cotizaciones.'); return; }
        if (construirCotizaciones()) setTimeout(function () { window.print(); }, 50);
      }
    });
  }

  /* ===================== arranque ===================== */
  function init() {
    if (!Motor) { $('#aviso-motor').hidden = false; $('#btn-optimizar').disabled = true; $('#btn-barrido').disabled = true; var of0 = $('#btn-optimizar-fijo'); if (of0) of0.disabled = true; }
    var restaurado = cargarLocal();
    initMapa();
    llenarFormulario();
    renderResultados();
    renderFlete();
    enlazar();
    irTab('datos');
    var sinDeposito = !isFinite(num(estado.deposito.lat, NaN));
    setModo(sinDeposito ? 'deposito' : 'parada');
    dibujarMapa(true);
    if (restaurado && migradoDeV1) toast('Se restauró tu último trabajo de una versión anterior: tu flota pasó a un solo tipo de vehículo y se activaron las calles reales. Revisa “Flota y costos”.');
    else if (restaurado && (estado.paradas.length || !sinDeposito)) toast('Se restauró tu último trabajo (autoguardado en este navegador).');
    else if (!restaurado) toast('Empieza con “Cargar ejemplo” o ubica tu depósito en el mapa.');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
