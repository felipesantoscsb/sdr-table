// Comandos do inbound, compartilhados pelos DOIS webhooks.
//
// Em 16/10/2026 o Felipe mandou /retomar e não aconteceu nada: os comandos só
// existiam no webhook do número da Karina, e ele mandou para o número do
// inbound — que tratou o texto como mensagem de lead e disparou um handoff.
//
// Agora funciona dos dois lados. Duplicar o parser nos dois handlers seria
// garantir que divergissem na primeira mudança, então mora aqui.

import { normalizePhone } from '../conversation/store.js';
import { assumirInbound, retomarInbound } from './handler.js';
import { config } from '../../config/index.js';

// Número do Felipe, FIXO. Era lido de NUMERO_BACKUP e em 16/10/2026 isso
// custou caro: a variável não estava no Railway, o /retomar dele não foi
// reconhecido como comando, e o texto virou conversa de lead com handoff.
//
// Variável de ambiente ausente falha em SILÊNCIO — o número simplesmente
// deixa de ser equipe e vira lead. Já foi assim com a URL do sdr-table e com
// a do recovery. Fixar aqui troca flexibilidade que ninguém usa por uma classe
// inteira de falha muda.
const NUMERO_FELIPE = '5511918253788';

/**
 * Números que podem comandar. Mesma lista que o sender blinda contra bloqueio
 * e para quem manda todo handoff, red flag e erro.
 */
export function ehNumeroDaEquipe(phone) {
  const alvo = normalizePhone(String(phone || ''));
  if (!alvo) return false;
  return [config.sdr.phone, NUMERO_FELIPE, process.env.NUMERO_BACKUP]
    .filter(Boolean)
    .some(p => normalizePhone(String(p)) === alvo);
}

export function numerosDaEquipe() {
  return [config.sdr.phone, NUMERO_FELIPE, process.env.NUMERO_BACKUP]
    .filter(Boolean).map(p => normalizePhone(String(p)));
}

function parseAlvo(resto) {
  const [alvoRaw, ...ctx] = String(resto || '').split('|');
  return { alvo: normalizePhone((alvoRaw || '').trim()), contexto: ctx.join('|').trim() };
}

const MOTIVOS = {
  desligado:    'o inbound está desligado no código',
  bloqueado:    'esse número está bloqueado (/unstop para liberar)',
  ja_paciente:  'já tem vínculo definitivo no Hub — atenda na mão',
  erro_geracao: 'a IA não gerou a mensagem; tente de novo',
};

/**
 * Trata /agente e /retomar. Devolve null quando o texto não é um desses —
 * aí quem chamou segue o fluxo normal dele.
 */
export async function tratarComandoInbound(texto, responder = null) {
  const t = String(texto || '').trim();
  const lower = t.toLowerCase();
  // Aviso imediato. Entre o comando e a confirmação passam de 20 a 55s (check
  // do Hub + geração + delay de digitação), e silêncio nesse intervalo faz
  // quem comandou achar que falhou e rodar de novo — que mandaria DUAS
  // aberturas para a mesma lead.
  const avisar = async (txt) => { if (responder) await responder(txt).catch(() => {}); };

  if (lower.startsWith('/retomar')) {
    const { alvo, contexto } = parseAlvo(t.slice(8));
    if (!alvo) {
      return 'Uso: /retomar 5511999999999\nMelhor ainda, com o que ela mandou:\n/retomar 5511999999999 | oi';
    }
    await avisar(`⏳ Retomando ${alvo}... a mensagem sai em até 1 minuto (delay de digitação). Não rode de novo.`);
    const r = await retomarInbound({ phone: alvo, mensagemDela: contexto });
    return r.ok
      ? `✅ *Retomada enviada para ${alvo}*\n\n💬 "${r.mensagemEnviada}"\n\nA conversa está com o agente. Ele qualifica e te chama quando tiver turno e dias.`
      : `⚠️ Não retomei ${alvo}: ${MOTIVOS[r.motivo] || r.motivo}.`;
  }

  if (lower.startsWith('/agente')) {
    const { alvo, contexto } = parseAlvo(t.slice(7));
    if (!alvo) {
      return 'Uso: /agente 5511999999999\nOu, para o agente saber o que você já disse:\n/agente 5511999999999 | texto que você mandou';
    }
    const r = await assumirInbound({ phone: alvo, contexto });
    if (!r.ok) return `⚠️ Não assumi ${alvo}: ${MOTIVOS[r.motivo] || r.motivo}.`;
    const d = r.diagnostico || {};
    return [
      `🤝 *Agente assumiu ${alvo}*`,
      ``,
      `${d.modoGravado ? '✅' : '❌'} Conversa gravada em modo inbound`,
      `${d.envioConfigurado ? '✅' : '❌'} Instância de envio configurada${d.envioConfigurado ? '' : ` (falta: ${(d.variaveisFaltando || []).join(', ')})`}`,
      `${d.contextoNoHistorico ? '✅' : '⚠️'} ${d.contextoNoHistorico ? 'Sua mensagem está no histórico dele' : 'Sem contexto: ele pode repetir sua pergunta'}`,
      ``,
      d.modoGravado && d.envioConfigurado
        ? `Ele NÃO manda nada agora. Na próxima mensagem dela, responde sem se reapresentar.`
        : `⚠️ Algo acima falhou: ele NÃO vai responder. Siga na mão.`,
    ].join('\n');
  }

  return null;
}
