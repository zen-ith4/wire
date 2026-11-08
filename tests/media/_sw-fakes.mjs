// Shared fakes for the C3 client tests. Not a test file: the runner only
// picks up *.test.mjs.

export class FakePort {
  constructor() {
    this.onmessage = null;
    this.closed = false;
    this.other = null;
  }

  postMessage(data) {
    if (this.other && this.other.onmessage) {
      this.other.onmessage({ data });
    }
  }

  close() {
    this.closed = true;
  }
}

export class FakeMessageChannel {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}

/**
 * Minimal navigator.serviceWorker stand-in. `controller.posted` keeps every
 * message the page sends; `emit('message', ...)` delivers a worker -> page
 * message; `emit('controllerchange')` changes the controller.
 */
export function makeServiceWorker({ enabled = true, reply = true, postError = null } = {}) {
  const listeners = new Map();

  const controller = {
    posted: [],
    postMessage(data, transfer) {
      this.posted.push({ data, transfer });
      if (postError) throw postError;

      if (data && data.type === 'MEDIA_STREAM_STATUS' && reply) {
        const port = transfer && transfer[0];
        if (port && typeof port.postMessage === 'function') {
          queueMicrotask(() => port.postMessage({
            type: 'MEDIA_STREAM_STATUS',
            enabled,
          }));
        }
      }
    },
  };

  const serviceWorker = {
    controller,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
    },
    emit(type, event) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) fn(event);
    },
  };

  return { serviceWorker, controller };
}

export function fakeTimer() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeoutFn() {},
    fire(index = 0) {
      const timer = timers[index];
      if (timer) timer.fn();
    },
  };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));
