// src/redis.js

import Redis from 'ioredis';

let redis;

export function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 500, 2000);
      },
    });
    redis.on('connect', () => console.log('✅ Redis conectado'));
    redis.on('error', (err) => console.error('❌ Redis erro:', err.message));
  }
  return redis;
}

export async function safeGet(key) {
  try { return await getRedis().get(key); } catch { return null; }
}

export async function safeSet(key, value, ...args) {
  try { return await getRedis().set(key, value, ...args); } catch { return null; }
}

export async function safeDel(key) {
  try { return await getRedis().del(key); } catch { return null; }
}

export async function safeRpush(key, value) {
  try { return await getRedis().rpush(key, value); } catch { return null; }
}

export async function safeLrange(key, start, end) {
  try { return await getRedis().lrange(key, start, end); } catch { return []; }
}

export async function safeKeys(pattern) {
  try { return await getRedis().keys(pattern); } catch { return []; }
}

// Devolve o valor DEPOIS do incremento, ou null se o Redis estiver fora.
// Null importa: um contador que falha em silêncio faz o circuit breaker nunca
// disparar, que é justamente quando ele precisaria.
export async function safeIncr(key, ttlSeconds = null) {
  try {
    const r = getRedis();
    const valor = await r.incr(key);
    if (ttlSeconds && valor === 1) await r.expire(key, ttlSeconds);
    return valor;
  } catch { return null; }
}

export async function safeExpire(key, seconds) {
  try { return await getRedis().expire(key, seconds); } catch { return null; }
}
