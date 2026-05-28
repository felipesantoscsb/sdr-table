// src/index.js

import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { handleMakeLead } from './webhook/makeHandler.js';
import { handleZapiMessage, processQueue } from './webhook/zapiHandler.js';
import { handleQuizPre } from './webhook/quizPreHandler.js';
import { getPhonesWithQueue } from './conversation/store.js';
import { startFollowUpJob } from './followup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// Arquivos estáticos
app.use('/fotos', express.static(join(__dirname, '../public/fotos')));
app.use('/', express.static(join(__dirname, '../public/planos')));

// Webhooks
app.post('/webhook/lead', handleMakeLead);
app.post('/webhook/zapi', handleZapiMessage);
app.post('/webhook/quiz-pre', handleQuizPre);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) + 's' });
});

app.listen(config.port, () => {
  console.log(`
🚀 SDR WhatsApp rodando na porta ${config.port}

Endpoints:
  POST /webhook/lead     → Recebe leads do Make (formulário)
  POST /webhook/zapi     → Recebe mensagens da Zapi
  POST /webhook/quiz-pre → Armazena dados do quiz (Make)
  GET  /health           → Status do servidor
  GET  /:file            → Propostas geradas
  GET  /fotos/:file      → Fotos da equipe
  `);

  startFollowUpJob();

  // Processa fila às 8h
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
