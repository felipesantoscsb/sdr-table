import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { diagnosticoInbound } from '../src/inbound/diagnostico.js';

const fonte = readFileSync(new URL('../src/inbound/diagnostico.js', import.meta.url), 'utf8');

test('o diagnostico nao vaza telefone nem texto por padrao', async () => {
  // Sem Redis alcancavel o scan devolve vazio; o que importa aqui e o
  // contrato: amostras so saem quando pedidas, e nunca com telefone inteiro.
  const r = await diagnosticoInbound({});
  assert.deepEqual(r.amostras, [], 'amostra tem de ser opt-in');
  assert.ok('chaves_conv' in r, 'precisa distinguir Redis mudo de zero conversas');
});

test('o teto de amostras e aplicado no handler, nao no chamador', async () => {
  assert.match(fonte, /Math\.min\(Number\(req\.body\?\.amostras\) \|\| 0, 20\)/);
  assert.match(fonte, /x-webhook-secret/);
  assert.match(fonte, /return res\.status\(401\)/);
});

test('o telefone sai sempre mascarado', async () => {
  assert.match(fonte, /function mascarar/);
  assert.match(fonte, /telefone: mascarar\(/);
  // leadData carrega nome e telefone cru: nao pode entrar na amostra.
  assert.doesNotMatch(fonte, /leadData[^\n]*amostras|amostras[^\n]*leadData/);
});

test('o funil mede degraus em ordem, para achar o que derruba', async () => {
  for (const degrau of ['iniciou', 'respondeu', 'qualificou', 'recebeu_oferta', 'deu_disponibilidade', 'handoff']) {
    assert.ok(fonte.includes(degrau), `degrau ${degrau} ausente`);
  }
  assert.match(fonte, /r\.queda\[/, 'a queda entre degraus e o que responde a pergunta');
});
