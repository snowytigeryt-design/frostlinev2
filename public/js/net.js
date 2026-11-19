// Thin WebSocket wrapper. Handlers are looked up by message type: handlers.snap(msg), ...
export class Net {
  constructor(handlers) {
    this.h = handlers;
    this.ws = null;
    this.rtt = 0;
    this.open = false;
    this._pingTimer = null;
  }

  connect(room, name) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = (this.ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`));
    ws.onopen = () => {
      this.open = true;
      this.send({ t: 'join', name });
      this._pingTimer = setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 2000);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'pong') this.rtt = Math.round(performance.now() - m.ts);
      const fn = this.h[m.t];
      if (fn) fn(m);
    };
    ws.onclose = () => {
      this.open = false;
      clearInterval(this._pingTimer);
      if (this.h.closed) this.h.closed();
    };
    ws.onerror = () => {};
  }

  send(o) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
  }
}
