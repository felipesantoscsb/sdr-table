// src/conversation/store.js
//
// DECISÃO TÉCNICA: Por que guardar em memória (Map) e não banco de dados?
// → Para começar simples. Em produção, troque por Redis ou SQLite.
//   A interface (getHistory / addMessage) não muda — só a implementação interna.
//
// DECISÃO TÉCNICA: Por que separar histórico por número de WhatsApp?
// → Cada lead tem sua própria conversa. Se misturasse, a IA ficaria confusa.

const conversations = new Map();
// Estrutura: Map<phone, { messages: [], isActiveLead: boolean }>

export function getConversation(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, {
      messages: [],       // histórico no formato { role, content }
      isActiveLead: false, // só true se veio pelo webhook do Make
      leadData: null,     // dados originais do lead
    });
  }
  return conversations.get(phone);
}

export function addMessage(phone, role, content) {
  const conv = getConversation(phone);
  conv.messages.push({ role, content });

  // Limita histórico a 50 mensagens para não explodir o contexto da IA
  // Motivo: a API da Anthropic cobra por token — histórico infinito = custo infinito
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
