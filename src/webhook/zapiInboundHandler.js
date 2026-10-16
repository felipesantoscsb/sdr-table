// Webhook da SEGUNDA instância Z-API (a da satisfação).
//
// ATENÇÃO AO DIVISOR DE TRÁFEGO. Uma instância Z-API tem UM webhook de entrada
// só, e esta rota passou a ser esse webhook em 16/10/2026. Antes dela, a
// entrada da instância estava apontada para a LIA (/api/whatsapp/webhook);
// decisão do Felipe de virar o apontamento para cá.
//
// Três tipos de tráfego chegam aqui, e misturá-los seria o pior resultado
// possível (paciente virando lead de captação, agente de vendas respondendo
// quem só quis agradecer):
//   - lead nova de anúncio ou story            → o agente conduz
//   - resposta de pesquisa de satisfação       → repassa para o Hub
//   - resposta do lembrete do formulário do PR → repassa para o Hub
// Mais o resíduo de quem ainda escrever para a LIA nesse número: sem frase de
// entrada, cai no repasse e chega a uma pessoa em vez de sumir.
//
// A divisão é:
//   1. tem conversa de inbound viva? → agente conduz
//   2. é a frase de entrada do anúncio/story? → agente abre conversa
//   3. qualquer outra coisa → REPASSA para o Hub (/webhook/zapi/ops), a rota
//      que já existe para "resposta no número operacional" e avisa a Karina
//
// O passo 3 não é cosmético: sem ele, apontar esta instância para cá deixaria
// toda resposta de pesquisa em silêncio. O destino é o Hub porque é lá que o
// atendimento humano desse tráfego já está escrito — não porque ele já
// recebesse esta instância antes (não recebia: era a LIA).

import axios from 'axios';
import {
  normalizePhone, isBlocked, isHandedOff, temConversaInbound,
  getHistory, enqueueMessage, dequeueMessages,
} from '../conversation/store.js';
import { aggregate } from '../conversation/aggregator.js';
import { detectarEntrada } from '../inbound/entry.js';
import { iniciarInbound, conduzirInbound, inboundAtivo } from '../inbound/handler.js';

const HUB_OPS_URL = process.env.ZAPI_INBOUND_FALLBACK_URL
  || 'https://crm.tableclinic.com.br/webhook/zapi/ops';
// O Hub só confere o segredo se ele estiver configurado lá. Se estiver, o
// mesmo valor precisa existir aqui, senão o repasse é descartado em silêncio
// do outro lado e a resposta de pesquisa não chega a ninguém.
const HUB_OPS_SECRET = process.env.ZAPI_OPS_WEBHOOK_SECRET || '';

// Click-to-WhatsApp sem a frase: aceita abrir conversa só pelo bloco de
// referral do Meta. Se a Z-API passar a mandar esse bloco em toda mensagem,
// desligar aqui evita que resposta de pesquisa vire lead.
const ACEITA_REFERRAL = process.env.INBOUND_ACEITA_REFERRAL !== 'false';

function dentroDoHorario() {
  const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = brasilia.getDay();
  const hora = brasilia.getHours();
  if (dia === 0 || dia === 6) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

/** Repassa ao Hub o que não é conversa do inbound. Nunca lança. */
async function repassarParaOHub(body) {
  try {
    await axios.post(HUB_OPS_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        ...(HUB_OPS_SECRET ? { 'x-webhook-secret': HUB_OPS_SECRET } : {}),
      },
      timeout: 10_000,
    });
    console.log('[zapi-inbound] mensagem repassada para o Hub');
  } catch (err) {
    console.error(`[zapi-inbound] repasse para o Hub falhou: ${err.message}`);
  }
}

