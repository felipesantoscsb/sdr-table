// Travas contra disparo descontrolado no inbound.
//
// Em 14/10/2026 uma lead recebeu a mesma mensagem três vezes. A causa daquele
// caso era outra, mas o fluxo não tinha rede embaixo: sem dedup, sem teto, sem
// lock. Estes testes rodam a lógica de verdade com um Redis falso.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (f) => readFileSync(join(root, f), 'utf8');

process.env.ANTHROPIC_API_KEY ||= 'test';
process.env.ZAPI_INSTANCE_ID  ||= 'test';
process.env.ZAPI_TOKEN        ||= 'test';
process.env.ZAPI_CLIENT_TOKEN ||= 'test';
process.env.SDR_PHONE         ||= '5511999999999';
process.env.WEBHOOK_SECRET    ||= 'test';

// Redis falso, injetado pela mesma porta que o quizCadence usa. Namespace de
// módulo ES é congelado: trocar o export por fora não funciona.
const dados = new Map();
const g = await import('../src/inbound/guardas.js');
g.setGuardasTestDependencies({
  async safeGet(k) { return dados.has(k) ? String(dados.get(k)) : null; },
  async safeSet(k, v, ...a) {
    if (a.includes('NX') && dados.has(k)) return null;
    dados.set(k, v); return 'OK';
  },
  async safeDel(k) { dados.delete(k); return 1; },
  async safeIncr(k) { const n = (Number(dados.get(k)) || 0) + 1; dados.set(k, n); return n; },
});

const reset = () => dados.clear();

test('mensagem repetida é reconhecida na segunda vez', async () => {
  reset();
  const body = { messageId: 'ABC123' };
  assert.equal(await g.jaProcessada(body), false, 'primeira entrega é nova');
  assert.equal(await g.jaProcessada(body), true, 'reentrega tem de ser pega');
  assert.equal(await g.jaProcessada({ messageId: 'OUTRO' }), false);
});

test('payload sem id não trava o atendimento', async () => {
  reset();
  // Processar é melhor que ignorar: as outras duas guardas é que seguram.
  assert.equal(await g.jaProcessada({}), false);
  assert.equal(await g.jaProcessada({}), false);
});

test('conversa rápida legítima NÃO dispara o breaker', async () => {
  reset();
  const p = '5511988887777';
  // Ela escreve 6 vezes, o agente responde 6. Excedente zero.
  for (let i = 0; i < 6; i++) {
    await g.registrarEntrada(p);
    const r = await g.podeEnviar(p);
    assert.equal(r.ok, true, `envio ${i + 1} foi barrado numa conversa normal`);
  }
});

test('rajada sem a lead falar dispara o breaker', async () => {
  reset();
  const p = '5511988887777';
  await g.registrarEntrada(p); // ela falou UMA vez
  let barrouEm = null;
  for (let i = 1; i <= 10; i++) {
    const r = await g.podeEnviar(p);
    if (!r.ok) { barrouEm = i; break; }
  }
  assert.ok(barrouEm !== null, 'loop não foi barrado');
  assert.ok(barrouEm <= g.LIMITES.EXCEDENTE_MAX + 1, `barrou tarde demais: ${barrouEm}`);
});

test('depois de disparar, fica suspenso e avisa só uma vez', async () => {
  reset();
  const p = '5511988887777';
  let primeiras = 0;
  for (let i = 0; i < 12; i++) {
    const r = await g.podeEnviar(p);
    if (r.primeiraVez) primeiras++;
  }
  assert.equal(primeiras, 1, 'alerta repetido viraria spam no WhatsApp da Karina');
  assert.equal(await g.suspenso(p), true);
  const depois = await g.podeEnviar(p);
  assert.equal(depois.ok, false);
  assert.equal(depois.motivo, 'suspenso');
});

test('liberar destrava e zera a contagem', async () => {
  reset();
  const p = '5511988887777';
  for (let i = 0; i < 12; i++) await g.podeEnviar(p);
  assert.equal(await g.suspenso(p), true);
  await g.liberar(p);
  assert.equal(await g.suspenso(p), false);
  assert.equal((await g.podeEnviar(p)).ok, true);
});

test('o lock de abertura só deixa um passar', async () => {
  reset();
  const p = '5511988887777';
  assert.equal(await g.travarAbertura(p), true);
  assert.equal(await g.travarAbertura(p), false, 'segunda abertura simultânea passou');
  await g.destravarAbertura(p);
  assert.equal(await g.travarAbertura(p), true);
});

test('cada telefone tem sua própria conta', async () => {
  reset();
  for (let i = 0; i < 12; i++) await g.podeEnviar('5511988887777');
  assert.equal(await g.suspenso('5511988887777'), true);
  assert.equal(await g.suspenso('5521977776666'), false, 'suspensão vazou para outro número');
});

// ── Invariantes de onde as guardas estão plugadas ───────────────────────────

test('o breaker mora no sender, não nos chamadores', () => {
  // Guarda em chamador se esquece no próximo caminho novo. No funil único,
  // todo envio ao lead passa por ela: agente, retomada, pedido de texto.
  const s = ler('src/zapi/senderInbound.js');
  assert.match(s, /podeEnviar\(phone\)/);
  assert.match(s, /INBOUND_CIRCUIT_BREAKER/);
  // Resposta de comando da equipe não consome a cota da lead.
  assert.match(s, /if \(!options\.sistema\)/);
});

test('o dedup roda antes do trabalho caro', () => {
  // Transcrição e LLM custam dinheiro por repetição.
  const wh = ler('src/webhook/zapiInboundHandler.js');
  const corpo = wh.slice(wh.indexOf('export async function handleZapiInbound'));
  const posDedup = corpo.indexOf('jaProcessada(body)');
  assert.ok(posDedup > 0, 'dedup ausente');
  assert.ok(posDedup < corpo.indexOf('transcrever('), 'dedup depois da transcrição');
  assert.ok(posDedup < corpo.indexOf('iniciarInbound'), 'dedup depois do agente');
});

test('breaker disparado avisa a Karina em vez de falhar calado', () => {
  const h = ler('src/inbound/handler.js');
  const fn = h.slice(h.indexOf('async function enviarComGuarda'), h.indexOf('export async function retomarInbound'));
  assert.match(fn, /TRAVA DE SEGURANÇA DISPARADA/);
  assert.match(fn, /err\.primeiraVez/, 'alerta tem de ser uma vez só');
  assert.match(fn, /notifyInbound/);
});

test('existe teto de turnos, separado do breaker', () => {
  // O breaker pega BUG (rajada sem ela falar); o teto pega conversa que não anda.
  const h = ler('src/inbound/handler.js');
  assert.match(h, /TETO_TURNOS/);
  assert.match(h, /turnos > TETO_TURNOS/);
  assert.match(h, /setHandedOff\(phone\)/);
});

test('Redis fora faz a guarda falhar ABERTA, não travar o atendimento', async () => {
  // Contador que falha devolve null. Falhar fechado calaria o agente por um
  // hiccup de Redis — e o estado da conversa já mora lá, então Redis fora é
  // um problema maior que este.
  g.setGuardasTestDependencies({
    async safeGet() { return null; },
    async safeSet() { return null; },
    async safeDel() { return null; },
    async safeIncr() { return null; },
  });
  const r = await g.podeEnviar('5511988887777');
  assert.equal(r.ok, true);
  // E mensagem sem dedup possível segue sendo processada.
  assert.equal(await g.jaProcessada({ messageId: 'X' }), false);
  g.resetGuardasTestDependencies();
});
