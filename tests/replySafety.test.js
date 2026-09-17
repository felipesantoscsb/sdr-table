import test from 'node:test';
import assert from 'node:assert/strict';

import {
  anthropicText,
  manualReviewFallback,
  parseGeneratedReply,
  sanitizeConversationHistory,
} from '../src/ai/replyResult.js';

test('extrai todos os blocos de texto da resposta da Anthropic', () => {
  const text = anthropicText({ content: [
    { type: 'text', text: '{"leadMessage":' },
    { type: 'text', text: '"Oi"}' },
  ] });
  assert.equal(text, '{"leadMessage":\n"Oi"}');
});

test('aceita e normaliza uma resposta válida', () => {
  const result = parseGeneratedReply('```json\n{"leadMessage":"  Oi!  ","handoff":false}\n```');
  assert.equal(result.leadMessage, 'Oi!');
  assert.equal(result.handoff, false);
  assert.equal(result.redflag, false);
});

test('rejeita JSON sem leadMessage ou com mensagem vazia', () => {
  assert.throws(() => parseGeneratedReply('{"handoff":false}'), /leadMessage/);
  assert.throws(() => parseGeneratedReply('{"leadMessage":"   "}'), /leadMessage/);
});

test('permite mensagem vazia somente quando redflag interrompe o envio', () => {
  const result = parseGeneratedReply('{"redflag":true,"redflagMotivo":"crise"}');
  assert.equal(result.leadMessage, '');
  assert.equal(result.redflag, true);
});

test('remove entradas vazias ou corrompidas do histórico', () => {
  const history = sanitizeConversationHistory([
    { role: 'user', content: ' Oi ' },
    { role: 'assistant' },
    { role: 'assistant', content: '   ' },
    { role: 'system', content: 'ignorar' },
  ]);
  assert.deepEqual(history, [{ role: 'user', content: 'Oi' }]);
});

test('fallback de revisão manual nunca envia mensagem vazia', () => {
  const result = manualReviewFallback('sdr');
  assert.ok(result.leadMessage.length > 0);
  assert.equal(result.needsManualReview, true);
});

test('sender bloqueia mensagem vazia antes de chamar a Z-API e preserva detalhe do provedor', async () => {
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.ZAPI_INSTANCE_ID = 'test';
  process.env.ZAPI_TOKEN = 'test';
  process.env.ZAPI_CLIENT_TOKEN = 'test';
  process.env.SDR_PHONE = '5511000000000';
  process.env.WEBHOOK_SECRET = 'test';

  const { getSendErrorDetail, sendMessage } = await import('../src/zapi/sender.js');
  await assert.rejects(
    sendMessage('5511999999999', '   ', { skipDelay: true }),
    /Mensagem vazia bloqueada/
  );
  assert.equal(
    getSendErrorDetail({ response: { data: { error: "The field 'message' is empty" } } }),
    "The field 'message' is empty"
  );
});
