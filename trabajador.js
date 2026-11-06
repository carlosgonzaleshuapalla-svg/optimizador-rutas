/* trabajador.js — corre el motor en un hilo aparte (Web Worker) para que la pantalla no se congele.
   Solo traduce mensajes: toda la matemática sigue en motor.js. Si este archivo no carga
   (por ejemplo al abrir index.html con doble clic), app.js calcula en el hilo principal como antes. */
importScripts('motor.js');
var M = self.MotorRutas;
self.onmessage = function (e) {
  var m = e.data || {};
  try {
    var r;
    if (!M) throw new Error('no se cargó motor.js en el hilo de cálculo');
    if (m.op === 'optimizar') {
      var op = m.opts || {};
      op.progreso = function (p) { self.postMessage({ id: m.id, tipo: 'progreso', p: p }); };
      r = M.optimizar(m.args, op);
    } else if (m.op === 'barrer') {
      r = M.barrerHoraSalida(m.args, m.opts || {});
    } else {
      throw new Error('operación desconocida: ' + m.op);
    }
    self.postMessage({ id: m.id, tipo: 'fin', r: r });
  } catch (err) {
    self.postMessage({ id: m.id, tipo: 'error', mensaje: String((err && err.message) || err) });
  }
};
