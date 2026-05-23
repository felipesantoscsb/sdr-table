// src/redis.js
// Cliente Redis centralizado. Usado para persistir histórico,
// fila de mensagens fora do horário e controle de follow-up.

import Redis from 'ioredis';

let redis;

export function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    redis.on('connect', () => console.log('✅ Redis conectado'));
    redis.on('error', (err) => console.error('❌ Redis erro:', err.message));
  }
  return redis;
}
