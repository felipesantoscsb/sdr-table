// src/conversation/store.js

const conversations = new Map();
const sdrHistory = []; // histórico da conversa consultiva com a Karina

export function getConversation(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, {
      messages: [],
      isActiveLead: false,
      leadData: null,
      handedOff: false,
    });
  }
  return conversations.get(phone);
}

export function addMessage(phone, role, content) {
  const conv = getConversation(phone);
  conv.messages.push({ role, content });
  if (conv.messages.length > 50) {
    conv.messages = conv.messages.slice(-50);
  }
}

export function activateLead(phone, leadData) {
  const conv = getConversation(phone);
  conv.isActiveLead = true;
  conv.leadData = leadData;
  conv.handedOff = false; // reseta handoff se lead reentrar
}

export function isActiveLead(phone) {
  return getConversation(phone).isActiveLead;
}

export function getHistory(phone) {
  return getConversation(phone).messages;
}

export function getLeadData(phone) {
  return getConversation(phone).leadData;
}

export function isHandedOff(phone) {
  return getConversation(phone).handedOff;
}

export function setHandedOff(phone) {
  getConversation(phone).handedOff = true;
}

// Histórico consultivo da Karina
export function getSdrHistory() {
  return [...sdrHistory];
}

export function addSdrMessage(role, content) {
  sdrHistory.push({ role, content });
  // Limita a 30 mensagens para não explodir o contexto
  if (sdrHistory.length > 30) {
    sdrHistory.splice(0, sdrHistory.length - 30);
  }
}
