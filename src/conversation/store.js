// src/conversation/store.js

const conversations = new Map();

export function getConversation(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, {
      messages: [],
      isActiveLead: false,
      leadData: null,
      handedOff: false, // true após handoff para a Karina
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
