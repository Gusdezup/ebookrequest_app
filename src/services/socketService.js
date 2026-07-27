import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import Session from '../models/Session.js';
import cookie from 'cookie';

const JWT_SECRET = process.env.JWT_SECRET;

let io = null;

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: false,
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    try {
      const cookies = cookie.parse(socket.handshake.headers.cookie || '');
      const token = cookies.token;
      if (!token) return next(new Error('Non authentifié'));

      const payload = jwt.verify(token, JWT_SECRET);
      const session = await Session.findById(payload.sid);
      if (!session || session.expiresAt < new Date()) return next(new Error('Session invalide'));

      socket.userId = payload.id;
      socket.userRole = payload.role;
      next();
    } catch (err) {
      console.log('[socket.io] erreur auth:', err.message);
      next(new Error('Token invalide'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);
    if (socket.userRole === 'admin') socket.join('admins');
  });

  return io;
}

export function emitToUser(userId, event, data) {
  if (!io) return;
  io.to(`user:${userId.toString()}`).emit(event, data);
}

export function emitToAdmins(event, data) {
  if (!io) return;
  io.to('admins').emit(event, data);
}
