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
        if (times > 3) return null; // para de tentar após 3 tentativas
        return Math.min(times * 500, 2000);
      },
    });

    redis.on('connect', () => console.log('✅ Redis conectado'));
    redis.on('error', (err) => {
      // Loga mas não deixa crashar o servidor
      console.error('❌ Redis erro:', err.message);
    });
  }
  return redis;
}

// Wrapper seguro — se Redis falhar, retorna null sem crashar
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

export async function safeExpire(key, seconds) {
  try { return await getRedis().expire(key, seconds); } catch { return null; }
}
