import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (f) => readFileSync(join(root, f), 'utf8');
const ai = ler('src/ai/anthropic.js');
const handler = ler('src/oferta/handler.js');
const zapi = ler('src/webhook/zapiHandler.js');
const prompt = ler('config/prompts/oferta.txt');

test('imagem nem chega na LLM: handoff direto', () => {
  const fn = ai.slice(ai.indexOf('export async function generateOfertaReply'));
  assert.match(fn, /if \(temImagem\) \{[^]*handoff_motivo: 'comprovante'/);
  // a decisão vem ANTES da chamada ao modelo
  assert.ok(fn.indexOf('temImagem') < fn.indexOf('client.messages.create'));
});

test('mensagem só com imagem não é mais descartada — mas só no modo oferta', () => {
  // era `if (!phone || !messageText) return`, que engolia o print do comprovante
  assert.match(zapi, /if \(!messageText && temImagem\) \{/);
  assert.match(zapi, /if \(modoMidia !== 'oferta'\) return;/);
  assert.match(zapi, /body\.image\?\.caption/);
});

test('cada toque da régua tem instrução própria, e o D+7 encerra', () => {
  assert.match(ai, /INSTRUCAO_POR_TOQUE = \{/);
  const t = ai.slice(ai.indexOf('const INSTRUCAO_POR_TOQUE'), ai.indexOf('export async function generateOfertaMessage'));
  assert.match(t, /1: `Ela nao respondeu[^]*NAO repita a oferta/);
  assert.match(t, /3: `Ela segue sem responder[^]*ANGULO NOVO/);
  assert.match(t, /7: `Ultimo contato[^]*ENCERRE[^]*nao deixe gancho/);
});

test('a primeira resposta da lead para a régua antes de qualquer outra coisa', () => {
  const fn = handler.slice(handler.indexOf('export async function conduzirOferta'));
  const posParar = fn.indexOf('pararReguaOferta');
  const posGerar = fn.indexOf('generateOfertaReply');
  assert.ok(posParar > 0 && posParar < posGerar, 'parar a régua vem antes de gerar resposta');
});

test('desfecho definido vai para a mesma tabela da Karina, como agente', () => {
  assert.match(handler, /r\.desfecho !== 'em_andamento'/);
  assert.match(handler, /registrarDesfechoOferta/);
  const client = ler('src/hub/client.js');
  assert.match(client, /oferta-desfecho/);
});

test('JSON inválido vira handoff, não mensagem solta', () => {
  const fn = ai.slice(ai.indexOf('export async function generateOfertaReply'));
  assert.match(fn, /catch \{[^]*handoff: true, handoff_motivo: 'outro'/);
});

test('venda declarada também sai do automático', () => {
  const fn = ai.slice(ai.indexOf('export async function generateOfertaReply'));
  assert.match(fn, /desfecho === 'fechou'/);
});

test('o prompt proíbe orientação de saúde, urgência falsa e insistência', () => {
  assert.match(prompt, /Não dá qualquer orientação sobre alimentação/);
  assert.match(prompt, /Nunca invente escassez, prazo, desconto/);
  assert.match(prompt, /Não insiste com quem disse não/);
  assert.match(prompt, /Não promete resultado/);
  // sofrimento é handoff imediato
  assert.match(prompt, /sinal de sofrimento[^]*Imediato/i);
});

test('oferta intercepta antes da máquina do SDR', () => {
  const i = zapi.indexOf("if (mode === 'oferta')");
  assert.ok(i > 0);
  assert.ok(i < zapi.indexOf('generateReply(phone'));
});

test('o D+0 reenvia a jornada atualizada, não um link cru de checkout', () => {
  const t = ai.slice(ai.indexOf('const INSTRUCAO_POR_TOQUE'), ai.indexOf('export async function generateOfertaMessage'));
  assert.match(t, /jornada DELA foi atualizada agora[^]*REENVIE o link da jornada/);
  const ctx = ai.slice(ai.indexOf('function contextoOferta'), ai.indexOf('const INSTRUCAO_POR_TOQUE'));
  assert.match(ctx, /JA ATUALIZADA com o acompanhamento indicado/);
  // o link cru só entra se não houver jornada
  assert.match(ctx, /!d\.jornada_url && d\.oferta_url/);
});

test('a confirmação manda a jornada junto — é ela que faz a lead aparecer', () => {
  const fn = ai.slice(ai.indexOf('export async function generateConfirmacaoMessage'), ai.indexOf('export async function generateConfirmacaoReply'));
  assert.match(fn, /jornadaUrl/);
  assert.match(fn, /Mande TAMBEM o link da jornada/);
  const h = ler('src/confirmacao/handler.js');
  assert.match(h, /jornada_url: jornadaUrl/);
});
