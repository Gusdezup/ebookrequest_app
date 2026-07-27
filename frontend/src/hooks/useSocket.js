import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL } from '../config';

let sharedSocket = null;
let refCount = 0;
const statusListeners = new Set();

function notifyStatus() {
  statusListeners.forEach(fn => fn(sharedSocket?.connected ?? false));
}

function getSocket() {
  if (!sharedSocket) {
    sharedSocket = io(API_URL || window.location.origin, {
      withCredentials: true,
      path: '/socket.io',
      reconnectionDelay: 2000,
      reconnectionAttempts: 5,
    });
    sharedSocket.on('connect', notifyStatus);
    sharedSocket.on('disconnect', notifyStatus);
    sharedSocket.on('connect_error', notifyStatus);
  }
  return sharedSocket;
}

function releaseSocket() {
  refCount--;
  if (refCount <= 0 && sharedSocket) {
    sharedSocket.disconnect();
    sharedSocket = null;
    refCount = 0;
    notifyStatus();
  }
}

export function useSocket(event, handler, enabled = true) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;

    refCount++;
    const socket = getSocket();
    const listener = (data) => handlerRef.current(data);
    socket.on(event, listener);

    return () => {
      socket.off(event, listener);
      releaseSocket();
    };
  }, [event, enabled]);
}

export function useSocketStatus() {
  const [connected, setConnected] = useState(sharedSocket?.connected ?? false);

  useEffect(() => {
    refCount++;
    const socket = getSocket();
    const update = (status) => setConnected(status);
    statusListeners.add(update);
    setConnected(socket.connected);

    return () => {
      statusListeners.delete(update);
      releaseSocket();
    };
  }, []);

  return connected;
}
