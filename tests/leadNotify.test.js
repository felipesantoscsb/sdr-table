import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const handler = readFileSync(join(import.meta.dirname, '../src/webhook/makeHandler.js'), 'utf8');

// O lead entra, o SDR responde activated:true e SÓ DEPOIS processa. Se o
// processamento quebra, o lead existe e ninguém sabe. Estes testes travam a
// ordem que garante o aviso.

test('o aviso ao time vem antes do envio para a lead', () => {
  const corpo = handler.slice(
    handler.indexOf('async function finishLeadFirstContact'),
    handler.indexOf('async function notifyLeadFalhou'),
  );
  assert.ok(corpo.length > 200, 'função não encontrada');
  const posNotify = corpo.indexOf('notifySDR(');
  const posEnvio = corpo.indexOf('sendMessage(phone');
  assert.ok(posNotify > -1 && posEnvio > -1, 'chamadas não encontradas');
  assert.ok(
    posNotify < posEnvio,
    'notifySDR precisa vir ANTES de sendMessage: número inválido não pode matar o aviso',
  );
});

test('falha no aviso não derruba o primeiro contato', () => {
  // notifySDR isolado com .catch — o aviso é importante, mas não pode
  // impedir que a lead receba a mensagem.
  assert.match(handler, /await notifySDR\(leadData, result\.sdrBriefing\)\.catch\(/);
});

test('o catch avisa em vez de engolir', () => {
  const catchBlock = handler.slice(handler.indexOf('❌ Erro ao processar lead'));
  assert.match(catchBlock.slice(0, 300), /notifyLeadFalhou\(leadData, phone, err, briefing\)/);
});

test('o aviso de falha nunca lança, porque roda dentro de um catch', () => {
  const fn = handler.slice(
    handler.indexOf('async function notifyLeadFalhou'),
    handler.indexOf('async function notifyLeadFalhou') + 1200,
  );
  assert.match(fn, /try \{/);
  assert.match(fn, /catch \(e2\)/);
});

test('o aviso de falha aponta o número suspeito', () => {
  assert.match(handler, /digits\.length < 12 \|\| digits\.length > 13/);
  assert.match(handler, /provavelmente digitado errado no formulário/);
});

test('o briefing sobrevive ao erro para ir junto do aviso', () => {
  // briefing é declarado fora do try: se a quebra for no envio, o aviso ainda
  // leva o contexto que a IA já tinha gerado.
  const corpo = handler.slice(handler.indexOf('async function finishLeadFirstContact'));
  assert.match(corpo.slice(0, 400), /let briefing = null;[\s\S]*try \{/);
});