export async function handleZapiInbound(req, res) {
  res.status(200).json({ ok: true });

  try {
    const body = req.body || {};
    if (body.type && body.type !== 'ReceivedCallback') return;
    if (body.isFromMe) return;

    const phone = normalizePhone(body.phone || body.from || body.sender || '');
    if (!phone) return;

    // REAÇÃO NÃO É MENSAGEM. Um joinha acordou o agente e gerou mensagem
    // espontânea para uma lead em 14/10/2026. Aqui a guarda nasce junto com o
    // fluxo, antes de qualquer leitura de estado, e vale para tudo.
    const ehReacao = !!(body.reaction || body.reactionMessage || body.messageReaction)
      || String(body.type || '').toLowerCase().includes('reaction')
      || String(body.messageType || '').toLowerCase().includes('reaction');
    if (ehReacao) {
      console.log(`[zapi-inbound] reação ignorada de ${phone}`);
      return;
    }

    const texto = body.text?.message || (typeof body.text === 'string' ? body.text : null)
      || body.image?.caption || null;

    // Bloqueio permanente vence tudo, inclusive o repasse: quem pediu para não
    // receber não vira notificação nem lead.
    if (await isBlocked(phone)) {
      console.log(`⛔ [zapi-inbound] ignorado de ${phone} (bloqueado)`);
      return;
    }

    const jaTemConversa = await temConversaInbound(phone);

    // ── 1. Conversa de inbound viva ──────────────────────────────────────────
    if (jaTemConversa) {
      if (await isHandedOff(phone)) {
        // Handoff feito: a Karina assumiu. O agente não fala mais, e o Hub
        // avisa para ela não perder a mensagem.
        console.log(`[zapi-inbound] ${phone} em handoff — repassando para o Hub`);
        await repassarParaOHub(body);
        return;
      }

      if (!texto) {
        // Áudio, figurinha, foto sem legenda. O agente não comenta imagem de
        // corpo, exame ou receita, e não transcreve áudio: quem resolve isso é
        // uma pessoa.
        console.log(`[zapi-inbound] mídia sem texto de ${phone} — repassando para o Hub`);
        await repassarParaOHub(body);
        return;
      }

      if (!dentroDoHorario()) {
        console.log(`⏰ [zapi-inbound] fora do horário — enfileirando ${phone}`);
        await enqueueMessage(phone, texto);
        return;
      }

      aggregate(phone, texto, processarInbound, `inbound:${phone}`);
      return;
    }

    // ── 2. Entrada nova pela frase do anúncio / story ────────────────────────
    const entrada = detectarEntrada(body, texto || '');
    const entradaValida = entrada.match && (!entrada.viaReferral || ACEITA_REFERRAL);

    if (entradaValida) {
      if (!inboundAtivo()) {
        console.log(`[zapi-inbound] inbound desligado — repassando ${phone} para o Hub`);
        await repassarParaOHub(body);
        return;
      }
      console.log(`🎯 [zapi-inbound] entrada detectada de ${phone} (origem ${entrada.origem}${entrada.viaReferral ? ', via referral' : ''})`);
      await iniciarInbound({
        phone, origem: entrada.origem, ctwa: entrada.ctwa,
        mensagemOriginal: texto || '',
      });
      return;
    }

    // ── 3. Todo o resto: pesquisa, lembrete do PR, número desconhecido ───────
    console.log(`[zapi-inbound] sem conversa e sem frase de entrada (${phone}) — repassando para o Hub`);
    await repassarParaOHub(body);

  } catch (err) {
    console.error('❌ [zapi-inbound] erro no handler:', err.message);
  }
}

async function processarInbound(phone, combinada) {
  try {
    const history = await getHistory(phone);
    await conduzirInbound({ phone, mensagem: combinada, history });
  } catch (err) {
    console.error(`❌ [zapi-inbound] erro ao conduzir ${phone}:`, err.message);
  }
}

/** Fila da madrugada: processada junto com a do fluxo principal, às 8h. */
export async function processarFilaInbound(phone) {
  const messages = await dequeueMessages(phone);
  if (!messages.length) return;
  console.log(`📬 [zapi-inbound] fila de ${phone}: ${messages.length} mensagem(ns)`);
  await processarInbound(phone, messages.join('\n'));
}
