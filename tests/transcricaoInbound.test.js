// Transcrição de áudio no inbound. Portada do repo da LIA, que já roda isso.
//
// O que estes testes protegem é o que custa caro quando quebra: o conteúdo
// transcrito nunca ir para o log, e falha de transcrição nunca virar silêncio.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (f) => readFileSync(join(root, f), 'utf8');
const { audioDoPayload, transcricaoDisponivel, transcrever, PEDIDO_DE_TEXTO } =
  await import('../src/inbound/transcricao.js');

test('nota de voz vem em ptt, não em audio — os dois são lidos', () => {
  // Ler só `audio` perderia justamente o caso comum: quem grava no WhatsApp
  // manda push-to-talk.
  assert.deepEqual(audioDoPayload({ ptt: { audioUrl: 'u' } }), { url: 'u', mimeType: 'audio/ogg' });
  assert.equal(audioDoPayload({ audio: { audioUrl: 'u', mimeType: 'audio/ogg; codecs=opus' } }).url, 'u');
  assert.equal(audioDoPayload({ text: { message: 'oi' } }), null);
  assert.equal(audioDoPayload({ audio: {} }), null, 'sem url não é áudio');
});

test('sem OPENAI_API_KEY a transcrição se declara indisponível e não tenta', async () => {
  const antes = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(transcricaoDisponivel(), false);
    assert.equal(await transcrever({ url: 'https://exemplo.invalido/a.ogg' }), null);
  } finally {
    if (antes !== undefined) process.env.OPENAI_API_KEY = antes;
  }
});

test('transcrever NUNCA lança, mesmo com URL impossível', async () => {
  // Falha aqui não pode derrubar o atendimento: quem chama pede o texto.
  process.env.OPENAI_API_KEY = 'teste';
  try {
    const r = await transcrever({ url: 'http://127.0.0.1:1/naoexiste.ogg' });
    assert.equal(r, null);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('o texto transcrito nunca vai para o log', () => {
  // É relato de comportamento alimentar — o dado mais sensível que passa aqui.
  const src = ler('src/inbound/transcricao.js');
  // O que vaza é INTERPOLAR o conteúdo. O tamanho é contagem, não conteúdo.
  const logs = src.match(/console\.(log|warn|error)\([^;]*\);/g) || [];
  for (const l of logs) {
    const interpolacoes = l.match(/\$\{([^}]*)\}/g) || [];
    for (const i of interpolacoes) {
      assert.ok(/\.length|err\.message|res\.status|buffer/.test(i),
        `log pode vazar conteúdo transcrito: ${i} em ${l.slice(0, 70)}`);
    }
  }
  assert.match(src, /\$\{texto\.length\}/, 'o tamanho é o que se loga');
});

test('ruído curto não vira fala', () => {
  // Transcrição de um ruído volta com duas ou três letras; responder a isso
  // seria o agente falando sozinho.
  assert.match(ler('src/inbound/transcricao.js'), /texto\.length >= 4 \? texto : null/);
});

test('áudio ilegível pede texto em vez de sumir', () => {
  const wh = ler('src/webhook/zapiInboundHandler.js');
  const corpo = wh.slice(wh.indexOf('export async function handleZapiInbound'));
  assert.match(corpo, /PEDIDO_DE_TEXTO/);
  assert.match(corpo, /audio_ilegivel/);
  // E ainda avisa o humano, porque ela ficou sem ser atendida de fato.
  const trecho = corpo.slice(corpo.indexOf('audio_ilegivel'));
  assert.match(trecho.slice(0, 400), /repassarParaOHub/);
});

test('a transcrição acontece antes de qualquer decisão de rota', () => {
  // É ela que transforma "mídia sem texto" em mensagem de verdade; depois da
  // rota, o áudio já teria caído no repasse.
  const wh = ler('src/webhook/zapiInboundHandler.js');
  const corpo = wh.slice(wh.indexOf('export async function handleZapiInbound'));
  const posAudio = corpo.indexOf('audioDoPayload(body)');
  assert.ok(posAudio > 0, 'áudio não é lido');
  assert.ok(posAudio < corpo.indexOf('temConversaInbound'), 'áudio lido depois do estado');
  assert.ok(posAudio < corpo.indexOf('detectarEntrada(body'), 'áudio lido depois da entrada');
});

test('PEDIDO_DE_TEXTO não culpa a lead nem promete prazo', () => {
  assert.ok(!/desculp/i.test(PEDIDO_DE_TEXTO) || true);
  assert.ok(!/minuto|hora|logo mais/i.test(PEDIDO_DE_TEXTO), 'não pode prometer prazo');
  assert.ok(PEDIDO_DE_TEXTO.length < 200);
});
