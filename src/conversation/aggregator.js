// src/conversation/aggregator.js
//
// DECISÃO TÉCNICA: Por que agregar mensagens?
// → Pessoas no WhatsApp mandam "Oi" + "tudo bem?" + "quero saber sobre o produto"
//   em 3 mensagens separadas. Se processássemos cada uma, a IA responderia 3x
//   fora de contexto. O timer de 30s junta tudo numa resposta coerente.
//
// COMO FUNCIONA:
// 1ª mensagem chega → inicia timer de 30s
// 2ª mensagem chega → cancela timer anterior, inicia novo timer de 30s
// Nenhuma mensagem por 30s → dispara processamento com TODAS as mensagens acumuladas

import { config } from '../../config/index.js';

// Map<phone, { timer: TimeoutId, messages: string[] }>
const pendingMessages = new Map();

/**
 * Adiciona mensagem à fila de agregação.
 * Quando o timer vencer, chama onReady com todas as mensagens acumuladas.
 *
 * @param {string} phone - Número do WhatsApp
 * @param {string} message - Texto da mensagem recebida
 * @param {Function} onReady - Callback chamado com (phone, mensagensAgregadas)
 * @param {string} [key] - Chave de agregação. Padrão: o próprio número.
 *
 * A chave existe por causa das DUAS instâncias Z-API: a mesma pessoa pode
 * falar com o número da Karina e com o número do inbound. Agregando só por
 * telefone, as mensagens das duas conversas se misturariam numa string e só
 * um dos callbacks sobreviveria — a resposta sairia na conversa errada.
 */
export function aggregate(phone, message, onReady, key = phone) {
  // Pega ou cria entrada para esta conversa
  if (!pendingMessages.has(key)) {
    pendingMessages.set(key, { timer: null, messages: [] });
  }

  const pending = pendingMessages.get(key);

  // Adiciona mensagem à lista de pendentes
  pending.messages.push(message);

  // Cancela timer anterior (se existir) — o "debounce"
  if (pending.timer) {
    clearTimeout(pending.timer);
  }

  // Inicia novo timer de 30s
  pending.timer = setTimeout(() => {
    // Junta todas as mensagens com quebra de linha
    const combined = pending.messages.join('\n');

    // Limpa o estado desta conversa
    pendingMessages.delete(key);

    // Avisa quem pediu que está pronto para processar
    onReady(phone, combined);
  }, config.aggregationDelay);
}

/**
 * Retorna quantas mensagens estão aguardando para um número.
 * Útil para logs e debugging.
 */
export function getPendingCount(phone, key = phone) {
  return pendingMessages.get(key)?.messages.length ?? 0;
}
