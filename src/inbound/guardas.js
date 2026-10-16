// Proteções contra disparo descontrolado no inbound.
//
// Em 14/10/2026 uma lead recebeu a mesma mensagem três vezes. A causa daquele
// caso foi outra (reação de joinha acordando o agente), mas o episódio mostrou
// que o fluxo não tinha NENHUMA rede embaixo: sem dedup, sem teto, sem lock.
// Três coisas diferentes, que falham de jeitos diferentes:
//
//   1. DEDUP por id da mensagem. A Z-API reentrega webhook. Reentrega sem
//      dedup é exatamente a forma "mesma mensagem repetida N vezes".
//   2. BREAKER por excedente. Portado da LIA, que aprendeu isso num incidente
//      de 888 envios: contar volume bruto confunde conversa rápida legítima
//      com loop. O que separa os dois não é velocidade, é a lead não estar
//      falando no meio. Então conta-se ENVIOS MENOS ENTRADAS na janela.
//   3. LOCK na abertura. Duas mensagens simultâneas de um número novo abririam
//      duas conversas e mandariam duas saudações.
//
// Tudo em Redis. Se o Redis estiver fora, as guardas falham abertas — mas aí
// o estado inteiro da conversa já está fora junto, e o problema é maior.

import { safeGet, safeSet, safeIncr, safeDel } from '../redis.js';
import { normalizePhone } from '../conversation/store.js';

// Mesma injeção do quizCadence: permite QA determinístico sem Redis real.
// Namespace de módulo ES é congelado, então trocar o export por fora não é
// possível — a porta tem de estar aqui dentro.
const producao = { safeGet, safeSet, safeIncr, safeDel };
let dep = { ...producao };
export function setGuardasTestDependencies(overrides = {}) { dep = { ...producao, ...overrides }; }
export function resetGuardasTestDependencies() { dep = { ...producao }; }

const JANELA_SEG = Number(process.env.INBOUND_JANELA_SEG || 300);      // 5 min
const EXCEDENTE_MAX = Number(process.env.INBOUND_EXCEDENTE_MAX || 4);  // envios além do que ela escreveu
const TETO_JANELA = EXCEDENTE_MAX * 4;                                  // mesmo conversando, ninguém precisa disso
const DEDUP_TTL = 6 * 60 * 60;
const LOCK_TTL = 60;

const k = {
  msg:  (id) => `inbound_msg:${id}`,
  out:  (p) => `inbound_out:${normalizePhone(p)}`,
  in:   (p) => `inbound_in:${normalizePhone(p)}`,
  susp: (p) => `inbound_suspenso:${normalizePhone(p)}`,
  lock: (p) => `inbound_lock:${normalizePhone(p)}`,
};

export function idDaMensagem(body = {}) {
  return body.messageId || body.id || body.message_id || null;
}

/**
 * true quando esta mensagem JÁ foi processada antes.
 *
 * Sem id no payload devolve false: processar é melhor que ignorar, e aí as
 * outras duas guardas é que seguram.
 */
export async function jaProcessada(body) {
  const id = idDaMensagem(body);
  if (!id) return false;
  // INCR, não SET NX. `SET ... NX` devolve null quando a chave JÁ EXISTE, e o
  // safeSet devolve null quando o Redis está FORA — indistinguíveis, e eu
  // tratava os dois como "pode processar". O dedup não fazia nada.
  // INCR separa os três casos: 1 = nova, >1 = repetida, null = Redis fora.
  const n = await dep.safeIncr(k.msg(id), DEDUP_TTL);
  if (n === null) return false;   // sem Redis, processar é melhor que ignorar
  return n > 1;
}

/** Mensagem da lead entrou. É o denominador do breaker. */
export async function registrarEntrada(phone) {
  await dep.safeIncr(k.in(phone), JANELA_SEG);
}

export async function suspenso(phone) {
  return Boolean(await dep.safeGet(k.susp(phone)));
}

export async function liberar(phone) {
  await dep.safeDel(k.susp(phone));
  await dep.safeDel(k.out(phone));
  await dep.safeDel(k.in(phone));
}

/**
 * Registra o envio e decide se ele pode sair.
 *
 * Conta ANTES de liberar, de propósito: se contasse depois, um envio que
 * trava no meio nunca entraria na conta e o loop ficaria invisível — foi o
 * erro que a LIA corrigiu depois do incidente dela.
 */
export async function podeEnviar(phone) {
  if (await suspenso(phone)) {
    return { ok: false, motivo: 'suspenso', detalhe: 'envio já suspenso para este número' };
  }
  const saidas = await dep.safeIncr(k.out(phone), JANELA_SEG);
  if (saidas === null) return { ok: true };       // Redis fora: falha aberta

  const entradas = Number(await dep.safeGet(k.in(phone))) || 0;
  const excedente = saidas - entradas;

  if (excedente >= EXCEDENTE_MAX || saidas >= TETO_JANELA) {
    await dep.safeSet(k.susp(phone), String(Date.now()), 'EX', 24 * 60 * 60);
    const detalhe = saidas >= TETO_JANELA
      ? `${saidas} envios em ${Math.round(JANELA_SEG / 60)}min (teto absoluto)`
      : `${saidas} envios para ${entradas} mensagem(ns) dela em ${Math.round(JANELA_SEG / 60)}min`;
    console.error(`🚨 [inbound] CIRCUIT BREAKER para ${normalizePhone(phone)}: ${detalhe}`);
    return { ok: false, motivo: 'breaker', detalhe, primeiraVez: true };
  }
  return { ok: true };
}

/**
 * Lock curto na abertura. Mesmo motivo do dedup para usar INCR: com SET NX não
 * dá para separar "lock ocupado" de "Redis fora", e tratar Redis fora como
 * lock ocupado faria a lead ser ignorada em silêncio num hiccup.
 */
export async function travarAbertura(phone) {
  const n = await dep.safeIncr(k.lock(phone), LOCK_TTL);
  if (n === null) return true;   // sem Redis: segue, dupla saudação é menos pior que silêncio
  return n === 1;
}

export async function destravarAbertura(phone) {
  await dep.safeDel(k.lock(phone));
}

export const LIMITES = { JANELA_SEG, EXCEDENTE_MAX, TETO_JANELA };
