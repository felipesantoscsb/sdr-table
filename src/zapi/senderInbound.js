// Envio pela SEGUNDA instância Z-API (a da satisfação, no Hub).
//
// Por que um sender separado em vez de um parâmetro no sendMessage: o número
// da Karina já está no limite de volume, e o inbound de anúncio é justamente
// o fluxo que vai crescer. Com dois clientes HTTP distintos, construídos a
// partir de variáveis distintas, é IMPOSSÍVEL uma mensagem do inbound sair
// pela instância da Karina por engano de parâmetro.
//
// Faltando variável, o envio é PULADO com aviso. Nunca cai na outra instância:
// é exatamente o erro que a separação existe para impedir.

import axios from 'axios';
import { isBlocked, normalizePhone } from '../conversation/store.js';
import { podeEnviar } from '../inbound/guardas.js';

const PREFIX = 'ZAPI_INBOUND';

function env() {
  return {
    base: process.env[`${PREFIX}_BASE_URL`] || 'https://api.z-api.io',
    instanceId: process.env[`${PREFIX}_INSTANCE_ID`],
    token: process.env[`${PREFIX}_TOKEN`],
    clientToken: process.env[`${PREFIX}_CLIENT_TOKEN`],
  };
}

export function inboundConfigStatus() {
  const e = env();
  const missing = [];
  if (!e.instanceId)  missing.push(`${PREFIX}_INSTANCE_ID`);
  if (!e.token)       missing.push(`${PREFIX}_TOKEN`);
  if (!e.clientToken) missing.push(`${PREFIX}_CLIENT_TOKEN`);
  return { configured: missing.length === 0, missing };
}

function typingDelay(message) {
  const len = message.length;
  if (len <= 80)  return Math.floor(Math.random() * (12000 - 8000) + 8000);
  if (len <= 200) return Math.floor(Math.random() * (25000 - 15000) + 15000);
  return Math.floor(Math.random() * (45000 - 30000) + 30000);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function sendInboundMessage(phone, message, options = {}) {
  const texto = typeof message === 'string' ? message.trim() : '';
  if (!texto) {
    const err = new Error('Mensagem vazia bloqueada antes do envio (inbound)');
    err.code = 'EMPTY_OUTGOING_MESSAGE';
    throw err;
  }

  const { configured, missing } = inboundConfigStatus();
  if (!configured) {
    console.warn(`[inbound] Envio p/ ${phone} pulado — variáveis ausentes: ${missing.join(', ')}`);
    return { skipped: true, missing };
  }

  if (await isBlocked(phone)) {
    console.log(`⛔ [inbound] Envio cancelado para ${normalizePhone(phone)} (número bloqueado)`);
    return null;
  }

  // CIRCUIT BREAKER. Aqui, e não nos chamadores, porque este é o único funil
  // por onde toda mensagem ao lead passa: agente, retomada, pedido de texto.
  // Guarda em chamador se esquece no próximo caminho novo; aqui não tem como.
  // `sistema: true` é a saída para resposta de comando da equipe, que não é
  // conversa com lead e não pode consumir a cota dela.
  if (!options.sistema) {
    const permissao = await podeEnviar(phone);
    if (!permissao.ok) {
      const err = new Error(`Envio bloqueado pela guarda do inbound: ${permissao.detalhe || permissao.motivo}`);
      err.code = 'INBOUND_CIRCUIT_BREAKER';
      err.motivo = permissao.motivo;
      err.detalhe = permissao.detalhe;
      err.primeiraVez = permissao.primeiraVez === true;
      throw err;
    }
  }

  if (!options.skipDelay) {
    const delay = typingDelay(texto);
    console.log(`⏳ [inbound] Aguardando ${Math.round(delay / 1000)}s antes de enviar para ${phone}`);
    await sleep(delay);
  }

  const { base, instanceId, token, clientToken } = env();
  const url = `${base}/instances/${instanceId}/token/${token}/send-text`;
  try {
    const res = await axios.post(url, { phone, message: texto }, {
      headers: { 'Content-Type': 'application/json', 'Client-Token': clientToken },
    });
    console.log(`✅ [inbound] Mensagem enviada para ${phone}`);
    return res.data;
  } catch (error) {
    const detail = error?.response?.data
      ? (typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data))
      : error.message;
    console.error(`❌ [inbound] Erro ao enviar para ${phone}: ${detail}`);
    error.deliveryDetail = detail;
    throw error;
  }
}
