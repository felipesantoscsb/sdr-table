// src/index.js

import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { handleMakeLead } from './webhook/makeHandler.js';
import { handleQuizLead } from './webhook/quizHandler.js';
import { handleZapiMessage, processQueue } from './webhook/zapiHandler.js';
import { handleQuizPre } from './webhook/quizPreHandler.js';
import { handleDisparo, fireDossie } from './disparos/handler.js';
import { handleTrack } from './webhook/trackHandler.js';
import { handleTicto } from './webhook/tictoHandler.js';
import { getPhonesWithQueue } from './conversation/store.js';
import { startFollowUpJob, fireFollowUp } from './followup.js';
import { safeKeys, safeGet } from './redis.js';
const redisGet = safeGet; // alias para clareza no recovery

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// Fotos da equipe
app.use('/fotos', express.static(join(__dirname, '../public/fotos')));

// Propostas e dossiês servidos na raiz (mesmo domínio jornada.tableclinic.com.br)
app.use('/', express.static(join(__dirname, '../public/planos')));

// Webhooks
app.post('/webhook/lead', handleMakeLead);
app.post('/webhook/quiz', handleQuizLead);
app.post('/webhook/zapi', handleZapiMessage);
app.post('/webhook/quiz-pre', handleQuizPre);
app.post('/webhook/disparo', handleDisparo);
app.post('/webhook/ticto', handleTicto);

// Track link (follow-up)
app.get('/track/:uuid', handleTrack);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) + 's' });
});

// ─── Recovery de timers após redeploy ────────────────────────────────────────

async function recoverPendingTimers() {
  const now = Date.now();
  let dossiesRecovered = 0;
  let followupsRecovered = 0;

  // ── Dossiês pendentes ──────────────────────────────────────────────────────
  const dossieKeys = await safeKeys('pending_dossie:*');
  for (const key of dossieKeys) {
    const raw = await safeGet(key);
    if (!raw) continue;
    let pending;
    try { pending = JSON.parse(raw); } catch { continue; }

    const { phone, leadData, fire_at } = pending;
    if (!phone || !leadData) continue;

    const remaining = fire_at - now;
    const delay = remaining > 0 ? remaining : 0;

    if (remaining <= 0) {
      console.log(`⚡ [recovery] Dossiê para ${leadData.nome} (${phone}) — atrasado ${Math.round(-remaining / 60000)}min, disparando agora`);
    } else {
      console.log(`⏳ [recovery] Dossiê para ${leadData.nome} (${phone}) — reagendado em ${Math.round(delay / 60000)}min`);
    }

    setTimeout(() => fireDossie(leadData), delay);
    dossiesRecovered++;
  }

  // ── Follow-ups pendentes ───────────────────────────────────────────────────
  const followupKeys = await safeKeys('pending_followup:*');
  for (const key of followupKeys) {
    const raw = await safeGet(key);
    if (!raw) continue;
    let pending;
    try { pending = JSON.parse(raw); } catch { continue; }

    const { phone, leadData, fire_at } = pending;
    if (!phone || !leadData) continue;

    // Se já enviou o follow-up, ignora
    const jaEnviou = await redisGet(`followup:${phone}`);
    if (jaEnviou) continue;

    // Se já comprou, ignora
    const comprou = await redisGet(`compra:${phone}`);
    if (comprou) continue;

    const remaining = fire_at - now;

    if (remaining <= 0) {
      console.log(`⚡ [recovery] Follow-up para ${leadData.nome} (${phone}) — atrasado, disparando agora`);
      setTimeout(() => fireFollowUp(leadData, phone), 0);
    } else {
      console.log(`⏳ [recovery] Follow-up para ${leadData.nome} (${phone}) — reagendado em ${Math.round(remaining / 60000)}min`);
      setTimeout(() => fireFollowUp(leadData, phone), remaining);
    }
    followupsRecovered++;
  }

  if (dossiesRecovered + followupsRecovered > 0) {
    console.log(`✅ [recovery] ${dossiesRecovered} dossiê(s) e ${followupsRecovered} follow-up(s) recuperados`);
  } else {
    console.log('✅ [recovery] Nenhum timer pendente encontrado');
  }
}

app.listen(config.port, () => {
  console.log(`
🚀 SDR WhatsApp rodando na porta ${config.port}

Endpoints:
  POST /webhook/lead     → Recebe leads do Make (formulário)
  POST /webhook/quiz     → Recebe leads do quiz (aquisicao-table)
  POST /webhook/zapi     → Recebe mensagens da Zapi
  POST /webhook/quiz-pre → Armazena dados do quiz
  POST /webhook/disparo  → Dispara dossiê personalizado
  POST /webhook/ticto    → Webhook de compras da Ticto
  GET  /track/:uuid      → Link de rastreio do follow-up
  GET  /health           → Status do servidor
  GET  /:file            → Propostas e dossiês gerados
  GET  /fotos/:file      → Fotos da equipe
  `);

  startFollowUpJob();
  recoverPendingTimers().catch(err => console.error('❌ Erro na recovery de timers:', err.message));

  setInterval(async () => {
    const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const hora = brasilia.getHours();
    const minuto = brasilia.getMinutes();
    if (hora === 8 && minuto === 0) {
      const phones = await getPhonesWithQueue();
      for (const phone of phones) {
        await processQueue(phone);
      }
    }
  }, 60 * 1000);
});
