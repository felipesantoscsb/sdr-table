import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { humanizarPontuacao, parseGeneratedReply } from '../src/ai/replyResult.js';

// A regra "NUNCA use travessao" existia no prompt do inbound E em
// anthropic.js, e travessao continuou chegando na lead. Instrucao negativa
// nao segura formatacao. Agora e deterministico, no unico ponto por onde
// toda mensagem passa.
test('travessao vira virgula', () => {
  assert.equal(humanizarPontuacao('Entendi — isso é comum.'), 'Entendi, isso é comum.');
  assert.equal(humanizarPontuacao('Pesa muito—no fim do dia.'), 'Pesa muito, no fim do dia.');
  assert.equal(humanizarPontuacao('Olha – faz sentido.'), 'Olha, faz sentido.');
});

test('hifen solto como pontuacao vira virgula', () => {
  assert.equal(humanizarPontuacao('É gratuita - e sem compromisso.'), 'É gratuita, e sem compromisso.');
});

test('hifen dentro da palavra fica intacto', () => {
  for (const palavra of ['pré-consulta', 'Segunda-feira', 'bem-estar', 'low-carb']) {
    assert.ok(humanizarPontuacao(`Sobre ${palavra} hoje?`).includes(palavra), palavra);
  }
});

test('marcador de lista some', () => {
  assert.equal(humanizarPontuacao('- manhã\n- tarde'), 'manhã\ntarde');
  assert.equal(humanizarPontuacao('• manhã'), 'manhã');
});

test('texto limpo nao e alterado', () => {
  const limpo = 'Você consegue de manhã, tarde ou noite?';
  assert.equal(humanizarPontuacao(limpo), limpo);
});

test('a limpeza acontece na saida do modelo, nao so na funcao', () => {
  const r = parseGeneratedReply(JSON.stringify({
    leadMessage: 'Entendi — a Karina te chama. A pré-consulta é gratuita - sem compromisso.',
  }));
  assert.equal(r.leadMessage, 'Entendi, a Karina te chama. A pré-consulta é gratuita, sem compromisso.');
  assert.ok(!/[—–]/.test(r.leadMessage));
});

test('o prompt do inbound abre por nome e dor, sem citar a origem', () => {
  const prompt = readFileSync(new URL('../config/prompts/inbound.txt', import.meta.url), 'utf8');
  assert.match(prompt, /Nome e dor, nessa ordem, na mesma mensagem/);
  assert.match(prompt, /NÃO diga de onde ela veio/);
  assert.doesNotMatch(prompt, /Reconheça de onde ela veio/);
});

test('a qualificacao fecha em tres mensagens e saude virou bonus', () => {
  const prompt = readFileSync(new URL('../config/prompts/inbound.txt', import.meta.url), 'utf8');
  assert.match(prompt, /ofereça a pré-consulta na sua TERCEIRA mensagem/);
  assert.match(prompt, /CONDIÇÃO DE SAÚDE \(campo `saude`, lista\) — BÔNUS, NÃO PERGUNTE/);
  assert.doesNotMatch(prompt, /a qualificação precisa fechar em até 5 mensagens/);
  // `completa` passou a depender so de dor_texto: era ela que segurava o
  // handoff esperando campos que nao decidiam nada.
  assert.match(prompt, /`completa` vira true com `dor_texto` preenchido/);
});
