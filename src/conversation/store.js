// src/conversation/store.js
// Gerencia histórico de conversas e estado das leads via Redis.

import { getRedis } from '../redis.js';

export const TURN_LIMIT = 15;

const PREFIX = {
  conv: 'conv:',
  queue: 'queue:',
  lastSeen: 'lastseen:',
};

// ─── Helpers Redis ────────────────────────────────────────────────────────────

async function getConv(phone) {
  const r = getRedis();
  const raw = await r.get(PREFIX.conv + phone);
  return raw ? JSON.parse(raw) : {
    messages: [],
    isActiveLead: false,
    leadData: null,
    handedOff: false,
    turnCount: 0,
  };
}

async function saveConv(phone, conv) {
  const r = getRedis();
  await r.set(PREFIX.conv + phone, JSON.stringify(conv));
}

// ─── API pública ──────────────────────────────────────────────────────────────

export async function addMessage(phone, role, content) {
  const conv = await getConv(phone);
  conv.messages.push({ role, content });
  if (conv.messages.length > 50) conv.messages = conv.messages.slice(-50);
  await saveConv(phone, conv);
}

export async function activateLead(phone, leadData) {
  const conv = await getConv(phone);
  conv.isActiveLead = true;
  conv.leadData = leadData;
  conv.handedOff = false;
  conv.turnCount = 0;
  await saveConv(phone, conv);
  // Registra timestamp de último contato
  await getRedis().set(PREFIX.lastSeen + phone, Date.now());
}

export async function isActiveLead(phone) {
  const conv = await getConv(phone);
  return conv.isActiveLead;
}

export async function getHistory(phone) {
  const conv = await getConv(phone);
  return conv.messages;
}

export async function getLeadData(phone) {
  const conv = await getConv(phone);
  return conv.leadData;
}

export async function isHandedOff(phone) {
  const conv = await getConv(phone);
  return conv.handedOff;
}

export async function setHandedOff(phone) {
  const conv = await getConv(phone);
  conv.handedOff = true;
  await saveConv(phone, conv);
}

export async function incrementTurn(phone) {
  const conv = await getConv(phone);
  conv.turnCount += 1;
  await saveConv(phone, conv);
  // Atualiza último contato
  await getRedis().set(PREFIX.lastSeen + phone, Date.now());
}

export async function getTurnCount(phone) {
  const conv = await getConv(phone);
  return conv.turnCount;
}

// ─── Fila de mensagens fora do horário ───────────────────────────────────────

export async function enqueueMessage(phone, message) {
  const r = getRedis();
  const key = PREFIX.queue + phone;
  await r.rpush(key, message);
  await r.expire(key, 86400); // expira em 24h
  console.log(`📥 Mensagem enfileirada para ${phone}`);
}

export async function dequeueMessages(phone) {
  const r = getRedis();
  const key = PREFIX.queue + phone;
  const messages = await r.lrange(key, 0, -1);
  await r.del(key);
  return messages;
}

export async function getPhonesWithQueue() {
  const r = getRedis();
  const keys = await r.keys(PREFIX.queue + '*');
  return keys.map(k => k.replace(PREFIX.queue, ''));
}

// ─── Follow-up de 3 dias ─────────────────────────────────────────────────────

export async function getInactiveLeads(maxAgeMs) {
  const r = getRedis();
  const keys = await r.keys(PREFIX.lastSeen + '*');
  const now = Date.now();
  const inactive = [];

  for (const key of keys) {
    const ts = await r.get(key);
    if (ts && (now - parseInt(ts)) > maxAgeMs) {
      const phone = key.replace(PREFIX.lastSeen, '');
      const conv = await getConv(phone);
      if (conv.isActiveLead && !conv.handedOff) {
        inactive.push({ phone, leadData: conv.leadData, lastSeen: parseInt(ts) });
      }
    }
  }

  return inactive;
}

export async function markFollowUpSent(phone) {
  await getRedis().set(PREFIX.lastSeen + phone, Date.now());
}

// ─── Histórico consultivo da Karina (em memória, não precisa persistir) ──────

const sdrHistory = [];

export function getSdrHistory() {
  return [...sdrHistory];
}

export function addSdrMessage(role, content) {
  sdrHistory.push({ role, content });
  if (sdrHistory.length > 30) sdrHistory.splice(0, sdrHistory.length - 30);
}
