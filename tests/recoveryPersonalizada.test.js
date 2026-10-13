import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ai = readFileSync(join(root, 'src/ai/anthropic.js'), 'utf8');
const handler = readFileSync(join(root, 'src/webhook/checkoutRecoveryHandler.js'), 'utf8');

const gerar = ai.slice(
  ai.indexOf('export async function generateRecoveryMessage'),
  ai.indexOf('export async function generateReactivationMessage'),
);

test('a mensagem usa as respostas do quiz — é isso que a separa de um template', () => {
  assert.match(gerar, /respostas/);
  assert.match(gerar, /O que ela respondeu no quiz/);
  assert.match(handler, /respostas = lead\?\.respostas \|\| null/);
  assert.match(handler, /generateRecoveryMessage\(\{ \.\.\.p, perfil, respostas \}\)/);
});

test('sem respostas o agente não inventa história', () => {
  assert.match(gerar, /não passou pelo quiz[^]*sem inventar nada sobre a história dela/);
});

test('o prompt proíbe transformar as respostas em relatório ou conselho', () => {
  assert.match(gerar, /Não liste\s*\n?as respostas/);
  assert.match(gerar, /não diagnostique e não dê conselho sobre\s*\n?alimentação/);
});

test('as respostas são lidas localmente, não trafegam entre serviços', () => {
  // dado sensível de saúde: o quizHandler já guardou aqui, por telefone
  assert.match(handler, /getLeadData\(p\.phone\)/);
  assert.match(handler, /aquisicao-table não as manda/);
});

test('corte de tamanho no contexto do quiz', () => {
  // resposta longa não pode estourar o prompt nem virar paredão
  assert.match(gerar, /contexto\.slice\(0, 1200\)/);
});
