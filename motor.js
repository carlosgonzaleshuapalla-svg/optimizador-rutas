/* =============================================================================
 * motor.js — Optimizador de rutas (VRPTW con tráfico dependiente de la hora,
 * peajes, flota heterogénea, hora de salida automática, equilibrio de jornada y
 * flete a cobrar).  Módulo UMD, JavaScript puro, sin dependencias, sin DOM, sin
 * red, sin Math.random (PRNG mulberry32 con semilla).  VERSION 1.1.0.
 * Especificación: CONTRATO.md (v1.0 + ampliación v1.1 A–D).  Pruebas: tests/.
 *
 * DECISIONES DONDE EL CONTRATO ERA AMBIGUO (las más simples) / DESVIACIONES
 *  1. Una sola fuente de verdad del costo: `evaluar()` simula una ruta completa
 *     para un tipo de vehículo y una hora de salida (tráfico FIFO, espera por
 *     ventana, servicio, jornada, capacidad, peajes por arco, retorno opcional).
 *     La usan construcción, búsqueda local, ILS, evaluarRutas, calcularFlete y el
 *     armado del resultado.
 *  2. Objetivo: "costo" = fijo + km·costo_km + horas·costo_hora + peso_peaje·peajes;
 *     "distancia" = km; "tiempo" = minutos de jornada.  `peso_peaje` solo actúa en
 *     el objetivo "costo".  El costo reportado SIEMPRE es el real.  Con objetivo
 *     ≠ costo, `ahorro.costo` puede ser negativo (se informa tal cual).
 *  3. Las no atendidas pesan PENAL = 1e7 en el objetivo y no entran en `costo`.
 *  4. Ventanas DURAS: si se llega antes se espera; el servicio debe COMENZAR antes
 *     del fin.  Tiempos = minutos absolutos desde la medianoche del día 0 (pueden
 *     pasar de 1440).  Una ventana con fin < inicio cruza medianoche (fin += 1440);
 *     si aun así queda vacía (p. ej. [3000, 100]) es ERROR.  Las ventanas no se
 *     repiten cada día: una ventana [540, 600] no vale para una llegada en 1980.
 *  5. `salida_min` global por defecto 480 (08:00).  `vehiculos_max` omitido = sin
 *     límite (aviso).  Con `retorno_deposito:false` la jornada termina al salir de
 *     la última parada y `regreso_min` de la ruta es esa hora (`retorno_deposito`
 *     de la ruta dice cuál caso es).
 *  6. validar(): demanda > capacidad (mayor capacidad de la flota) es AVISO;
 *     matriz con tamaño incorrecto, ids duplicados, coordenadas fuera de rango,
 *     perfil ≠ 24 valores, factor < 1, tipos de flota mal formados: ERROR.
 *     Entradas null de la matriz = "complétalas tú" (aviso).
 *  7. Motivos de no atendida: "excede capacidad" (ningún tipo la carga),
 *     "ventana imposible", "excede jornada" (ningún tipo la hace sola; si un tipo
 *     falla por jornada y otro por ventana se informa jornada) y "sin vehículo
 *     disponible" (cabe sola pero la flota no alcanza).  En evaluarRutas, una
 *     parada que cabe sola y no estaba en las rutas: "no incluida en las rutas
 *     indicadas".
 *  8. evaluarRutas: una ruta dada que viola algo se recorta en orden (greedy) y
 *     las paradas sacadas pasan a no_atendidas con su motivo.  Con flota mixta, una
 *     ruta (array de ids) usa el vehículo libre factible de menor objetivo; también
 *     se acepta {tipo:"T2", ids:[...]} para forzar el tipo.  Ids desconocidos o
 *     repetidos: se ignoran y se listan en `avisos`.
 *  9. ILS: además de `tiempo_ms` y `max_iter`, se detiene tras `sin_mejora`
 *     iteraciones seguidas sin mejora (defecto max(2000, 200·n)).  Reproducible
 *     exacto si termina por sin_mejora/max_iter; si corta el reloj, depende de la
 *     velocidad de la máquina.
 * 10. Heurística: Clarke-Wright adaptado (una corrida por tipo de vehículo como
 *     plantilla, luego asignación a vehículos), vecino más cercano (la `base`) e
 *     inserción más barata; VND (inserción, 2-opt y or-opt, relocate, swap,
 *     swap*, 2-opt*, intercambio de vehículos entre rutas) con evaluación COMPLETA
 *     de factibilidad; ILS con ruin&recreate.  Sin garantía de óptimo global.
 * 11. Flota (A): formato v1.0 = UN tipo ("T1", "Vehículo", cantidad = vehiculos_max).
 *     Con `flota.tipos`, los campos sueltos de flota se ignoran (aviso).
 *     `cantidad` omitida = 1.  Cada ruta usa un vehículo concreto; los slots de un
 *     tipo se limitan a min(cantidad, n).  La `base` (vecino más cercano) llena
 *     vehículos de mayor a menor capacidad.  Nombres: "<tipo> <k>" con k = orden
 *     entre las rutas usadas de ese tipo.
 * 12. Salida (B): "fija" usa salida_min del tipo (o problema.salida_min).  "auto":
 *     la grilla es desde, desde+paso, … ≤ hasta (paso por defecto 10, máx. 1000
 *     puntos); candidatos extra: para cada punto, el que elimina la espera
 *     (g + holgura de desplazamiento = menor entre la primera espera y la
 *     holgura de ventanas previas) y el camino de desplazamientos desde `desde`.
 *     Se elige el menor objetivo de la ruta (la jornada máxima del tipo se
 *     exige); empate: la más temprana.  EFICIENCIA: en la búsqueda se usa un
 *     estimador (2–4 evaluaciones: desde y desplazamientos sucesivos); la grilla
 *     completa se aplica al armar el resultado (y a la `base`).  La salida de
 *     cada ruta se elige por el objetivo de ESA ruta (no mira el equilibrio).
 *     `salida_alternativas` = ≤ 24 puntos de la grilla (+ la elegida); costo null
 *     si ese punto es infactible.
 * 13. Equilibrio (C): pen = equilibrio × Σ_rutas (jornada_max − jornada_r) × w_r,
 *     w_r = costo_hora/60 (objetivo costo), 1 (objetivo tiempo); no aplica al
 *     objetivo distancia (aviso).  costo_equilibrio = costo real del plan − costo
 *     real de una 2.ª corrida corta con equilibrio 0 (25 % del tiempo), recortado
 *     a ≥ 0; `costo_equilibrio_aprox:true` (es heurístico).
 * 14. Flete (D): ver calcularFlete.  Mínimo por parada y redondeo se aplican al
 *     precio teórico de cada parada (en ese orden); los totales por ruta son la
 *     suma de los fletes de sus paradas.  por_km/por_hora/por_unidad_carga son
 *     PRECIO sin IGV ÷ km / horas de jornada / carga.  Prorrateo "peso" con
 *     demanda 0 en todas las paradas usa km directos; con km 0 reparte igual.
 * 15. barrerHoraSalida devuelve {ok, puntos, mejor, mejor_salida_min}; para cada
 *     punto fuerza TODOS los tipos a salida fija = ese punto.  Por defecto
 *     06:00–10:00 cada 30 min, 300 ms por punto.
 * 16. peajesEnGeometria cuenta PASADAS (entrar al radio = 1; ida y vuelta = 2).
 * 17. Campos adicionales (no rompen el contrato): resultado.avisos, .evaluaciones,
 *     ruta.retorno, min_flujo_libre, retorno_deposito, tipo y tipo_nombre, capacidad, utilizacion_pct,
 *     salida_auto, salida_alternativas, totales.valor_objetivo, min_conduccion,
 *     min_espera, jornada_max_min, jornada_min_min, desequilibrio_min, base.rutas, base.no_atendidas,
 *     construirMatrices().estimados/detallePeajes, PERFILES_TRAFICO_NOTAS,
 *     opciones.sin_mejora, opciones.progreso({iteraciones, ms, fraccion,
 *     mejor_costo, mejor_objetivo, no_atendidas}) (≤ 1 vez cada ~150 ms).
 * 18. Flota mixta (búsqueda): movimiento extra opFusionar (une dos rutas en un
 *     vehículo propio o de otro tipo libre; sin él, «cambiar de tipo + unir»
 *     quedaba fuera del alcance de los movimientos de a una parada).  Con más de
 *     un tipo se mejora cada construcción (hasta el 20 % del tiempo) y se elige
 *     la mejor.  Salida «auto»: si n × puntos_de_grilla <= 600 toda la búsqueda
 *     usa la grilla exacta; si no, usa el estimador (12 % del tiempo se reserva
 *     para un pulido final con la salida exacta).
 * 19. Presupuesto de tiempo: de tiempo_ms se descuenta una reserva para el posproceso
 *     (~0.07 ms × n, más la grilla «auto»); las construcciones iniciales (NN siempre;
 *     Clarke-Wright e inserción solo si caben, ~2e-4·n² ms c/u) y la 2.ª corrida de
 *     costo_equilibrio (solo si su 25 % >= 0.12·n ms; si no, se omite costo_equilibrio)
 *     se ajustan a él.  Holgura que queda: la construcción NN y el armado (~0.1 ms × n);
 *     con n = 400 y tiempo_ms = 100 puede ser ~1.4×; con 300, ~1.1×.
 * 20. Punto final (v1.2, F): `fin` manda sobre `retorno_deposito` (contradicción = aviso).
 *     «otro» agrega el nodo n+1 (depósito final; sin demanda, ventana ni servicio) y las
 *     matrices pasan a (n+2)²; todo el regreso (evaluar, Clarke-Wright, peajes del último
 *     tramo, flete) usa ese nodo.  Con coordenadas iguales a las del depósito no hay caso
 *     especial: las distancias estimadas son iguales y el costo coincide con «deposito».
 *     Con matriz dada, ese caso usa las celdas n+1 que se hayan entregado.  El id del depósito
 *     final puede repetir el del depósito de salida SOLO si las coordenadas coinciden; si falta
 *     id se usa «FIN».  Con «ultima», ruta.fin es la última parada de cada ruta.  Campos nuevos:
 *     ruta.fin = {id, nombre} y ruta.fin_modo.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MotorRutas = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.2.0';
  var R_TIERRA_KM = 6371.0088;
  var M_POR_GRADO = R_TIERRA_KM * 1000 * Math.PI / 180; // metros por grado de latitud
  var TOL = 1e-7;      // mejora mínima para aceptar un movimiento
  var EPS = 1e-9;      // tolerancia de factibilidad (ventana, jornada, capacidad)
  var PENAL = 1e7;     // penalización por parada no atendida (en unidades del objetivo)

  /* ---------------------------------------------------------------- utilidades */
  function esNum(x) { return typeof x === 'number' && isFinite(x); }
  function esObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function tiene(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function limpio(x) { return Math.round(x * 1e9) / 1e9; }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function distanciaKm(a, b) {
    var toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_TIERRA_KM * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function parseHora(s) {
    if (typeof s !== 'string') return null;
    var m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(s);
    if (!m) return null;
    var h = +m[1], mi = +m[2], se = m[3] ? +m[3] : 0;
    if (mi > 59 || se > 59) return null;
    if (h > 23 && !(h === 24 && mi === 0 && se === 0)) return null;
    return h * 60 + mi + se / 60;
  }

  function formatoHora(min) {
    if (!esNum(min)) return '--:--';
    var tot = Math.round(min);
    var dia = Math.floor(tot / 1440);
    var r = tot - dia * 1440;
    var s = pad2(Math.floor(r / 60)) + ':' + pad2(r % 60);
    if (dia > 0) s += ' (+' + dia + 'd)';
    else if (dia < 0) s += ' (' + dia + 'd)';
    return s;
  }

  // "08:30" o "08:30 (+1)" (día siguiente), "(+2)"… ; los días negativos se muestran "(-1)"
  function formatoHoraDia(min) {
    if (!esNum(min)) return '--:--';
    var tot = Math.round(min);
    var dia = Math.floor(tot / 1440);
    var r = tot - dia * 1440;
    var s = pad2(Math.floor(r / 60)) + ':' + pad2(r % 60);
    if (dia > 0) s += ' (+' + dia + ')';
    else if (dia < 0) s += ' (' + dia + ')';
    return s;
  }

  /* ------------------------------------------------------------------- tráfico */
  var PERFILES_TRAFICO = {
    ninguno: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    // SUPUESTO genérico de ejemplo (picos 7–9 h y 17–20 h). NO son datos medidos.
    lima_tipico: [1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.3, 1.7, 1.8, 1.5, 1.2, 1.15,
      1.2, 1.3, 1.2, 1.2, 1.4, 1.7, 1.9, 1.7, 1.4, 1.15, 1.0, 1.0]
  };
  var PERFILES_TRAFICO_NOTAS = {
    ninguno: 'Sin tráfico: factor 1 todas las horas.',
    lima_tipico: 'SUPUESTO genérico de ejemplo (picos 7–9 h y 17–20 h); no son datos medidos. Edítalo con tus datos.'
  };

  function perfilValido(p) {
    if (!Array.isArray(p) || p.length !== 24) return false;
    for (var i = 0; i < 24; i++) if (!esNum(p[i]) || p[i] < 1) return false;
    return true;
  }

  // núcleo (perfil ya validado, t0 y minBase finitos)
  function durTraf(t0, minBase, perfil) {
    if (!(minBase > 0)) return 0;
    var t = t0, resto = minBase;
    for (var it = 0; it < 100000; it++) {
      var hAbs = Math.floor(t / 60);
      var h = hAbs % 24; if (h < 0) h += 24;
      var f = perfil[h];
      var finHora = (hAbs + 1) * 60;
      var cap = (finHora - t) / f; // minutos base que se pueden recorrer en lo que queda de esta hora
      if (resto <= cap) { t += resto * f; return t - t0; }
      resto -= cap; t = finHora;
    }
    return t - t0; // salvaguarda (no debería alcanzarse)
  }

  function duracionConTrafico(t0, minBase, perfil) {
    if (!esNum(minBase) || minBase <= 0) return 0;
    if (!esNum(t0) || !perfilValido(perfil)) {
      if (!esNum(t0)) return minBase;
      if (!Array.isArray(perfil) || perfil.length !== 24) return minBase;
      perfil = perfil.map(function (x) { return esNum(x) && x >= 1 ? x : 1; });
    }
    return durTraf(t0, minBase, perfil);
  }

  /* -------------------------------------------------------------------- peajes */
  function distPuntoSegmentoM(plat, plon, alat, alon, blat, blon) {
    var kx = Math.cos(((alat + blat) / 2) * Math.PI / 180) * M_POR_GRADO, ky = M_POR_GRADO;
    var bx = (blon - alon) * kx, by = (blat - alat) * ky;
    var px = (plon - alon) * kx, py = (plat - alat) * ky;
    var len2 = bx * bx + by * by;
    var t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var dx = px - t * bx, dy = py - t * by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function peajesEnGeometria(polilinea, peajes) {
    var out = [];
    if (!Array.isArray(polilinea) || polilinea.length < 1 || !Array.isArray(peajes)) return out;
    for (var q = 0; q < peajes.length; q++) {
      var P = peajes[q];
      if (!esObj(P) || !esNum(P.lat) || !esNum(P.lon)) continue;
      var radio = esNum(P.radio_m) && P.radio_m > 0 ? P.radio_m : 300;
      var costo = esNum(P.costo) ? P.costo : 0;
      var dentro = false;
      var nSeg = Math.max(1, polilinea.length - 1);
      for (var s = 0; s < nSeg; s++) {
        var A = polilinea[s], B = polilinea[Math.min(s + 1, polilinea.length - 1)];
        if (!Array.isArray(A) || !Array.isArray(B) || !esNum(A[0]) || !esNum(A[1]) || !esNum(B[0]) || !esNum(B[1])) continue;
        var d = distPuntoSegmentoM(P.lat, P.lon, A[0], A[1], B[0], B[1]);
        if (d <= radio) {
          if (!dentro) out.push({ id: P.id, nombre: P.nombre, costo: costo });
          dentro = true;
        } else dentro = false;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------- validar */
  var OBJETIVOS = ['costo', 'distancia', 'tiempo'];
  var FINES = ['deposito', 'otro', 'ultima'];
  // modo de término de las rutas: `fin` manda; si falta, se deduce de retorno_deposito (false ⇒ «ultima»)
  function modoFin(p) {
    if (p.fin !== undefined && p.fin !== null) return p.fin;
    return p.retorno_deposito === false ? 'ultima' : 'deposito';
  }

  function validar(p) {
    var errores = [], avisos = [];
    if (!esObj(p)) return { ok: false, errores: ['El problema debe ser un objeto.'], avisos: avisos };

    function coord(o, et) {
      if (!esNum(o.lat) || o.lat < -90 || o.lat > 90) errores.push(et + ': latitud inválida (' + o.lat + '); debe estar entre -90 y 90.');
      if (!esNum(o.lon) || o.lon < -180 || o.lon > 180) errores.push(et + ': longitud inválida (' + o.lon + '); debe estar entre -180 y 180.');
    }

    // depósito
    var depOk = esObj(p.deposito);
    if (!depOk) errores.push('Falta el depósito (deposito: {lat, lon}).');
    else coord(p.deposito, 'Depósito');

    // salida, retorno, objetivo, peso, equilibrio
    if (p.salida_min !== undefined && p.salida_min !== null && (!esNum(p.salida_min) || p.salida_min < 0))
      errores.push('salida_min debe ser un número ≥ 0 (minutos desde medianoche, p. ej. 480 = 08:00).');
    if (p.retorno_deposito !== undefined && p.retorno_deposito !== null && typeof p.retorno_deposito !== 'boolean')
      errores.push('retorno_deposito debe ser true o false.');
    var finModo = 'deposito';
    if (p.fin !== undefined && p.fin !== null && FINES.indexOf(p.fin) < 0) errores.push('fin debe ser "deposito", "otro" o "ultima".');
    else {
      finModo = modoFin(p);
      if (p.fin != null && typeof p.retorno_deposito === 'boolean' && (p.retorno_deposito === false) !== (p.fin === 'ultima'))
        avisos.push('fin («' + p.fin + '») y retorno_deposito (' + p.retorno_deposito + ') se contradicen: manda fin.');
    }
    if (p.objetivo !== undefined && p.objetivo !== null && OBJETIVOS.indexOf(p.objetivo) < 0)
      errores.push('objetivo debe ser "costo", "distancia" o "tiempo".');
    if (p.peso_peaje !== undefined && p.peso_peaje !== null && (!esNum(p.peso_peaje) || p.peso_peaje < 0))
      errores.push('peso_peaje debe ser un número ≥ 0.');
    if (p.equilibrio !== undefined && p.equilibrio !== null) {
      if (!esNum(p.equilibrio) || p.equilibrio < 0 || p.equilibrio > 1) errores.push('equilibrio debe ser un número entre 0 y 1.');
      else if (p.equilibrio > 0 && p.objetivo === 'distancia') avisos.push('El equilibrio de jornada no se aplica con el objetivo «distancia».');
    }

    // flota
    var F = {};
    if (p.flota !== undefined && p.flota !== null) {
      if (!esObj(p.flota)) errores.push('«flota» debe ser un objeto.'); else F = p.flota;
    }
    var capMax = Infinity, capTotal = Infinity, hayCosto = false;
    var tipoCosto = function (o, et) {
      ['costo_fijo', 'costo_km', 'costo_hora'].forEach(function (k) {
        if (o[k] !== undefined && o[k] !== null && (!esNum(o[k]) || o[k] < 0)) errores.push(et + k + ' debe ser un número ≥ 0.');
        else if (esNum(o[k]) && o[k] > 0) hayCosto = true;
      });
      if (o.jornada_max_min !== undefined && o.jornada_max_min !== null && (!esNum(o.jornada_max_min) || o.jornada_max_min <= 0))
        errores.push(et + 'jornada_max_min debe ser un número > 0 (omítelo para no limitar la jornada).');
    };
    if (F.tipos !== undefined && F.tipos !== null) {
      if (!Array.isArray(F.tipos) || F.tipos.length === 0) errores.push('flota.tipos debe ser una lista con al menos un tipo de vehículo.');
      else {
        var idsT = Object.create(null); capMax = 0; capTotal = 0;
        if (F.capacidad != null || F.vehiculos_max != null || F.costo_km != null || F.costo_hora != null || F.costo_fijo != null || F.jornada_max_min != null)
          avisos.push('flota.tipos está presente: se ignoran capacidad, vehiculos_max, costos y jornada sueltos de flota.');
        F.tipos.forEach(function (t, i) {
          var et = 'Tipo de vehículo ' + (esObj(t) && t.id !== undefined ? t.id : i + 1) + ': ';
          if (!esObj(t)) { errores.push('Tipo de vehículo ' + (i + 1) + ': debe ser un objeto.'); return; }
          if (t.id === undefined || t.id === null || (typeof t.id !== 'string' && !esNum(t.id)) || String(t.id) === '') errores.push(et + 'falta el id.');
          else if (tiene(idsT, String(t.id))) errores.push('Id de tipo duplicado: «' + t.id + '».');
          else idsT[String(t.id)] = true;
          var cant = 1;
          if (t.cantidad !== undefined && t.cantidad !== null) {
            if (!esNum(t.cantidad) || t.cantidad < 1 || Math.floor(t.cantidad) !== t.cantidad) errores.push(et + 'cantidad debe ser un entero ≥ 1.');
            else cant = t.cantidad;
          }
          var cap = Infinity;
          if (t.capacidad !== undefined && t.capacidad !== null) {
            if (!esNum(t.capacidad) || t.capacidad <= 0) errores.push(et + 'capacidad debe ser un número > 0 (omítela para ilimitada).');
            else cap = t.capacidad;
          }
          capMax = Math.max(capMax, cap); capTotal += cap * cant;
          tipoCosto(t, et);
          var modo = t.salida_modo === undefined || t.salida_modo === null ? 'fija' : t.salida_modo;
          if (modo !== 'fija' && modo !== 'auto') errores.push(et + 'salida_modo debe ser "fija" o "auto".');
          if (t.salida_min !== undefined && t.salida_min !== null && (!esNum(t.salida_min) || t.salida_min < 0)) errores.push(et + 'salida_min debe ser un número ≥ 0.');
          if (modo === 'auto') {
            if (!esNum(t.salida_desde_min) || !esNum(t.salida_hasta_min) || t.salida_desde_min < 0) errores.push(et + 'salida automática: indica salida_desde_min y salida_hasta_min (números ≥ 0).');
            else if (t.salida_desde_min > t.salida_hasta_min) errores.push(et + 'salida_desde_min no puede ser mayor que salida_hasta_min.');
            var paso = 10;
            if (t.salida_paso_min !== undefined && t.salida_paso_min !== null) {
              if (!esNum(t.salida_paso_min) || t.salida_paso_min <= 0) errores.push(et + 'salida_paso_min debe ser un número > 0.'); else paso = t.salida_paso_min;
            }
            if (esNum(t.salida_desde_min) && esNum(t.salida_hasta_min) && (t.salida_hasta_min - t.salida_desde_min) / paso > 1000) errores.push(et + 'la grilla de salida tiene más de 1000 puntos: aumenta salida_paso_min.');
          }
        });
      }
    } else {
      if (F.capacidad !== undefined && F.capacidad !== null) {
        if (!esNum(F.capacidad) || F.capacidad <= 0) errores.push('flota.capacidad debe ser un número > 0 (omítela para capacidad ilimitada).');
        else capMax = F.capacidad;
      }
      var vmax = Infinity;
      if (F.vehiculos_max !== undefined && F.vehiculos_max !== null) {
        if (!esNum(F.vehiculos_max) || F.vehiculos_max < 1) errores.push('flota.vehiculos_max debe ser un número ≥ 1.');
        else {
          vmax = Math.floor(F.vehiculos_max);
          if (vmax !== F.vehiculos_max) avisos.push('flota.vehiculos_max no es entero: se usa ' + vmax + '.');
        }
      } else avisos.push('No se indicó flota.vehiculos_max: se asume sin límite de vehículos.');
      capTotal = capMax * vmax;
      tipoCosto(F, 'flota.');
    }
    if ((p.objetivo === undefined || p.objetivo === null || p.objetivo === 'costo') && !hayCosto && (!Array.isArray(p.peajes) || !p.peajes.length))
      avisos.push('costo_km y costo_hora valen 0: el objetivo «costo» no distingue entre rutas (usa «distancia» o «tiempo», o completa los costos).');

    // paradas
    var ps = Array.isArray(p.paradas) ? p.paradas : null;
    if (!ps) errores.push('«paradas» debe ser una lista.');
    var n = ps ? ps.length : 0;
    if (ps && n === 0) avisos.push('No hay paradas: no hay nada que optimizar.');
    var vistos = Object.create(null), demTotal = 0; // sin prototipo: un id «__proto__» o «constructor» es un id más
    if (depOk && p.deposito.id !== undefined && p.deposito.id !== null) vistos[String(p.deposito.id)] = 'el depósito';
    var claves = {};
    if (depOk && esNum(p.deposito.lat) && esNum(p.deposito.lon)) claves[p.deposito.lat + ',' + p.deposito.lon] = 'el depósito';
    for (var i = 0; ps && i < n; i++) {
      var s = ps[i], et2 = 'Parada ' + (i + 1);
      if (!esObj(s)) { errores.push(et2 + ': debe ser un objeto.'); continue; }
      if (s.id === undefined || s.id === null || (typeof s.id !== 'string' && !esNum(s.id)) || String(s.id) === '') errores.push(et2 + ': falta el id.');
      else {
        et2 = 'Parada ' + s.id;
        var k = String(s.id);
        if (tiene(vistos, k)) errores.push('Id duplicado: «' + k + '» (también es id de ' + (vistos[k] === 'el depósito' ? 'el depósito' : 'la parada ' + vistos[k]) + ').');
        else vistos[k] = k;
      }
      coord(s, et2);
      if (esNum(s.lat) && esNum(s.lon)) {
        var ck = s.lat + ',' + s.lon;
        if (tiene(claves, ck)) avisos.push(et2 + ' tiene las mismas coordenadas que ' + claves[ck] + ' (distancia 0).');
        else claves[ck] = 'la parada ' + (s.id !== undefined ? s.id : i + 1);
      }
      if (s.demanda !== undefined && s.demanda !== null) {
        if (!esNum(s.demanda) || s.demanda < 0) errores.push(et2 + ': demanda debe ser un número ≥ 0.');
        else {
          demTotal += s.demanda;
          if (s.demanda > capMax) avisos.push(et2 + ': demanda ' + s.demanda + ' > capacidad ' + capMax + ' (quedará sin atender: excede capacidad).');
        }
      }
      if (s.servicio_min !== undefined && s.servicio_min !== null && (!esNum(s.servicio_min) || s.servicio_min < 0))
        errores.push(et2 + ': servicio_min debe ser un número ≥ 0.');
      if (s.ventana !== undefined && s.ventana !== null) {
        if (!Array.isArray(s.ventana) || s.ventana.length !== 2 || !esNum(s.ventana[0]) || !esNum(s.ventana[1]))
          errores.push(et2 + ': ventana debe ser [inicio, fin] en minutos desde medianoche, o null.');
        else if (s.ventana[1] < s.ventana[0]) {
          if (s.ventana[1] + 1440 < s.ventana[0]) errores.push(et2 + ': ventana vacía (inicio ' + s.ventana[0] + ', fin ' + s.ventana[1] + ' aun sumando un día).');
          else avisos.push(et2 + ': la ventana cruza la medianoche (termina el día siguiente).');
        }
      }
    }
    // depósito final (solo con fin:"otro")
    var dfOk = false;
    if (finModo === 'otro') {
      var DF = p.deposito_final;
      if (!esObj(DF)) errores.push('Con fin:"otro" falta deposito_final: {id, nombre, lat, lon}.');
      else {
        coord(DF, 'Depósito final');
        dfOk = esNum(DF.lat) && esNum(DF.lon);
        if (DF.id !== undefined && DF.id !== null) {
          if ((typeof DF.id !== 'string' && !esNum(DF.id)) || String(DF.id) === '') errores.push('Depósito final: el id debe ser texto o número.');
          else if (tiene(vistos, String(DF.id))) {
            var mismoFis = depOk && dfOk && esNum(p.deposito.lat) && esNum(p.deposito.lon) && DF.lat === p.deposito.lat && DF.lon === p.deposito.lon && vistos[String(DF.id)] === 'el depósito';
            if (!mismoFis) errores.push('Id duplicado: «' + DF.id + '» (el depósito final no puede repetir el id del depósito de salida ni de una parada).');
          }
        }
        if (dfOk && depOk && esNum(p.deposito.lat) && DF.lat === p.deposito.lat && DF.lon === p.deposito.lon)
          avisos.push('El depósito final tiene las mismas coordenadas que el de salida: equivale a fin:"deposito".');
      }
    } else if (p.deposito_final !== undefined && p.deposito_final !== null) avisos.push('deposito_final se ignora porque fin no es "otro".');
    if (isFinite(capTotal) && demTotal > capTotal + EPS)
      avisos.push('La demanda total (' + demTotal + ') supera la capacidad de toda la flota (' + capTotal + '): algunas paradas quedarán sin atender.');

    // tráfico
    if (p.trafico !== undefined && p.trafico !== null) {
      var t = p.trafico;
      if (!esObj(t)) errores.push('«trafico» debe ser un objeto.');
      else if (t.perfil !== undefined && t.perfil !== null) {
        if (!Array.isArray(t.perfil) || t.perfil.length !== 24) errores.push('trafico.perfil debe tener exactamente 24 valores (uno por hora, 0..23).');
        else for (var h = 0; h < 24; h++) if (!esNum(t.perfil[h]) || t.perfil[h] < 1) { errores.push('trafico.perfil[' + h + '] = ' + t.perfil[h] + ' inválido: cada factor debe ser un número ≥ 1.'); break; }
      } else if (t.preset !== undefined && t.preset !== null && !tiene(PERFILES_TRAFICO, t.preset))
        errores.push('trafico.preset «' + t.preset + '» no existe (disponibles: ' + Object.keys(PERFILES_TRAFICO).join(', ') + ').');
    }

    // peajes
    if (p.peajes !== undefined && p.peajes !== null) {
      if (!Array.isArray(p.peajes)) errores.push('«peajes» debe ser una lista.');
      else p.peajes.forEach(function (P, q) {
        var e2 = 'Peaje ' + (esObj(P) && P.id !== undefined ? P.id : q + 1);
        if (!esObj(P)) { errores.push(e2 + ': debe ser un objeto.'); return; }
        coord(P, e2);
        if (!esNum(P.costo) || P.costo < 0) errores.push(e2 + ': costo debe ser un número ≥ 0.');
        if (P.radio_m !== undefined && P.radio_m !== null && (!esNum(P.radio_m) || P.radio_m <= 0)) errores.push(e2 + ': radio_m debe ser un número > 0.');
      });
    }

    // estimación
    if (p.estimacion !== undefined && p.estimacion !== null) {
      var E = p.estimacion;
      if (!esObj(E)) errores.push('«estimacion» debe ser un objeto.');
      else {
        if (E.circuidad !== undefined && E.circuidad !== null) {
          if (!esNum(E.circuidad) || E.circuidad <= 0) errores.push('estimacion.circuidad debe ser un número > 0.');
          else if (E.circuidad < 1) avisos.push('estimacion.circuidad < 1: la distancia por calle no puede ser menor que la recta.');
        }
        if (E.velocidad_kmh !== undefined && E.velocidad_kmh !== null) {
          if (!esNum(E.velocidad_kmh) || E.velocidad_kmh <= 0) errores.push('estimacion.velocidad_kmh debe ser un número > 0.');
          else if (E.velocidad_kmh > 120) avisos.push('estimacion.velocidad_kmh > 120: poco realista para reparto urbano.');
        }
      }
    }

    // matriz
    if (p.matriz !== undefined && p.matriz !== null) {
      if (!esObj(p.matriz)) errores.push('«matriz» debe ser un objeto {km, min, peaje}.');
      else {
        var N = n + 1 + (finModo === 'otro' ? 1 : 0);
        var detalleN = finModo === 'otro' ? 'depósito + ' + n + ' paradas + depósito final (fin:"otro")' : 'depósito + ' + n + ' paradas';
        ['km', 'min', 'peaje'].forEach(function (nom) {
          var M = p.matriz[nom];
          if (M === undefined || M === null) return;
          if (!Array.isArray(M) || M.length !== N) { errores.push('matriz.' + nom + ' debe ser de ' + N + '×' + N + ' (' + detalleN + '); tiene ' + (Array.isArray(M) ? M.length + ' filas' : 'otro formato') + '.'); return; }
          var faltan = 0, malo = false;
          for (var a = 0; a < N && !malo; a++) {
            if (!Array.isArray(M[a]) || M[a].length !== N) { errores.push('matriz.' + nom + ': la fila ' + a + ' debe tener ' + N + ' columnas.'); malo = true; break; }
            for (var b = 0; b < N; b++) {
              var v = M[a][b];
              if (v === null || v === undefined) { if (a !== b) faltan++; }
              else if (!esNum(v) || v < 0) { errores.push('matriz.' + nom + '[' + a + '][' + b + '] debe ser un número ≥ 0 (o null para que el motor lo estime).'); malo = true; break; }
            }
          }
          if (!malo && faltan > 0) avisos.push('matriz.' + nom + ' incompleta: ' + faltan + ' de ' + (N * (N - 1)) + ' arcos se estimarán.');
        });
      }
    }
    return { ok: errores.length === 0, errores: errores, avisos: avisos };
  }

  /* ------------------------------------------------------------ construcción del contexto */
  function resolverPerfil(p) {
    var t = p.trafico;
    if (esObj(t)) {
      if (Array.isArray(t.perfil) && perfilValido(t.perfil)) return { perfil: t.perfil.slice(), origen: 'usuario' };
      if (t.preset != null && tiene(PERFILES_TRAFICO, t.preset)) return { perfil: PERFILES_TRAFICO[t.preset].slice(), origen: 'preset:' + t.preset };
    }
    return { perfil: PERFILES_TRAFICO.ninguno.slice(), origen: 'ninguno' };
  }

  // Calcula matrices (arreglos de arreglos) completando lo que falte. p ya validado.
  function calcularMatrices(p) {
    var pts = [p.deposito].concat(p.paradas);
    if (modoFin(p) === 'otro') pts.push(p.deposito_final);
    var N = pts.length;
    var E = esObj(p.estimacion) ? p.estimacion : {};
    var circ = esNum(E.circuidad) && E.circuidad > 0 ? E.circuidad : 1.35;
    var vel = esNum(E.velocidad_kmh) && E.velocidad_kmh > 0 ? E.velocidad_kmh : 35;
    var M = esObj(p.matriz) ? p.matriz : {};
    var peajes = Array.isArray(p.peajes) ? p.peajes : [];
    var provKm = Array.isArray(M.km), provMin = Array.isArray(M.min), provPeaje = Array.isArray(M.peaje);
    var estKm = 0, estMin = 0, estPeaje = 0, nPeajeGeom = 0;
    var km = [], mn = [], pj = [], lista = [];
    var i, j;
    for (i = 0; i < N; i++) { km.push(new Array(N).fill(0)); mn.push(new Array(N).fill(0)); pj.push(new Array(N).fill(0)); lista.push(new Array(N).fill(null)); }
    var geomCache = {};
    function geom(a, b) { // peajes sobre el segmento recto a–b (simétrico)
      var key = a < b ? a + '_' + b : b + '_' + a;
      if (tiene(geomCache, key)) return geomCache[key];
      var out = [];
      for (var q = 0; q < peajes.length; q++) {
        var P = peajes[q];
        var radio = esNum(P.radio_m) && P.radio_m > 0 ? P.radio_m : 300;
        if (distPuntoSegmentoM(P.lat, P.lon, pts[a].lat, pts[a].lon, pts[b].lat, pts[b].lon) <= radio)
          out.push({ id: P.id, nombre: P.nombre, costo: P.costo });
      }
      geomCache[key] = out;
      return out;
    }
    for (i = 0; i < N; i++) {
      for (j = 0; j < N; j++) {
        if (i === j) continue;
        var v = provKm ? M.km[i][j] : null;
        if (esNum(v) && v >= 0) km[i][j] = v; else { km[i][j] = distanciaKm(pts[i], pts[j]) * circ; estKm++; }
        var m = provMin ? M.min[i][j] : null;
        if (esNum(m) && m >= 0) mn[i][j] = m; else { mn[i][j] = km[i][j] / vel * 60; estMin++; }
        var pe = provPeaje ? M.peaje[i][j] : null;
        if (esNum(pe) && pe >= 0) {
          pj[i][j] = pe;
          if (pe > 0) lista[i][j] = [{ id: 'MATRIZ', nombre: 'Peaje (según matriz)', costo: pe }];
        } else if (peajes.length) {
          var g = geom(i, j);
          estPeaje++;
          if (g.length) { var s = 0; for (var q2 = 0; q2 < g.length; q2++) s += g[q2].costo; pj[i][j] = s; lista[i][j] = g; nPeajeGeom++; }
        }
      }
    }
    var tot = N * (N - 1);
    function fu(prov, est) { if (!prov) return 'estimada'; return est === 0 ? 'matriz' : (est === tot ? 'estimada' : 'mixta'); }
    var fuente = {
      km: fu(provKm, estKm),
      min: fu(provMin, estMin),
      peaje: provPeaje ? (estPeaje === 0 ? 'matriz' : 'mixta') : (peajes.length ? 'estimada' : 'ninguno')
    };
    if (tot === 0) fuente = { km: provKm ? 'matriz' : 'estimada', min: provMin ? 'matriz' : 'estimada', peaje: provPeaje ? 'matriz' : (peajes.length ? 'estimada' : 'ninguno') };
    return {
      km: km, min: mn, peaje: pj, fuente: fuente,
      estimados: { km: estKm, min: estMin, peaje: estPeaje, arcos: tot },
      detallePeajes: lista,
      parametros: { circuidad: circ, velocidad_kmh: vel, circuidad_default: !(esNum(E.circuidad) && E.circuidad > 0), velocidad_default: !(esNum(E.velocidad_kmh) && E.velocidad_kmh > 0) },
      arcosConPeajeEstimado: nPeajeGeom
    };
  }

  function construirMatrices(problema) {
    try {
      var v = validar(problema);
      if (!v.ok) return { ok: false, errores: v.errores };
      var r = calcularMatrices(problema);
      return { ok: true, km: r.km, min: r.min, peaje: r.peaje, fuente: r.fuente, estimados: r.estimados, detallePeajes: r.detallePeajes };
    } catch (e) {
      return { ok: false, errores: ['Error interno: ' + (e && e.message ? e.message : e)] };
    }
  }

  // Tipos de vehículo normalizados (p ya validado). Formato v1.0 = un tipo.
  function leerTipos(p, n) {
    var F = esObj(p.flota) ? p.flota : {};
    var sal0 = p.salida_min == null ? 480 : p.salida_min;
    var lista = [];
    var crear = function (o, id, nombre, cant) {
      var T = {
        id: id, nombre: nombre, cantidad: Math.min(cant, n),
        cap: o.capacidad == null ? Infinity : o.capacidad,
        fijo: o.costo_fijo || 0, km: o.costo_km || 0, hora: o.costo_hora || 0,
        jor: o.jornada_max_min == null ? Infinity : o.jornada_max_min,
        modo: 'fija', salida: o.salida_min == null ? sal0 : o.salida_min, desde: 0, hasta: 0, paso: 10, grilla: null
      };
      if (o.salida_modo === 'auto') {
        T.modo = 'auto'; T.desde = o.salida_desde_min; T.hasta = o.salida_hasta_min;
        T.paso = o.salida_paso_min == null ? 10 : o.salida_paso_min;
        T.grilla = [];
        for (var i = 0; T.desde + i * T.paso <= T.hasta + 1e-9; i++) T.grilla.push(T.desde + i * T.paso);
        T.salida = T.desde;
      }
      return T;
    };
    if (Array.isArray(F.tipos)) {
      F.tipos.forEach(function (t, i) {
        lista.push(crear(t, String(t.id), t.nombre != null ? String(t.nombre) : String(t.id), t.cantidad == null ? 1 : t.cantidad));
      });
    } else {
      lista.push(crear(F, 'T1', 'Vehículo', F.vehiculos_max == null ? Infinity : Math.floor(F.vehiculos_max)));
    }
    return lista;
  }

  function crearContexto(p) {
    var n = p.paradas.length, finM = modoFin(p), N = n + 1 + (finM === 'otro' ? 1 : 0);
    var mats = calcularMatrices(p);
    var pf = resolverPerfil(p);
    var sinTraf = true;
    for (var h = 0; h < 24; h++) if (pf.perfil[h] !== 1) sinTraf = false;
    var obj = p.objetivo === 'distancia' ? 1 : (p.objetivo === 'tiempo' ? 2 : 0);
    var c = {
      n: n, N: N,
      kmF: new Float64Array(N * N), minF: new Float64Array(N * N), tolF: new Float64Array(N * N),
      listaPeajes: [],
      dem: new Float64Array(N), serv: new Float64Array(N), vIni: new Float64Array(N), vFin: new Float64Array(N),
      ids: [String(p.deposito.id !== undefined ? p.deposito.id : 'DEP')], nombres: [p.deposito.nombre !== undefined ? p.deposito.nombre : 'Depósito'],
      finModo: finM, fi: finM === 'otro' ? n + 1 : 0, retorno: finM !== 'ultima',
      perfil: pf.perfil, perfilOrigen: pf.origen, sinTraf: sinTraf,
      obj: obj, objetivo: p.objetivo || 'costo',
      pesoPeaje: p.peso_peaje == null ? 1 : p.peso_peaje,
      eq: obj === 1 || p.equilibrio == null ? 0 : p.equilibrio,
      mats: mats, depNombre: p.deposito.nombre,
      tipos: leerTipos(p, n), cruzaMedianoche: 0
    };
    var i, j;
    for (i = 0; i < N; i++) for (j = 0; j < N; j++) {
      c.kmF[i * N + j] = mats.km[i][j]; c.minF[i * N + j] = mats.min[i][j]; c.tolF[i * N + j] = mats.peaje[i][j];
      c.listaPeajes.push(mats.detallePeajes[i][j]);
    }
    c.vIni[0] = -Infinity; c.vFin[0] = Infinity;
    for (i = 0; i < n; i++) {
      var s = p.paradas[i];
      c.ids.push(String(s.id)); c.nombres.push(s.nombre !== undefined ? s.nombre : String(s.id));
      c.dem[i + 1] = s.demanda == null ? 0 : s.demanda;
      c.serv[i + 1] = s.servicio_min == null ? 10 : s.servicio_min;
      if (Array.isArray(s.ventana)) {
        c.vIni[i + 1] = s.ventana[0];
        if (s.ventana[1] < s.ventana[0]) { c.vFin[i + 1] = s.ventana[1] + 1440; c.cruzaMedianoche++; }
        else c.vFin[i + 1] = s.ventana[1];
      } else { c.vIni[i + 1] = -Infinity; c.vFin[i + 1] = Infinity; }
    }
    if (finM === 'otro') { // nodo n+1: depósito final (sin demanda, ventana ni servicio)
      var DF = p.deposito_final;
      c.ids.push(DF.id !== undefined && DF.id !== null ? String(DF.id) : 'FIN');
      c.nombres.push(DF.nombre !== undefined ? DF.nombre : 'Depósito final');
      c.vIni[n + 1] = -Infinity; c.vFin[n + 1] = Infinity;
    }
    // vehículos concretos ("slots"): uno por unidad de cada tipo
    c.slotTipo = []; c.wBal = []; c.capMax = 0;
    c.tipos.forEach(function (T, ti) {
      c.capMax = Math.max(c.capMax, T.cap);
      for (var k = 0; k < T.cantidad; k++) {
        c.slotTipo.push(ti);
        c.wBal.push(obj === 0 ? T.hora / 60 : (obj === 2 ? 1 : 0));
      }
    });
    c.K = c.slotTipo.length;
    c.capMax = 0; c.tipos.forEach(function (T) { if (T.cap > c.capMax) c.capMax = T.cap; });
    c.hayAuto = c.tipos.some(function (T) { return T.modo === 'auto'; });
    return c;
  }

  /* ------------------------------------------------- evaluación de UNA ruta (única fuente de verdad) */
  var R_VACIA = { ok: true, obj: 0, total: 0, vacia: true, jor: 0 };
  var R_CAP = { ok: false, motivo: 'capacidad' };
  var R_VENT = { ok: false, motivo: 'ventana' };
  var R_JOR = { ok: false, motivo: 'jornada' };

  // seq: índices de paradas (1..n) en orden de visita; el depósito (0) se sobreentiende.
  // T: tipo de vehículo; salida: hora de salida; det: devuelve el detalle por parada;
  // sinJor: no exige la jornada máxima (la usan el estimador y la grilla de salida, que la comprueban aparte).
  // Devuelve además `shift`: cuánto se puede retrasar la salida eliminando la primera espera sin
  // atrasar ninguna ventana (≥ 0).
  function evaluar(c, seq, T, salida, det, sinJor) {
    var L = seq.length;
    if (L === 0) return R_VACIA;
    var k, j, carga = 0;
    for (k = 0; k < L; k++) carga += c.dem[seq[k]];
    if (carga > T.cap + EPS) return R_CAP;
    var N = c.N, jorMax = sinJor ? Infinity : T.jor;
    var t = salida, prev = 0, km = 0, tol = 0, cond = 0, esp = 0, serv = 0, base = 0;
    var shift = -1, minSlack = Infinity;
    var paradas = det ? [] : null;
    for (k = 0; k < L; k++) {
      j = seq[k];
      var a = prev * N + j;
      var mb = c.minF[a];
      var d = c.sinTraf ? mb : durTraf(t, mb, c.perfil);
      var arr = t + d;
      var vi = c.vIni[j];
      var ini = arr < vi ? vi : arr;
      if (ini > c.vFin[j] + EPS) return R_VENT;
      if (shift < 0) {
        if (ini > arr) shift = Math.min(minSlack, ini - arr);
        else { var sl = c.vFin[j] - ini; if (sl < minSlack) minSlack = sl; }
      }
      var sv = c.serv[j];
      var sal = ini + sv;
      km += c.kmF[a]; tol += c.tolF[a]; cond += d; esp += ini - arr; serv += sv; base += mb;
      if (det) paradas.push({ j: j, a: a, llegada: arr, inicio: ini, espera: ini - arr, salida: sal, km: c.kmF[a], min: d, peaje: c.tolF[a] });
      t = sal; prev = j;
      if (t - salida > jorMax + EPS) return R_JOR;
    }
    var ret = null, fin = t;
    if (c.retorno) {
      var a0 = prev * N + c.fi;
      var mb0 = c.minF[a0];
      var d0 = c.sinTraf ? mb0 : durTraf(t, mb0, c.perfil);
      km += c.kmF[a0]; tol += c.tolF[a0]; cond += d0; base += mb0;
      fin = t + d0;
      if (det) ret = { a: a0, km: c.kmF[a0], min: d0, peaje: c.tolF[a0] };
    }
    var jor = fin - salida;
    if (jor > jorMax + EPS) return R_JOR;
    var cKm = T.km * km, cHr = T.hora * jor / 60;
    var total = T.fijo + cKm + cHr + tol;
    var obj = c.obj === 0 ? T.fijo + cKm + cHr + c.pesoPeaje * tol : (c.obj === 1 ? km : jor);
    return {
      ok: true, obj: obj, total: total, km: km, tol: tol, cond: cond, base: base, esp: esp, serv: serv,
      jor: jor, fin: fin, carga: carga, cFijo: T.fijo, cKm: cKm, cHr: cHr, paradas: paradas, ret: ret,
      salida: salida, shift: shift < 0 ? 0 : shift
    };
  }

  /* ---- hora de salida automática ---- */
  // Camino de desplazamientos desde `desde`: cada paso retrasa la salida lo que elimina la primera espera.
  function caminoSalida(c, seq, T) {
    var out = [], s = T.desde;
    for (var it = 0; it < 4; it++) {
      var r = evaluar(c, seq, T, s, false, true);
      out.push({ s: s, r: r });
      if (!r.ok || r.shift <= 1e-9 || s >= T.hasta) break;
      s = Math.min(T.hasta, s + r.shift);
    }
    return out;
  }
  function factible(r, T) { return r.ok && r.jor <= T.jor + EPS; }
  // por qué ninguno de los resultados rs es factible: jornada (también si solo falló la jornada), capacidad o ventana
  function falloDe(rs) {
    var hayCap = false;
    for (var i = 0; i < rs.length; i++) {
      if (rs[i].ok || rs[i] === R_JOR) return R_JOR;
      if (rs[i] === R_CAP) hayCap = true;
    }
    return hayCap ? R_CAP : R_VENT;
  }

  // Estimador usado durante la búsqueda (2–4 evaluaciones para tipos "auto"; 1 para "fija").
  function evalSlot(S, seq, b) {
    var c = S.c, T = c.tipos[c.slotTipo[b]];
    S.evals++;
    if (T.modo !== 'auto') return evaluar(c, seq, T, T.salida, false, false);
    if (seq.length === 0) return R_VACIA;
    if (S.exacto) return salidaOptima(c, seq, b).res;
    var camino = caminoSalida(c, seq, T), mejor = null, rs = [];
    for (var i = 0; i < camino.length; i++) {
      var r = camino[i].r; rs.push(r);
      if (factible(r, T) && (!mejor || r.obj < mejor.obj - 1e-12)) mejor = r;
    }
    return mejor || falloDe(rs);
  }

  // Elección exacta de la salida: grilla completa + candidatos que eliminan la espera. Devuelve
  // {res, alts}; res es el resultado de evaluar() en la salida elegida (o un fallo).
  function salidaOptima(c, seq, b) {
    var T = c.tipos[c.slotTipo[b]];
    if (T.modo !== 'auto' || seq.length === 0) return { res: evaluar(c, seq, T, T.salida, false, false), alts: null };
    var cands = [], alts = [], rs = [], i;
    var camino = caminoSalida(c, seq, T);
    for (i = 0; i < camino.length; i++) cands.push({ s: camino[i].s, r: camino[i].r });
    for (i = 0; i < T.grilla.length; i++) {
      var g = T.grilla[i];
      var r = evaluar(c, seq, T, g, false, true);
      cands.push({ s: g, r: r });
      alts.push({ salida_min: g, costo: factible(r, T) ? r.total : null });
      if (r.ok && r.shift > 1e-9 && g + r.shift <= T.hasta + 1e-9) cands.push({ s: g + r.shift, r: evaluar(c, seq, T, g + r.shift, false, true) });
    }
    cands.sort(function (x, y) { return x.s - y.s; });
    var mejor = null;
    for (i = 0; i < cands.length; i++) {
      rs.push(cands[i].r);
      if (factible(cands[i].r, T) && (!mejor || cands[i].r.obj < mejor.obj - 1e-9)) mejor = cands[i].r;
    }
    return { res: mejor || falloDe(rs), alts: alts };
  }

  /* ---------------------------------------------------------------- solución */
  function nuevaSol(K) {
    var r = [], o = [], j = [];
    for (var i = 0; i < K; i++) { r.push([]); o.push(0); j.push(-1); }
    return { r: r, o: o, j: j, sa: [] };
  }
  function clonar(s) {
    var r = new Array(s.r.length);
    for (var i = 0; i < r.length; i++) r[i] = s.r[i].slice();
    return { r: r, o: s.o.slice(), j: s.j.slice(), sa: s.sa.slice() };
  }
  function poner(sol, b, seq, res) {
    sol.r[b] = seq; sol.o[b] = res.obj; sol.j[b] = seq.length ? res.jor : -1;
  }
  function jDe(res) { return res.vacia ? -1 : res.jor; }

  // penalización de equilibrio con las rutas a y b (índices o -1) sustituidas por jornadas ja, jb
  function penEq(S, sol, a, ja, b, jb) {
    var w = S.c.wBal, mx = 0, sw = 0, swj = 0;
    for (var r = 0; r < sol.j.length; r++) {
      var j = r === a ? ja : (r === b ? jb : sol.j[r]);
      if (j < 0) continue;
      if (j > mx) mx = j;
      sw += w[r]; swj += w[r] * j;
    }
    return S.eq * (mx * sw - swj);
  }
  function puntaje(S, sol) {
    var t = 0;
    for (var i = 0; i < sol.o.length; i++) t += sol.o[i];
    if (S.eq > 0) t += penEq(S, sol, -1, 0, -1, 0);
    return t + PENAL * sol.sa.length;
  }
  function sumaObj(s) { var t = 0; for (var i = 0; i < s.o.length; i++) t += s.o[i]; return t; }
  // variación del objetivo total si la ruta a pasa a `ra` (y la b a `rb`)
  function delta1(S, sol, a, ra) {
    var d = ra.obj - sol.o[a];
    if (S.eq > 0) d += penEq(S, sol, a, jDe(ra), -1, 0) - penEq(S, sol, -1, 0, -1, 0);
    return d;
  }
  function delta2(S, sol, a, ra, b, rb) {
    var d = ra.obj + rb.obj - sol.o[a] - sol.o[b];
    if (S.eq > 0) d += penEq(S, sol, a, jDe(ra), b, jDe(rb)) - penEq(S, sol, -1, 0, -1, 0);
    return d;
  }

  // estado de búsqueda
  function crearS(c, rng, deadline) {
    return { c: c, rng: rng, deadline: deadline, tick: 0, timeUp: false, evals: 0, eq: c.eq };
  }
  function agotado(S) {
    if (S.timeUp) return true;
    if ((++S.tick & 63) === 0 && Date.now() >= S.deadline) S.timeUp = true;
    return S.timeUp;
  }
  function cargaDe(c, seq) { var t = 0; for (var i = 0; i < seq.length; i++) t += c.dem[seq[i]]; return t; }

  // mejor inserción de la parada j en alguna ruta/vehículo; ruido>0 perturba la elección (ILS)
  function mejorInsercion(S, sol, j, ruido) {
    var c = S.c, K = sol.r.length, mejor = Infinity, res = null, vacioUsado = [];
    for (var b = 0; b < K; b++) {
      var R = sol.r[b], T = c.tipos[c.slotTipo[b]];
      if (R.length === 0) { if (vacioUsado[c.slotTipo[b]]) continue; vacioUsado[c.slotTipo[b]] = true; }
      if (cargaDe(c, R) + c.dem[j] > T.cap + EPS) continue;
      for (var p = 0; p <= R.length; p++) {
        var cand = R.slice(); cand.splice(p, 0, j);
        var rb = evalSlot(S, cand, b);
        if (!rb.ok) continue;
        var delta = delta1(S, sol, b, rb);
        var clave = ruido > 0 ? delta + ruido * Math.abs(delta) * S.rng() : delta;
        if (clave < mejor) { mejor = clave; res = { b: b, cand: cand, r: rb }; }
      }
    }
    return res;
  }

  /* ------------------------------------------------------ construcción: vecino más cercano */
  function construirNN(S) {
    var c = S.c, n = c.n, N = c.N;
    var sol = nuevaSol(c.K);
    var rest = [];
    for (var i = 1; i <= n; i++) rest.push(i);
    var orden = [];
    for (var b0 = 0; b0 < c.K; b0++) orden.push(b0);
    orden.sort(function (x, y) { return (c.tipos[c.slotTipo[y]].cap - c.tipos[c.slotTipo[x]].cap) || (x - y); }); // más capacidad primero (Infinity - Infinity = NaN → ||)
    for (var oi = 0; oi < orden.length && rest.length; oi++) {
      var b = orden[oi], seq = [], cur = 0, ult = null;
      for (;;) {
        var ord = rest.slice().sort(function (x, y) { var dx = c.kmF[cur * N + x], dy = c.kmF[cur * N + y]; return dx - dy || x - y; });
        var elegido = -1;
        for (var q = 0; q < ord.length; q++) {
          var cand = seq.concat([ord[q]]);
          var ev = evalSlot(S, cand, b);
          if (ev.ok) { elegido = ord[q]; ult = ev; break; }
        }
        if (elegido < 0) break;
        seq.push(elegido); cur = elegido;
        rest.splice(rest.indexOf(elegido), 1);
      }
      if (seq.length) poner(sol, b, seq, ult);
    }
    sol.sa = rest;
    return sol;
  }

  /* ------------------------------------------------------ construcción: Clarke-Wright adaptado */
  // Rutas CW con el tipo `ti` como plantilla; luego se asignan a los vehículos reales.
  function construirCW(S, ti) {
    var c = S.c, n = c.n, N = c.N, T = c.tipos[ti];
    var b0 = c.slotTipo.indexOf(ti); // un vehículo cualquiera de ese tipo como representante
    var rutas = {}, rutaDe = new Array(n + 1), sa = [], nextId = 0, ro = {};
    var i, j;
    for (i = 1; i <= n; i++) {
      var v = evalSlot(S, [i], b0);
      if (!v.ok) { sa.push(i); rutaDe[i] = -1; }
      else { rutas[nextId] = [i]; ro[nextId] = v.obj; rutaDe[i] = nextId; nextId++; }
    }
    function arco(a, b) {
      var km = c.kmF[a * N + b], mn = c.minF[a * N + b], tl = c.tolF[a * N + b];
      if (c.obj === 1) return km;
      if (c.obj === 2) return mn;
      return T.km * km + T.hora * mn / 60 + c.pesoPeaje * tl;
    }
    var ahorros = [];
    for (i = 1; i <= n; i++) {
      if (rutaDe[i] < 0) continue;
      for (j = 1; j <= n; j++) {
        if (i === j || rutaDe[j] < 0) continue;
        ahorros.push([(c.retorno ? arco(i, c.fi) : 0) + arco(0, j) - arco(i, j), i, j]);
      }
    }
    ahorros.sort(function (x, y) { return y[0] - x[0] || x[1] - y[1] || x[2] - y[2]; });
    function unir(A, B, ia, ib) {
      var opciones = [];
      var aUlt = A[A.length - 1] === ia, aPri = A[0] === ia, bPri = B[0] === ib, bUlt = B[B.length - 1] === ib;
      if (aUlt && bPri) opciones.push(A.concat(B));
      if (aPri && bPri && A.length > 1) opciones.push(A.slice().reverse().concat(B));
      if (aUlt && bUlt && B.length > 1) opciones.push(A.concat(B.slice().reverse()));
      if (aPri && bUlt && A.length > 1 && B.length > 1) opciones.push(A.slice().reverse().concat(B.slice().reverse()));
      var mejor = null, mv = Infinity;
      for (var q = 0; q < opciones.length; q++) {
        var r = evalSlot(S, opciones[q], b0);
        if (r.ok && r.obj < mv) { mv = r.obj; mejor = opciones[q]; }
      }
      return mejor ? { seq: mejor, v: mv } : null;
    }
    for (var a = 0; a < ahorros.length; a++) {
      if (agotado(S)) break;
      var ii = ahorros[a][1], jj = ahorros[a][2];
      var ri = rutaDe[ii], rj = rutaDe[jj];
      if (ri === rj || ri < 0 || rj < 0) continue;
      var m = unir(rutas[ri], rutas[rj], ii, jj);
      if (m && m.v < ro[ri] + ro[rj] - TOL) {
        rutas[ri] = m.seq; ro[ri] = m.v;
        for (var q2 = 0; q2 < rutas[rj].length; q2++) rutaDe[rutas[rj][q2]] = ri;
        delete rutas[rj]; delete ro[rj];
      }
    }
    var ids = Object.keys(rutas).map(Number);
    // si hay más rutas que vehículos: uniones forzadas de menor sobrecosto
    while (ids.length > c.K && !S.timeUp) {
      var best = null, bd = Infinity;
      for (var x = 0; x < ids.length; x++) for (var y = 0; y < ids.length; y++) {
        if (x === y) continue;
        var seq2 = rutas[ids[x]].concat(rutas[ids[y]]);
        var r2 = evalSlot(S, seq2, b0);
        if (!r2.ok) continue;
        var dd = r2.obj - ro[ids[x]] - ro[ids[y]];
        if (dd < bd) { bd = dd; best = { x: x, y: y, seq: seq2, v: r2.obj }; }
      }
      if (!best) break;
      var keep = ids[best.x], drop = ids[best.y];
      rutas[keep] = best.seq; ro[keep] = best.v; delete rutas[drop]; delete ro[drop];
      ids = Object.keys(rutas).map(Number);
      if (agotado(S)) break;
    }
    ids.sort(function (p1, p2) { return cargaDe(c, rutas[p2]) - cargaDe(c, rutas[p1]) || p1 - p2; });
    // asignación a vehículos reales: las rutas más cargadas escogen primero el vehículo libre más barato que las admite
    var sol = nuevaSol(c.K), libre = [];
    for (var s0 = 0; s0 < c.K; s0++) libre.push(true);
    for (var w = 0; w < ids.length; w++) {
      var seqW = rutas[ids[w]], elegido = -1, rElegido = null, vistoTipo = [];
      for (var s1 = 0; s1 < c.K; s1++) {
        if (!libre[s1] || vistoTipo[c.slotTipo[s1]]) continue;
        vistoTipo[c.slotTipo[s1]] = true;
        var rv = evalSlot(S, seqW, s1);
        if (rv.ok && (!rElegido || rv.obj < rElegido.obj - 1e-12)) { rElegido = rv; elegido = s1; }
      }
      if (elegido < 0) { Array.prototype.push.apply(sa, seqW); continue; }
      libre[elegido] = false; poner(sol, elegido, seqW, rElegido);
    }
    sol.sa = sa;
    return sol;
  }

  /* ------------------------------------------------------ construcción: inserción más barata */
  function construirInsercion(S) {
    var c = S.c, n = c.n;
    var sol = nuevaSol(c.K);
    var orden = [];
    for (var i = 1; i <= n; i++) orden.push(i);
    orden.sort(function (x, y) { return (c.vFin[x] - c.vFin[y]) || (x - y); });
    for (var q = 0; q < orden.length; q++) {
      if (agotado(S)) { sol.sa.push(orden[q]); continue; }
      var ins = mejorInsercion(S, sol, orden[q], 0);
      if (ins) poner(sol, ins.b, ins.cand, ins.r); else sol.sa.push(orden[q]);
    }
    return sol;
  }

  /* ------------------------------------------------------ búsqueda local (VND, primera mejora) */
  function opInsertarSA(S, sol) {
    for (var u = 0; u < sol.sa.length; u++) {
      var ins = mejorInsercion(S, sol, sol.sa[u], 0);
      if (ins) { poner(sol, ins.b, ins.cand, ins.r); sol.sa.splice(u, 1); return true; }
      if (agotado(S)) return false;
    }
    return false;
  }

  function opIntra2opt(S, sol) {
    for (var a = 0; a < sol.r.length; a++) {
      var A = sol.r[a], L = A.length;
      if (L < 2) continue;
      for (var i = 0; i < L - 1; i++) for (var j = i + 1; j < L; j++) {
        var cand = A.slice();
        for (var x = i, y = j; x < y; x++, y--) { var tmp = cand[x]; cand[x] = cand[y]; cand[y] = tmp; }
        var r = evalSlot(S, cand, a);
        if (r.ok && delta1(S, sol, a, r) < -TOL) { poner(sol, a, cand, r); return true; }
        if (agotado(S)) return false;
      }
    }
    return false;
  }

  function opIntraOr(S, sol) {
    for (var a = 0; a < sol.r.length; a++) {
      var A = sol.r[a], L = A.length;
      if (L < 2) continue;
      for (var s = 1; s <= Math.min(3, L - 1); s++) for (var i = 0; i + s <= L; i++) {
        var seg = A.slice(i, i + s), rest = A.slice(0, i).concat(A.slice(i + s));
        for (var p = 0; p <= rest.length; p++) for (var rev = 0; rev < (s > 1 ? 2 : 1); rev++) {
          if (p === i && rev === 0) continue;
          var sg = rev ? seg.slice().reverse() : seg;
          var cand = rest.slice(0, p).concat(sg, rest.slice(p));
          var r = evalSlot(S, cand, a);
          if (r.ok && delta1(S, sol, a, r) < -TOL) { poner(sol, a, cand, r); return true; }
          if (agotado(S)) return false;
        }
      }
    }
    return false;
  }

  function opInterRelocate(S, sol) {
    var c = S.c, K = sol.r.length;
    for (var a = 0; a < K; a++) {
      var A = sol.r[a], La = A.length;
      if (La === 0) continue;
      for (var s = 1; s <= Math.min(3, La); s++) for (var i = 0; i + s <= La; i++) {
        var seg = A.slice(i, i + s), rest = A.slice(0, i).concat(A.slice(i + s));
        var ra = rest.length ? evalSlot(S, rest, a) : R_VACIA;
        if (!ra.ok) continue;
        var segCarga = cargaDe(c, seg), vacioUsado = [];
        for (var b = 0; b < K; b++) {
          if (b === a) continue;
          var B = sol.r[b], Lb = B.length, tb = c.slotTipo[b];
          if (Lb === 0) { if (vacioUsado[tb] || (rest.length === 0 && tb === c.slotTipo[a])) continue; vacioUsado[tb] = true; }
          if (cargaDe(c, B) + segCarga > c.tipos[tb].cap + EPS) continue;
          for (var p = 0; p <= Lb; p++) for (var rev = 0; rev < (s > 1 ? 2 : 1); rev++) {
            var sg = rev ? seg.slice().reverse() : seg;
            var cand = B.slice(0, p).concat(sg, B.slice(p));
            var rb = evalSlot(S, cand, b);
            if (!rb.ok) continue;
            if (delta2(S, sol, a, ra, b, rb) < -TOL) {
              poner(sol, a, rest, ra); poner(sol, b, cand, rb);
              return true;
            }
            if (agotado(S)) return false;
          }
        }
      }
    }
    return false;
  }

  function opInterSwap(S, sol) {
    var K = sol.r.length;
    for (var a = 0; a < K; a++) {
      var A = sol.r[a], La = A.length;
      if (La === 0) continue;
      for (var b = a + 1; b < K; b++) {
        var B = sol.r[b], Lb = B.length;
        if (Lb === 0) continue;
        for (var l1 = 1; l1 <= Math.min(2, La); l1++) for (var l2 = 1; l2 <= Math.min(2, Lb); l2++) {
          for (var i = 0; i + l1 <= La; i++) for (var j = 0; j + l2 <= Lb; j++) {
            var sA = A.slice(i, i + l1), sB = B.slice(j, j + l2);
            var nA = A.slice(0, i).concat(sB, A.slice(i + l1));
            var ra = evalSlot(S, nA, a);
            if (!ra.ok) continue;
            var nB = B.slice(0, j).concat(sA, B.slice(j + l2));
            var rb = evalSlot(S, nB, b);
            if (!rb.ok) continue;
            if (delta2(S, sol, a, ra, b, rb) < -TOL) { poner(sol, a, nA, ra); poner(sol, b, nB, rb); return true; }
            if (agotado(S)) return false;
          }
        }
      }
    }
    return false;
  }

  // SWAP*: intercambia u∈A con v∈B, cada uno reinsertado en la MEJOR posición de la otra ruta
  function opInterSwapStar(S, sol) {
    var K = sol.r.length;
    for (var a = 0; a < K; a++) {
      var A = sol.r[a], La = A.length;
      if (La === 0) continue;
      for (var b = a + 1; b < K; b++) {
        var B = sol.r[b], Lb = B.length;
        if (Lb === 0) continue;
        for (var i = 0; i < La; i++) for (var j = 0; j < Lb; j++) {
          var u = A[i], v = B[j];
          var restA = A.slice(0, i).concat(A.slice(i + 1)), restB = B.slice(0, j).concat(B.slice(j + 1));
          var bestA = null, candA = null, bestB = null, candB = null, p;
          for (p = 0; p <= restA.length; p++) {
            var cA = restA.slice(); cA.splice(p, 0, v);
            var rA = evalSlot(S, cA, a);
            if (rA.ok && (!bestA || rA.obj < bestA.obj)) { bestA = rA; candA = cA; }
          }
          if (!bestA) continue;
          for (p = 0; p <= restB.length; p++) {
            var cB = restB.slice(); cB.splice(p, 0, u);
            var rB = evalSlot(S, cB, b);
            if (rB.ok && (!bestB || rB.obj < bestB.obj)) { bestB = rB; candB = cB; }
          }
          if (!bestB) continue;
          if (delta2(S, sol, a, bestA, b, bestB) < -TOL) { poner(sol, a, candA, bestA); poner(sol, b, candB, bestB); return true; }
          if (agotado(S)) return false;
        }
      }
    }
    return false;
  }

  function opInter2optStar(S, sol) {
    var K = sol.r.length;
    for (var a = 0; a < K; a++) {
      var A = sol.r[a], La = A.length;
      if (La === 0) continue;
      for (var b = a + 1; b < K; b++) {
        var B = sol.r[b], Lb = B.length;
        if (Lb === 0) continue;
        for (var i = 0; i <= La; i++) for (var j = 0; j <= Lb; j++) {
          if ((i === 0 && j === 0) || (i === La && j === Lb)) continue; // identidad
          var nA = A.slice(0, i).concat(B.slice(j));
          var ra = nA.length ? evalSlot(S, nA, a) : R_VACIA;
          if (!ra.ok) continue;
          var nB = B.slice(0, j).concat(A.slice(i));
          var rb = nB.length ? evalSlot(S, nB, b) : R_VACIA;
          if (!rb.ok) continue;
          if (delta2(S, sol, a, ra, b, rb) < -TOL) { poner(sol, a, nA, ra); poner(sol, b, nB, rb); return true; }
          if (agotado(S)) return false;
        }
      }
    }
    return false;
  }

  // Cambia vehículos: la ruta a pasa al vehículo b (de otro tipo) y viceversa (b puede estar libre).
  function opIntercambiarVehiculos(S, sol) {
    var c = S.c, K = sol.r.length, vacioUsado = [];
    for (var a = 0; a < K; a++) {
      var A = sol.r[a];
      if (A.length === 0) continue;
      vacioUsado.length = 0;
      for (var b = 0; b < K; b++) {
        if (b === a || c.slotTipo[b] === c.slotTipo[a]) continue;
        var B = sol.r[b];
        if (B.length === 0) { if (vacioUsado[c.slotTipo[b]]) continue; vacioUsado[c.slotTipo[b]] = true; }
        else if (b < a) continue; // cada par no vacío se prueba una vez
        var rb = evalSlot(S, A, b);
        if (!rb.ok) continue;
        var ra = B.length ? evalSlot(S, B, a) : R_VACIA;
        if (!ra.ok) continue;
        if (delta2(S, sol, a, ra, b, rb) < -TOL) { poner(sol, a, B.slice(), ra); poner(sol, b, A.slice(), rb); return true; }
        if (agotado(S)) return false;
      }
    }
    return false;
  }

  // fusiona dos rutas en una sola (en cualquiera de sus vehículos o en uno libre de otro tipo): una flota
  // mixta necesita este paso conjunto «cambiar de tipo + unir», que ningún movimiento de a una parada alcanza
  function opFusionar(S, sol) {
    var c = S.c, K = sol.r.length, vacioUsado = [];
    for (var a = 0; a < K; a++) {
      if (sol.r[a].length === 0) continue;
      for (var b = a + 1; b < K; b++) {
        if (sol.r[b].length === 0) continue;
        var A = sol.r[a], B = sol.r[b], total = cargaDe(c, A) + cargaDe(c, B);
        if (total > c.capMax + EPS) continue;
        var cands = [A.concat(B), B.concat(A)];
        var largo = A.length >= B.length ? A : B, corto = A.length >= B.length ? B : A, merged = largo.slice(), ok = A.length + B.length <= 14; // la unión por inserción solo en rutas chicas (cuesta O(m²) evaluaciones)
        for (var q = 0; q < corto.length && ok; q++) {
          var mejorV = Infinity, mejorSeq = null;
          for (var pp = 0; pp <= merged.length; pp++) {
            var cs = merged.slice(); cs.splice(pp, 0, corto[q]);
            var rs = evalSlot(S, cs, a);
            if (rs.ok && rs.obj < mejorV) { mejorV = rs.obj; mejorSeq = cs; }
          }
          if (mejorSeq) merged = mejorSeq; else ok = false;
        }
        if (ok) cands.push(merged);
        vacioUsado.length = 0;
        for (var d = 0; d < K; d++) {
          var Td = c.tipos[c.slotTipo[d]];
          if (d !== a && d !== b) {
            if (sol.r[d].length !== 0) continue;
            if (vacioUsado[c.slotTipo[d]] || c.slotTipo[d] === c.slotTipo[a] || c.slotTipo[d] === c.slotTipo[b]) continue;
            vacioUsado[c.slotTipo[d]] = true;
          }
          if (total > Td.cap + EPS) continue;
          for (var k2 = 0; k2 < cands.length; k2++) {
            var rd = evalSlot(S, cands[k2], d);
            if (!rd.ok) continue;
            var delta = rd.obj - sol.o[a] - sol.o[b] - (d !== a && d !== b ? sol.o[d] : 0);
            if (S.eq > 0) {
              var sj = sol.j.slice();
              var antes = penEq(S, sol, -1, 0, -1, 0);
              sol.j[a] = -1; sol.j[b] = -1; sol.j[d] = rd.jor;
              var despues = penEq(S, sol, -1, 0, -1, 0);
              sol.j = sj;
              delta += despues - antes;
            }
            if (delta < -TOL) {
              poner(sol, a, [], R_VACIA); poner(sol, b, [], R_VACIA);
              poner(sol, d, cands[k2].slice(), rd);
              return true;
            }
            if (agotado(S)) return false;
          }
        }
      }
    }
    return false;
  }

  function busquedaLocal(S, sol) {
    var mejora = true;
    while (mejora && !S.timeUp) {
      mejora = opInsertarSA(S, sol) || opIntra2opt(S, sol) || opIntraOr(S, sol) ||
        opInterRelocate(S, sol) || opInterSwap(S, sol) || opInterSwapStar(S, sol) || opInter2optStar(S, sol) ||
        (S.c.tipos.length > 1 && (opIntercambiarVehiculos(S, sol) || opFusionar(S, sol)));
    }
  }

  /* ------------------------------------------------------ perturbación (ruin & recreate) */
  function perturbar(S, sol) {
    var c = S.c, rng = S.rng, N = c.N;
    var asig = [];
    for (var a = 0; a < sol.r.length; a++) for (var q = 0; q < sol.r[a].length; q++) asig.push(sol.r[a][q]);
    if (asig.length === 0) return false;
    var kmax = Math.max(3, Math.min(15, Math.ceil(asig.length * 0.35)));
    if (rng() < 0.15) kmax = Math.min(asig.length, kmax * 2); // de vez en cuando, una ruptura grande
    var k = 1 + Math.floor(rng() * kmax);
    if (k > asig.length) k = asig.length;
    var quitar = [];
    var estr = Math.floor(rng() * 4);
    if (estr === 0) {
      var pool = asig.slice();
      for (var t = 0; t < k; t++) { var ix = Math.floor(rng() * pool.length); quitar.push(pool[ix]); pool.splice(ix, 1); }
    } else if (estr === 1) {
      // con paradas sin atender, a menudo se rompe el entorno de una de ellas para hacerle sitio
      var semilla = (sol.sa.length && rng() < 0.5) ? sol.sa[Math.floor(rng() * sol.sa.length)] : asig[Math.floor(rng() * asig.length)];
      var ord = asig.slice().sort(function (x, y) { return (c.kmF[semilla * N + x] + c.kmF[x * N + semilla]) - (c.kmF[semilla * N + y] + c.kmF[y * N + semilla]) || x - y; });
      quitar = ord.slice(0, k);
    } else if (estr === 3) { // vaciar una ruta completa (la más corta de dos al azar): ayuda a reducir flota
      var nv = [];
      for (var r3 = 0; r3 < sol.r.length; r3++) if (sol.r[r3].length) nv.push(r3);
      var c1 = nv[Math.floor(rng() * nv.length)], c2 = nv[Math.floor(rng() * nv.length)];
      quitar = sol.r[sol.r[c1].length <= sol.r[c2].length ? c1 : c2].slice();
    } else {
      var noVacias = [];
      for (var r2 = 0; r2 < sol.r.length; r2++) if (sol.r[r2].length) noVacias.push(r2);
      var rr = noVacias[Math.floor(rng() * noVacias.length)];
      var R = sol.r[rr];
      var len = Math.min(k, R.length);
      var st = Math.floor(rng() * (R.length - len + 1));
      quitar = R.slice(st, st + len);
    }
    var marca = {};
    for (var z = 0; z < quitar.length; z++) marca[quitar[z]] = true;
    for (var b = 0; b < sol.r.length; b++) {
      var Rb = sol.r[b];
      var hay = false;
      for (var y = 0; y < Rb.length; y++) if (marca[Rb[y]]) { hay = true; break; }
      if (!hay) continue;
      var nuevo = Rb.filter(function (x) { return !marca[x]; });
      var rv = nuevo.length ? evalSlot(S, nuevo, b) : R_VACIA;
      if (!rv.ok) return false; // caso patológico (desigualdad triangular rota): se descarta la perturbación
      poner(sol, b, nuevo, rv);
    }
    var previas = sol.sa;
    var lista = quitar.concat(previas);
    sol.sa = [];
    // orden de reinserción: las que ya estaban sin atender primero (a veces), aleatorio o por urgencia de ventana con ruido
    if (previas.length && rng() < 0.5) {
      var frente = previas.slice(), resto2 = quitar.slice(), ii, jj, tt;
      for (ii = frente.length - 1; ii > 0; ii--) { jj = Math.floor(rng() * (ii + 1)); tt = frente[ii]; frente[ii] = frente[jj]; frente[jj] = tt; }
      for (ii = resto2.length - 1; ii > 0; ii--) { jj = Math.floor(rng() * (ii + 1)); tt = resto2[ii]; resto2[ii] = resto2[jj]; resto2[jj] = tt; }
      lista = frente.concat(resto2);
    } else if (rng() < 0.5) {
      for (var i = lista.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var tmp = lista[i]; lista[i] = lista[j]; lista[j] = tmp; }
    } else {
      var clave = {};
      for (var u = 0; u < lista.length; u++) { var f = c.vFin[lista[u]]; clave[lista[u]] = (isFinite(f) ? f : 1e6) + rng() * 120; }
      lista.sort(function (x, y) { return clave[x] - clave[y]; });
    }
    var ruido = [0, 0.3, 0.8][Math.floor(rng() * 3)];
    for (var w = 0; w < lista.length; w++) {
      var ins = mejorInsercion(S, sol, lista[w], ruido);
      if (ins) poner(sol, ins.b, ins.cand, ins.r); else sol.sa.push(lista[w]);
    }
    return true;
  }

  /* ------------------------------------------------------ armado del resultado */
  function motivoNoAtendida(c, j) {
    var cabe = c.tipos.filter(function (T) { return c.dem[j] <= T.cap + EPS; });
    if (!cabe.length) return 'excede capacidad';
    var hayJor = false;
    for (var i = 0; i < cabe.length; i++) {
      var T = cabe[i], rs;
      if (T.modo === 'auto') rs = caminoSalida(c, [j], T).map(function (x) { return x.r; });
      else rs = [evaluar(c, [j], T, T.salida, false, false)];
      for (var q = 0; q < rs.length; q++) if (factible(rs[q], T)) return 'sin vehículo disponible';
      if (falloDe(rs) === R_JOR) hayJor = true;
    }
    return hayJor ? 'excede jornada' : 'ventana imposible';
  }

  // Fija la salida exacta de las rutas de tipo "auto" (actualiza o/j). Devuelve el detalle por ruta.
  function refinarSalidas(c, sol) {
    var info = new Array(sol.r.length);
    for (var b = 0; b < sol.r.length; b++) {
      if (!sol.r[b].length) continue;
      var so = salidaOptima(c, sol.r[b], b);
      info[b] = so;
      if (so.res.ok) { sol.o[b] = so.res.obj; sol.j[b] = so.res.jor; }
    }
    return info;
  }

  function submuestra(alts, elegido) {
    var out = alts.slice();
    if (out.length > 23) {
      var paso = (out.length - 1) / 22, res = [];
      for (var i = 0; i < 23; i++) res.push(alts[Math.round(i * paso)]);
      out = res;
    }
    var hay = false;
    for (var k = 0; k < out.length; k++) if (Math.abs(out[k].salida_min - elegido.salida_min) < 1e-9) hay = true;
    if (!hay) out.push(elegido);
    out.sort(function (x, y) { return x.salida_min - y.salida_min; });
    return out;
  }

  function armarRuta(c, seq, veh, b, so, numTipo) {
    var T = c.tipos[c.slotTipo[b]];
    var sal = so.res.ok ? so.res.salida : T.salida;
    var e = evaluar(c, seq, T, sal, true, false);
    if (!e.ok) e = evaluar(c, seq, T, sal, true, true); // (no debería ocurrir) ruta sin la jornada máxima
    var paradas = [], peajes = [], prevId = c.ids[0];
    for (var q = 0; q < e.paradas.length; q++) {
      var s = e.paradas[q];
      paradas.push({
        id: c.ids[s.j], nombre: c.nombres[s.j], llegada_min: s.llegada, inicio_servicio_min: s.inicio, espera_min: s.espera,
        salida_min: s.salida, km_tramo: s.km, min_tramo: s.min, peaje_tramo: s.peaje
      });
      var lst = c.listaPeajes[s.a];
      if (lst) for (var z = 0; z < lst.length; z++) peajes.push({ id: lst[z].id, nombre: lst[z].nombre, costo: lst[z].costo, entre: [prevId, c.ids[s.j]] });
      prevId = c.ids[s.j];
    }
    var retorno = null;
    if (e.ret) {
      retorno = { km: e.ret.km, min: e.ret.min, peaje: e.ret.peaje };
      var l2 = c.listaPeajes[e.ret.a];
      if (l2) for (var z2 = 0; z2 < l2.length; z2++) peajes.push({ id: l2[z2].id, nombre: l2[z2].nombre, costo: l2[z2].costo, entre: [prevId, c.ids[c.fi]] });
    }
    var auto = T.modo === 'auto';
    return {
      vehiculo: veh, tipo: T.id, tipo_nombre: T.nombre, vehiculo_nombre: T.nombre + ' ' + numTipo,
      capacidad: isFinite(T.cap) ? T.cap : null, utilizacion_pct: isFinite(T.cap) && T.cap > 0 ? 100 * e.carga / T.cap : null,
      paradas: paradas, salida_deposito_min: e.salida, salida_auto: auto,
      salida_alternativas: auto && so.alts ? submuestra(so.alts, { salida_min: e.salida, costo: e.total }) : [],
      regreso_min: e.fin, retorno_deposito: c.retorno,
      fin_modo: c.finModo, fin: c.finModo === 'ultima' ? (paradas.length ? { id: paradas[paradas.length - 1].id, nombre: paradas[paradas.length - 1].nombre } : null) : { id: c.ids[c.fi], nombre: c.nombres[c.fi] },
      km: e.km, min_conduccion: e.cond, min_flujo_libre: e.base, min_espera: e.esp, min_servicio: e.serv, min_jornada: e.jor,
      carga: e.carga, retorno: retorno, peajes: peajes,
      costo: { fijo: e.cFijo, km: e.cKm, hora: e.cHr, peajes: e.tol, total: e.total },
      _obj: e.obj, _b: b
    };
  }

  // sol (con o sin salidas ya refinadas): arma rutas, no atendidas y totales.
  function armarSolucion(c, sol, motivos) {
    var rutas = [], veh = 1, cuenta = {};
    for (var b = 0; b < sol.r.length; b++) {
      if (!sol.r[b].length) continue;
      var so = salidaOptima(c, sol.r[b], b);
      var ti = c.slotTipo[b];
      cuenta[ti] = (cuenta[ti] || 0) + 1;
      rutas.push(armarRuta(c, sol.r[b], veh++, b, so, cuenta[ti]));
    }
    var sa = sol.sa.slice().sort(function (x, y) { return x - y; });
    var noAt = sa.map(function (j) { return { id: c.ids[j], motivo: (motivos && motivos[j]) || motivoNoAtendida(c, j) }; });
    var T = {
      vehiculos_usados: rutas.length, km: 0, min_jornada_total: 0, min_conduccion: 0, min_espera: 0, peajes: 0, costo: 0,
      atendidas: 0, no_atendidas: noAt.length, valor_objetivo: 0, jornada_max_min: 0, jornada_min_min: 0, desequilibrio_min: 0
    };
    var obj = 0, jmax = 0, jmin = Infinity;
    rutas.forEach(function (r) {
      T.km += r.km; T.min_jornada_total += r.min_jornada; T.min_conduccion += r.min_conduccion; T.min_espera += r.min_espera;
      T.peajes += r.costo.peajes; T.costo += r.costo.total; T.atendidas += r.paradas.length;
      obj += r._obj;
      if (r.min_jornada > jmax) jmax = r.min_jornada;
      if (r.min_jornada < jmin) jmin = r.min_jornada;
    });
    if (c.eq > 0) rutas.forEach(function (r) { obj += c.eq * (jmax - r.min_jornada) * c.wBal[r._b]; });
    rutas.forEach(function (r) { delete r._obj; delete r._b; });
    T.valor_objetivo = obj;
    if (rutas.length) { T.jornada_max_min = jmax; T.jornada_min_min = jmin; T.desequilibrio_min = jmax - jmin; }
    return { rutas: rutas, no_atendidas: noAt, totales: T };
  }

  function armarSupuestos(c, p, extra) {
    var s = [], m = c.mats, P = m.parametros, e = m.estimados;
    var pct = function (x) { return e.arcos ? ' (' + x + ' de ' + e.arcos + ' arcos)' : ''; };
    if (m.fuente.km === 'matriz') s.push('Distancias tomadas de la matriz entregada (datos reales de calles, calculados fuera del motor).');
    else if (m.fuente.km === 'mixta') s.push('Distancias: parte de la matriz entregada y parte estimada' + pct(e.km) + ' en línea recta × ' + P.circuidad + (P.circuidad_default ? ' (circuidad genérica supuesta, no medida)' : ' (circuidad indicada por el usuario)') + '.');
    else s.push('Distancias estimadas en línea recta (haversine) × ' + P.circuidad + (P.circuidad_default ? ' (circuidad genérica supuesta, no medida)' : ' (circuidad indicada por el usuario)') + '; no son distancias por calle.');
    if (m.fuente.min === 'matriz') s.push('Tiempos a flujo libre tomados de la matriz entregada; el tráfico se aplica encima con el perfil por hora.');
    else if (m.fuente.min === 'mixta') s.push('Tiempos a flujo libre: parte de la matriz y parte estimada' + pct(e.min) + ' como km ÷ ' + P.velocidad_kmh + ' km/h × 60' + (P.velocidad_default ? ' (velocidad genérica supuesta)' : '') + '.');
    else s.push('Tiempos a flujo libre estimados como km ÷ ' + P.velocidad_kmh + ' km/h × 60' + (P.velocidad_default ? ' (velocidad genérica supuesta, no medida)' : ' (velocidad indicada por el usuario)') + '.');
    if (c.perfilOrigen === 'preset:lima_tipico') s.push('Tráfico: perfil «lima_tipico» = SUPUESTO genérico de ejemplo (picos 7–9 h y 17–20 h), no son datos medidos. Edítalo con tus datos.');
    else if (c.perfilOrigen === 'usuario') s.push('Tráfico: factores por hora definidos por el usuario (el motor no los ha verificado).');
    else if (c.perfilOrigen.indexOf('preset:') === 0) s.push('Tráfico: perfil «' + c.perfilOrigen.slice(7) + '».');
    else s.push('Sin tráfico: factor 1 en todas las horas (los tiempos son a flujo libre).');
    s.push('Tráfico modelado con consumo FIFO por hora: salir después nunca llega antes.');
    if (m.fuente.peaje === 'estimada' || m.fuente.peaje === 'mixta')
      s.push('Peajes detectados cuando el segmento recto entre dos puntos pasa a ≤ radio_m del peaje (aproximación en línea recta; la ruta real por calles puede pasar o no por él).' + (m.fuente.peaje === 'mixta' ? ' Los arcos con dato en matriz.peaje usan ese dato.' : ''));
    else if (m.fuente.peaje === 'matriz') s.push('Peajes tomados de matriz.peaje (costo por arco).');
    else s.push('No hay peajes registrados ni matriz de peajes: costo de peajes = 0.');
    if (c.tipos.length === 1 && c.tipos[0].modo === 'fija')
      s.push('Todos los vehículos salen del depósito a las ' + formatoHoraDia(c.tipos[0].salida) + (p && p.salida_min == null && !(esObj(p && p.flota) && esNum(p.flota.salida_min)) ? ' (hora por defecto supuesta: 08:00)' : '') + '.');
    else c.tipos.forEach(function (T) {
      s.push(T.nombre + ': ' + (T.modo === 'fija' ? 'sale a las ' + formatoHoraDia(T.salida) + ' (fija).'
        : 'cada ruta sale a la hora que minimiza su costo entre ' + formatoHoraDia(T.desde) + ' y ' + formatoHoraDia(T.hasta) + ' (paso ' + T.paso + ' min); la hora se elige por ruta, sin mirar el equilibrio.'));
    });
    if (c.tipos.length > 1 || (esObj(p && p.flota) && Array.isArray(p.flota.tipos)))
      s.push('Flota: ' + c.tipos.map(function (T) { return T.cantidad + ' × ' + T.nombre + ' (capacidad ' + (isFinite(T.cap) ? T.cap : 'sin límite') + ')'; }).join(', ') + '. Los costos, la capacidad y la jornada máxima son de cada tipo.');
    if (c.cruzaMedianoche) s.push(c.cruzaMedianoche + ' ventana(s) cruzan la medianoche: el fin se interpreta del día siguiente (+1440 min).');
    s.push(c.finModo === 'otro' ? 'Cada ruta termina en el depósito final «' + c.nombres[c.fi] + '» (distinto del de salida); la jornada se cuenta de la salida a esa llegada (incluye espera y servicio).' : c.retorno ? 'Cada ruta termina en el depósito; la jornada se cuenta de la salida al regreso (incluye espera y servicio).' : 'Cada ruta termina en su última parada (sin regreso al depósito); la jornada termina cuando sale de esa parada.');
    s.push('Costo = fijo por vehículo usado + km × costo_km + horas de jornada × costo_hora + peajes.');
    s.push('Ventanas duras: si se llega antes se espera; el servicio debe comenzar antes del fin de la ventana.');
    s.push('Objetivo de optimización: ' + c.objetivo + (c.obj === 0 && c.pesoPeaje !== 1 ? ' (peajes ponderados ×' + c.pesoPeaje + ' dentro del objetivo; el costo reportado es el real)' : '') + '.');
    if (c.eq > 0) s.push('Equilibrio de jornada ' + c.eq + ': se penaliza dentro del objetivo (no en el costo reportado) el tiempo que cada conductor trabaja menos que el de la ruta más larga.');
    if (extra) for (var i = 0; i < extra.length; i++) s.push(extra[i]);
    return s;
  }

  /* ------------------------------------------------------ API: optimizar */
  function optimizar(problema, opciones) {
    var t0 = Date.now();
    try {
      var v = validar(problema);
      if (!v.ok) return { ok: false, errores: v.errores, avisos: v.avisos };
      var op = esObj(opciones) ? opciones : {};
      var semilla = esNum(op.semilla) ? op.semilla : 1;
      var tiempo = esNum(op.tiempo_ms) && op.tiempo_ms >= 0 ? op.tiempo_ms : 2500;
      var maxIter = esNum(op.max_iter) && op.max_iter >= 0 ? op.max_iter : Infinity;
      var c = crearContexto(problema);
      var n = c.n;
      var tiempoPedido = tiempo;
      // 2.ª corrida (costo_equilibrio) solo si su 25 % del tiempo alcanza para una construcción mínima (~0.12 ms por parada)
      var conSegunda = c.eq > 0 && !op._interno && 0.25 * tiempoPedido >= 0.12 * n;
      if (conSegunda) tiempo = tiempo * 0.75;
      // el posproceso fijo (pulido, armado, garantía contra la base) se descuenta del presupuesto de búsqueda:
      // ~0.07 ms por parada (+ la grilla de las salidas «auto»); la holgura que queda es la de una construcción inicial
      var gTot = 0;
      c.tipos.forEach(function (T) { if (T.modo === 'auto') gTot += T.grilla.length; });
      var reserva = Math.min(0.4 * tiempo, 0.07 * n * (1 + gTot / 40));
      var tBusca = tiempo - reserva;
      var sinMejoraMax = esNum(op.sin_mejora) && op.sin_mejora >= 0 ? op.sin_mejora : Math.max(2000, 200 * n);
      var rng = mulberry32(semilla);
      var S = crearS(c, rng, t0 + tBusca);
      // salida «auto»: en problemas chicos toda la búsqueda usa la grilla exacta; en grandes, el estimador y un pulido exacto final
      var gMax = 0;
      c.tipos.forEach(function (T) { if (T.modo === 'auto' && T.grilla.length > gMax) gMax = T.grilla.length; });
      var busquedaExacta = c.hayAuto && n * gMax <= 600;
      if (busquedaExacta) S.exacto = true;
      else if (c.hayAuto) S.deadline = t0 + tBusca * 0.88; // el resto del tiempo es para el pulido con salida exacta

      var sNN = construirNN(S);
      var best = sNN, bestP = puntaje(S, sNN);
      var iteraciones = 0;

      if (n > 0 && c.K > 0) {
        var inicios = [];
        var usados = {};
        // cada construcción cuesta ~ 2e-4 · n² ms: solo se hacen las que caben en el presupuesto de búsqueda
        var costoInicio = 2e-4 * n * n, cabeOtro = function () { return Date.now() - t0 + costoInicio <= tBusca; };
        c.tipos.slice().map(function (T, i) { return i; }).sort(function (x, y) { return (c.tipos[y].cap - c.tipos[x].cap) || (x - y); }).slice(0, 4).forEach(function (ti) {
          if (c.tipos[ti].cantidad > 0 && !usados[ti] && (inicios.length === 0 || cabeOtro())) { usados[ti] = true; inicios.push(construirCW(S, ti)); }
        });
        if (inicios.length === 0 || cabeOtro()) inicios.push(construirInsercion(S));
        // con flota mixta una construcción peor puede caer en una cuenca mejor: se mejora cada inicio y se elige el mejor
        var mejorarTodos = c.tipos.length > 1;
        for (var q = 0; q < inicios.length; q++) {
          var ini = inicios[q];
          if (mejorarTodos && (q === 0 || Date.now() - t0 < 0.2 * tiempo)) { ini = clonar(ini); busquedaLocal(S, ini); } // en problemas grandes no se gasta más del 20 % del tiempo en esto
          var pq = puntaje(S, ini);
          if (pq < bestP - TOL) { best = ini; bestP = pq; }
        }
        best = clonar(best);
        busquedaLocal(S, best);
        bestP = puntaje(S, best);
        var cur = clonar(best), curP = bestP, sinMejora = 0;
        var ultProg = Date.now();
        var reinicio = 60 + 2 * n;
        while (!S.timeUp && iteraciones < maxIter && sinMejora < sinMejoraMax) {
          if (Date.now() >= S.deadline) { S.timeUp = true; break; }
          iteraciones++;
          var cand = clonar(cur);
          var ok = perturbar(S, cand);
          if (ok) busquedaLocal(S, cand);
          var cp = ok ? puntaje(S, cand) : Infinity;
          if (cp < bestP - TOL) { best = clonar(cand); bestP = cp; sinMejora = 0; }
          else sinMejora++;
          var umbral = 0.01 * Math.max(1, sumaObj(best)) * Math.max(0, 1 - sinMejora / sinMejoraMax);
          if (ok && cp <= curP + umbral) { cur = cand; curP = cp; }
          if (sinMejora > 0 && sinMejora % reinicio === 0) { cur = clonar(best); curP = bestP; }
          if (typeof op.progreso === 'function') {
            var ahora = Date.now();
            if (ahora - ultProg >= 150) {
              ultProg = ahora;
              try {
                var parcial = armarSolucion(c, clonar(best));
                op.progreso({ iteraciones: iteraciones, ms: ahora - t0, fraccion: Math.min(1, (ahora - t0) / Math.max(1, tiempo)), mejor_costo: parcial.totales.costo, mejor_objetivo: parcial.totales.valor_objetivo, no_atendidas: parcial.totales.no_atendidas });
              } catch (e) { /* un fallo de la UI no debe romper el cálculo */ }
            }
          }
        }
        if (!S.timeUp) busquedaLocal(S, best);
        // pulido final con la salida EXACTA (grilla completa) para los tipos «auto»: la búsqueda usó el estimador
        if (c.hayAuto && n > 0 && !busquedaExacta) {
          S.exacto = true; S.timeUp = false; S.deadline = Math.max(t0 + tBusca, Date.now() + 15);
          refinarSalidas(c, best);
          busquedaLocal(S, best);
          bestP = puntaje(S, best);
          S.exacto = false;
        }
        // garantía: nunca peor que la base (con las salidas exactas de ambas)
        var bx = clonar(best), nx = clonar(sNN);
        refinarSalidas(c, bx); refinarSalidas(c, nx);
        if (puntaje(S, bx) > puntaje(S, nx) + TOL) best = sNN;
      }

      var res = armarSolucion(c, best);
      var base = armarSolucion(c, sNN);
      var ahorroCosto = base.totales.costo - res.totales.costo;
      var out = {
        ok: true,
        rutas: res.rutas,
        no_atendidas: res.no_atendidas,
        totales: res.totales,
        base: { descripcion: 'vecino más cercano sin mejora', totales: base.totales, rutas: base.rutas, no_atendidas: base.no_atendidas },
        ahorro: {
          costo: ahorroCosto,
          costo_pct: base.totales.costo > 0 ? 100 * ahorroCosto / base.totales.costo : 0,
          km: base.totales.km - res.totales.km,
          min: base.totales.min_jornada_total - res.totales.min_jornada_total
        },
        supuestos: armarSupuestos(c, problema, ['Solución heurística (construcción + búsqueda local + ILS): buena pero no garantiza el óptimo global.']),
        avisos: v.avisos,
        semilla: semilla, iteraciones: iteraciones, evaluaciones: S.evals, ms: 0
      };
      if (conSegunda) {
        var p0 = Object.assign({}, problema, { equilibrio: 0 });
        var r0 = optimizar(p0, { semilla: semilla, tiempo_ms: (esNum(op.tiempo_ms) && op.tiempo_ms >= 0 ? op.tiempo_ms : 2500) * 0.25, max_iter: op.max_iter, sin_mejora: op.sin_mejora, _interno: true });
        if (r0.ok) {
          out.costo_equilibrio = Math.max(0, res.totales.costo - r0.totales.costo);
          out.costo_equilibrio_aprox = true;
          out.supuestos.push('costo_equilibrio es aproximado: costo real del plan equilibrado menos el de otra corrida corta sin equilibrio (heurística; se recorta a ≥ 0).');
        }
      }
      out.ms = Date.now() - t0;
      return out;
    } catch (e) {
      return { ok: false, errores: ['Error interno del motor: ' + (e && e.message ? e.message : String(e))] };
    }
  }

  /* ------------------------------------------------------ API: evaluarRutas */
  function evaluarRutas(problema, rutasIds) {
    var t0 = Date.now();
    try {
      var v = validar(problema);
      if (!v.ok) return { ok: false, errores: v.errores, avisos: v.avisos };
      if (!Array.isArray(rutasIds)) return { ok: false, errores: ['rutasIds debe ser una lista de listas de ids, p. ej. [["C3","C1"],["C2"]].'] };
      var c = crearContexto(problema);
      var S = crearS(c, mulberry32(1), Infinity);
      var porId = Object.create(null);
      for (var i = 1; i <= c.n; i++) porId[c.ids[i]] = i;
      var avisos = v.avisos.slice();
      var motivos = {}, usados = {}, sa = [];
      var sol = nuevaSol(c.K), libre = [];
      for (var s0 = 0; s0 < c.K; s0++) libre.push(true);
      var motivoDe = function (m) { return m === R_VENT ? 'ventana imposible' : (m === R_JOR ? 'excede jornada' : 'excede capacidad'); };
      for (var r = 0; r < rutasIds.length; r++) {
        var entrada = rutasIds[r], lista, tipoForzado = null;
        if (esObj(entrada) && Array.isArray(entrada.ids)) { lista = entrada.ids; if (entrada.tipo != null) tipoForzado = String(entrada.tipo); }
        else if (Array.isArray(entrada)) lista = entrada;
        else { avisos.push('La ruta ' + (r + 1) + ' no es una lista: se ignora.'); continue; }
        var seq = [];
        for (var q = 0; q < lista.length; q++) {
          var k = String(lista[q]);
          if (!tiene(porId, k)) { avisos.push('Id desconocido «' + k + '» en la ruta ' + (r + 1) + ': se ignora.'); continue; }
          var j = porId[k];
          if (usados[j]) { avisos.push('La parada «' + k + '» aparece más de una vez: se usa solo la primera.'); continue; }
          usados[j] = true; seq.push(j);
        }
        if (!seq.length) continue;
        // vehículo: el libre factible de menor objetivo (un representante por tipo); si ninguno admite la ruta entera,
        // el de mayor capacidad
        var elegido = -1, rEl = null, vistoTipo = [], fallback = -1;
        for (var s1 = 0; s1 < c.K; s1++) {
          if (!libre[s1] || vistoTipo[c.slotTipo[s1]]) continue;
          if (tipoForzado !== null && c.tipos[c.slotTipo[s1]].id !== tipoForzado) continue;
          vistoTipo[c.slotTipo[s1]] = true;
          if (fallback < 0 || c.tipos[c.slotTipo[s1]].cap > c.tipos[c.slotTipo[fallback]].cap) fallback = s1;
          var rv = evalSlot(S, seq, s1);
          if (rv.ok && (!rEl || rv.obj < rEl.obj - 1e-12)) { rEl = rv; elegido = s1; }
        }
        if (tipoForzado !== null && fallback < 0) avisos.push('No hay vehículo libre del tipo «' + tipoForzado + '» para la ruta ' + (r + 1) + '.');
        if (elegido < 0 && fallback < 0) { seq.forEach(function (j2) { sa.push(j2); motivos[j2] = 'sin vehículo disponible'; }); continue; }
        if (elegido >= 0) { libre[elegido] = false; poner(sol, elegido, seq, rEl); continue; }
        // ninguna admite la ruta completa: se recorta en orden sobre el vehículo de mayor capacidad
        var acc = [], ultimo = null;
        for (var z = 0; z < seq.length; z++) {
          var cand = acc.concat([seq[z]]);
          var ee = evalSlot(S, cand, fallback);
          if (ee.ok) { acc = cand; ultimo = ee; }
          else { sa.push(seq[z]); motivos[seq[z]] = motivoDe(ee); }
        }
        if (acc.length) { libre[fallback] = false; poner(sol, fallback, acc, ultimo); }
      }
      for (var j3 = 1; j3 <= c.n; j3++) {
        if (usados[j3]) continue;
        sa.push(j3);
        var mi = motivoNoAtendida(c, j3); // si ni sola cabe, se dice por qué; si cabe, simplemente no estaba en las rutas
        motivos[j3] = mi === 'sin vehículo disponible' ? 'no incluida en las rutas indicadas' : mi;
      }
      sol.sa = sa;
      var res = armarSolucion(c, sol, motivos);
      return {
        ok: true, rutas: res.rutas, no_atendidas: res.no_atendidas, totales: res.totales,
        base: { descripcion: 'ruta indicada por el usuario (sin optimizar)', totales: res.totales },
        ahorro: { costo: 0, costo_pct: 0, km: 0, min: 0 },
        supuestos: armarSupuestos(c, problema, ['Se evalúan las rutas tal como las indicó el usuario; las paradas que las vuelven infactibles pasan a no atendidas.']),
        avisos: avisos, semilla: null, iteraciones: 0, ms: Date.now() - t0
      };
    } catch (e) {
      return { ok: false, errores: ['Error interno del motor: ' + (e && e.message ? e.message : String(e))] };
    }
  }

  /* ------------------------------------------------------ API: barrerHoraSalida */
  function barrerHoraSalida(problema, op) {
    try {
      var v = validar(problema);
      if (!v.ok) return { ok: false, errores: v.errores };
      op = esObj(op) ? op : {};
      var erroresB = [];
      // lo omitido usa el valor por defecto; lo presente pero inválido es un error (no se corrige en silencio)
      var dado = function (k) { return op[k] !== undefined && op[k] !== null; };
      if (dado('desde_min') && (!esNum(op.desde_min) || op.desde_min < 0 || op.desde_min > 4320)) erroresB.push('desde_min debe ser un número de minutos entre 0 y 4320.');
      if (dado('hasta_min') && (!esNum(op.hasta_min) || op.hasta_min < 0 || op.hasta_min > 4320)) erroresB.push('hasta_min debe ser un número de minutos entre 0 y 4320.');
      if (dado('paso_min') && (!esNum(op.paso_min) || op.paso_min <= 0)) erroresB.push('paso_min debe ser un número mayor que 0.');
      if (dado('tiempo_ms_por_punto') && (!esNum(op.tiempo_ms_por_punto) || op.tiempo_ms_por_punto < 0)) erroresB.push('tiempo_ms_por_punto debe ser un número ≥ 0.');
      if (erroresB.length) return { ok: false, errores: erroresB };
      var desde = dado('desde_min') ? op.desde_min : 360;
      var hasta = dado('hasta_min') ? op.hasta_min : 600;
      var paso = dado('paso_min') ? op.paso_min : 30;
      var tms = dado('tiempo_ms_por_punto') ? op.tiempo_ms_por_punto : 300;
      if (hasta < desde) return { ok: false, errores: ['hasta_min debe ser ≥ desde_min.'] };
      var np = Math.floor((hasta - desde) / paso + 1e-9) + 1;
      if (np > 500) return { ok: false, errores: ['Demasiados puntos (' + np + '): aumenta paso_min o reduce el rango (máx. 500).'] };
      var puntos = [], mejor = -1, mejorClave = null;
      for (var i = 0; i < np; i++) {
        var t = desde + i * paso;
        var p2 = Object.assign({}, problema, { salida_min: t });
        if (esObj(problema.flota) && Array.isArray(problema.flota.tipos))
          p2.flota = Object.assign({}, problema.flota, { tipos: problema.flota.tipos.map(function (T) { return Object.assign({}, T, { salida_modo: 'fija', salida_min: t }); }) });
        var r = optimizar(p2, { semilla: esNum(op.semilla) ? op.semilla : 1, tiempo_ms: tms, sin_mejora: op.sin_mejora, max_iter: op.max_iter });
        if (!r.ok) return { ok: false, errores: r.errores };
        puntos.push({
          salida_min: t, costo: r.totales.costo, km: r.totales.km, min_jornada_total: r.totales.min_jornada_total,
          peajes: r.totales.peajes, no_atendidas: r.totales.no_atendidas, valor_objetivo: r.totales.valor_objetivo
        });
        var clave = [r.totales.no_atendidas, r.totales.valor_objetivo];
        if (mejor < 0 || clave[0] < mejorClave[0] || (clave[0] === mejorClave[0] && clave[1] < mejorClave[1] - TOL)) { mejor = i; mejorClave = clave; }
      }
      return { ok: true, puntos: puntos, mejor: mejor, mejor_salida_min: mejor >= 0 ? puntos[mejor].salida_min : null };
    } catch (e) {
      return { ok: false, errores: ['Error interno del motor: ' + (e && e.message ? e.message : String(e))] };
    }
  }

  /* ------------------------------------------------------ API: calcularFlete */
  // Reparte el costo REAL de cada ruta entre sus paradas (la suma por ruta es exactamente el costo de la ruta)
  // y le aplica el margen/markup, mínimo por parada, redondeo e IGV.  Los criterios de reparto son comerciales,
  // no verdades físicas: se declaran en `supuestos`.
  function calcularFlete(problema, resultado, tarifa) {
    try {
      var v = validar(problema);
      if (!v.ok) return { ok: false, errores: v.errores };
      if (!esObj(resultado) || resultado.ok !== true || !Array.isArray(resultado.rutas)) return { ok: false, errores: ['«resultado» debe ser el resultado ok de optimizar o evaluarRutas.'] };
      var errores = [];
      if (!esObj(tarifa)) return { ok: false, errores: ['Indica la tarifa: {tipo_margen, pct, ...}. Falta el margen (indica el margen).'] };
      var tipoM = tarifa.tipo_margen == null ? 'markup' : tarifa.tipo_margen;
      if (tipoM !== 'markup' && tipoM !== 'margen') errores.push('tipo_margen debe ser "markup" o "margen".');
      if (!esNum(tarifa.pct)) errores.push('Indica el margen: tarifa.pct es obligatorio (p. ej. 45 con tipo_margen "markup").');
      else if (tarifa.pct < 0) errores.push('tarifa.pct no puede ser negativo.');
      else if (tipoM === 'margen' && tarifa.pct > 99.99) errores.push('Con tipo_margen "margen", pct debe ser menor que 100 (máximo 99.99).');
      else if (tipoM === 'markup' && tarifa.pct > 1000) errores.push('Con tipo_margen "markup", pct no puede pasar de 1000 (revisa el valor).');
      var igvPct = tarifa.igv_pct == null ? 18 : tarifa.igv_pct;
      if (!esNum(igvPct) || igvPct < 0 || igvPct > 100) errores.push('igv_pct debe ser un número entre 0 y 100.');
      var base = tarifa.base_prorrateo == null ? 'mixto' : tarifa.base_prorrateo;
      if (['mixto', 'desvio', 'peso', 'igual'].indexOf(base) < 0) errores.push('base_prorrateo debe ser "mixto", "desvio", "peso" o "igual".');
      var minimo = tarifa.minimo_parada == null ? 0 : tarifa.minimo_parada;
      if (!esNum(minimo) || minimo < 0 || minimo > 1e9) errores.push('minimo_parada debe ser un número entre 0 y 1 000 000 000.');
      var redondeo = tarifa.redondeo == null ? 0 : tarifa.redondeo;
      if (!esNum(redondeo) || redondeo < 0 || redondeo > 1e6 || (redondeo > 0 && redondeo < 0.001)) errores.push('redondeo debe ser 0 (sin redondeo) o un múltiplo entre 0.001 y 1 000 000.');
      if (errores.length) return { ok: false, errores: errores };

      var c = crearContexto(problema);
      var porId = Object.create(null);
      for (var i = 1; i <= c.n; i++) porId[c.ids[i]] = i;
      var factor = tipoM === 'markup' ? 1 + tarifa.pct / 100 : 1 / (1 - tarifa.pct / 100);
      var rutasOut = [], paradasOut = [], pesoCero = [];
      var T = { costo: 0, flete_sin_igv: 0, igv: 0, flete_total: 0, ganancia: 0, markup_pct: 0, margen_pct: 0, ajuste_redondeo: 0, ajuste_minimos: 0 };

      var normaliza = function (w) {
        var s = 0, k;
        for (k = 0; k < w.length; k++) s += w[k];
        if (!(s > 0)) return null;
        return w.map(function (x) { return x / s; });
      };
      var iguales = function (m) { var a = []; for (var k = 0; k < m; k++) a.push(1 / m); return a; };

      for (var ri = 0; ri < resultado.rutas.length; ri++) {
        var R = resultado.rutas[ri];
        if (!esObj(R) || !Array.isArray(R.paradas) || !R.paradas.length || !esObj(R.costo)) continue;
        var compCosto = ['total', 'km', 'hora', 'fijo', 'peajes'];
        for (var cc = 0; cc < compCosto.length; cc++)
          if (!esNum(R.costo[compCosto[cc]]) || R.costo[compCosto[cc]] < 0) return { ok: false, errores: ['El resultado está alterado o incompleto: costo.' + compCosto[cc] + ' de la ruta ' + (ri + 1) + ' no es un número ≥ 0.'] };
        if (Math.abs(R.costo.km + R.costo.hora + R.costo.fijo + R.costo.peajes - R.costo.total) > 1e-6 * (1 + Math.abs(R.costo.total)))
          return { ok: false, errores: ['El resultado está alterado: los componentes del costo de la ruta ' + (ri + 1) + ' no suman su costo total.'] };
        var seq = [];
        for (var q = 0; q < R.paradas.length; q++) {
          var idx = porId[String(R.paradas[q].id)];
          if (idx === undefined) return { ok: false, errores: ['La parada «' + R.paradas[q].id + '» del resultado no existe en el problema.'] };
          seq.push(idx);
        }
        var m = seq.length;
        var ti = 0;
        for (var tt = 0; tt < c.tipos.length; tt++) if (c.tipos[tt].id === R.tipo) ti = tt;
        var Tp = c.tipos[ti], sal = esNum(R.salida_deposito_min) ? R.salida_deposito_min : Tp.salida;
        var full = evaluar(c, seq, Tp, sal, false, true);
        var wKm = [], wMin = [], wPea = [], wPeso = [], k2;
        for (k2 = 0; k2 < m; k2++) {
          var sin = seq.slice(); sin.splice(k2, 1);
          var ev = sin.length ? evaluar(c, sin, Tp, sal, false, true) : null;
          var dKm = full.ok ? (ev && ev.ok ? full.km - ev.km : full.km) : 0;
          var dCond = full.ok ? (ev && ev.ok ? full.cond - ev.cond : full.cond) : 0;
          var dTol = full.ok ? (ev && ev.ok ? full.tol - ev.tol : full.tol) : 0;
          wKm.push(Math.max(0, dKm));
          wMin.push(c.serv[seq[k2]] + Math.max(0, dCond));
          wPea.push(Math.max(0, dTol));
          wPeso.push(c.dem[seq[k2]] * c.kmF[seq[k2]]); // km directos depósito→parada (índice 0*N + j)
        }
        var shKm = normaliza(wKm) || iguales(m);
        var shMin = normaliza(wMin) || iguales(m);
        var shPea = normaliza(wPea) || normaliza(wKm) || iguales(m);
        if (base === 'peso' && normaliza(wPeso)) wPeso.forEach(function (x, k) { if (!(x > 0)) pesoCero.push(R.paradas[k].id); });
        var shPeso = normaliza(wPeso) || normaliza(seq.map(function (j) { return c.kmF[j]; })) || iguales(m);
        var shIg = iguales(m);
        var mezcla = function (des) {
          if (base === 'igual') return shIg;
          if (base === 'peso') return shPeso;
          if (base === 'desvio') return des;
          return des.map(function (x, k) { return 0.5 * x + 0.5 * shPeso[k]; });
        };
        var fKm = mezcla(shKm), fMin = mezcla(shMin), fPea = mezcla(shPea);
        var cs = R.costo;
        var sumaRuta = 0, igvRuta = 0, costoRuta = cs.total;
        var detalleParadas = [];
        for (var k3 = 0; k3 < m; k3++) {
          var det = { km: cs.km * fKm[k3], hora: cs.hora * fMin[k3], fijo: cs.fijo * fMin[k3], peajes: cs.peajes * fPea[k3] };
          var asignado = det.km + det.hora + det.fijo + det.peajes;
          var teorico = asignado * factor;
          var conMin = Math.max(teorico, minimo);
          var redond = redondeo > 0 ? Math.max(conMin, limpio(Math.ceil(conMin / redondeo - 1e-9) * redondeo)) : conMin; // el redondeo nunca baja el precio
          var igv = redond * igvPct / 100;
          T.ajuste_minimos += conMin - teorico; T.ajuste_redondeo += redond - conMin;
          sumaRuta += redond; igvRuta += igv;
          var par = R.paradas[k3];
          paradasOut.push({
            id: par.id, nombre: par.nombre, vehiculo: R.vehiculo, demanda: c.dem[seq[k3]],
            costo_asignado: asignado, flete_sin_igv: redond, igv: igv, flete_total: redond + igv, detalle: det
          });
          detalleParadas.push(asignado);
        }
        var kmR = R.km, horas = R.min_jornada / 60;
        rutasOut.push({
          vehiculo: R.vehiculo, vehiculo_nombre: R.vehiculo_nombre || ('Vehículo ' + R.vehiculo), costo: costoRuta,
          precio_sin_igv: sumaRuta, igv: igvRuta, precio_total: sumaRuta + igvRuta,
          utilizacion_pct: R.utilizacion_pct == null ? null : R.utilizacion_pct,
          por_km: kmR > 0 ? sumaRuta / kmR : null, por_hora: horas > 0 ? sumaRuta / horas : null,
          por_unidad_carga: R.carga > 0 ? sumaRuta / R.carga : null
        });
        T.costo += costoRuta; T.flete_sin_igv += sumaRuta; T.igv += igvRuta;
      }
      if (![T.costo, T.flete_sin_igv, T.igv].every(isFinite)) return { ok: false, errores: ['El cálculo del flete no es finito: revisa la tarifa y el resultado.'] };
      T.flete_total = T.flete_sin_igv + T.igv;
      T.ganancia = T.flete_sin_igv - T.costo;
      T.markup_pct = T.costo > 0 ? 100 * T.ganancia / T.costo : 0;
      T.margen_pct = T.flete_sin_igv > 0 ? 100 * T.ganancia / T.flete_sin_igv : 0;
      var nom = { mixto: 'mitad según el desvío que aporta cada parada y mitad según toneladas-km (demanda × km directos)', desvio: 'según el desvío marginal que aporta cada parada (km, minutos y peajes)', peso: 'según demanda × km directos desde el depósito', igual: 'en partes iguales' };
      var supuestos = [
        'El costo de cada ruta (el real calculado por el motor con TUS costos) se reparte ' + nom[base] + '. Es un criterio comercial, no una verdad física.',
        'Cada componente se reparte aparte: km según el desvío en km; horas y costo fijo según el tiempo (servicio + desvío en minutos); peajes según el peaje marginal (si es 0, según km).',
        (tipoM === 'markup' ? 'Precio = costo × (1 + ' + tarifa.pct + ' %).' : 'Precio = costo ÷ (1 − ' + tarifa.pct + ' %) (margen sobre el precio).') + ' IGV ' + igvPct + ' % sobre el flete de cada parada.',
        'Mínimo por parada ' + minimo + (redondeo > 0 ? ' y redondeo hacia arriba a múltiplos de ' + redondeo : ' (sin redondeo)') + '; sus efectos aparecen en ajuste_minimos y ajuste_redondeo.',
        'El flete depende de los costos de flota que ingresaste (combustible, conductor, fijos); no es una tarifa oficial ni un comprobante.'
      ];
      if (pesoCero.length) supuestos.push('Con base_prorrateo "peso" estas paradas tienen peso 0 (demanda 0) y reciben flete 0 aunque tienen servicio y desvío: ' + pesoCero.join(', ') + '. Se recomienda usar "mixto".');
      var noAt = (resultado.no_atendidas || []).map(function (u) { return u.id; });
      if (noAt.length) supuestos.push('Paradas no atendidas (sin flete): ' + noAt.join(', ') + '.');
      return {
        ok: true, rutas: rutasOut, paradas: paradasOut, totales: T,
        piso: { flete_sin_igv: T.costo, nota: 'por debajo de esto pierdes dinero' },
        no_atendidas: noAt, supuestos: supuestos
      };
    } catch (e) {
      return { ok: false, errores: ['Error interno del motor: ' + (e && e.message ? e.message : String(e))] };
    }
  }

  return {
    VERSION: VERSION,
    optimizar: optimizar,
    evaluarRutas: evaluarRutas,
    barrerHoraSalida: barrerHoraSalida,
    calcularFlete: calcularFlete,
    construirMatrices: construirMatrices,
    duracionConTrafico: duracionConTrafico,
    peajesEnGeometria: peajesEnGeometria,
    validar: validar,
    distanciaKm: distanciaKm,
    PERFILES_TRAFICO: PERFILES_TRAFICO,
    PERFILES_TRAFICO_NOTAS: PERFILES_TRAFICO_NOTAS,
    formatoHora: formatoHora,
    formatoHoraDia: formatoHoraDia,
    parseHora: parseHora
  };
});
