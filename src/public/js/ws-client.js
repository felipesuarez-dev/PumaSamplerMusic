export function createWebSocketClient() {
  const listeners = new Map();
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectDelay = 1000;
      emit('ws:connected', {});
    };

    ws.onmessage = (event) => {
      try {
        const { event: name, payload } = JSON.parse(event.data);
        emit(name, payload);
      } catch (err) {
        console.error('Invalid WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      emit('ws:disconnected', {});
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      emit('ws:error', err);
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connect();
    }, reconnectDelay);
  }

  function emit(event, payload) {
    const handlers = listeners.get(event) || [];
    handlers.forEach((fn) => fn(payload));
  }

  function on(event, handler) {
    if (!listeners.has(event)) {
      listeners.set(event, []);
    }
    listeners.get(event).push(handler);
    return () => {
      const handlers = listeners.get(event);
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    };
  }

  function send(event, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, payload }));
    }
  }

  connect();

  return { on, send, close: () => ws?.close() };
}
