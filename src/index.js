// src/index.js

import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { handleMakeLead } from './webhook/makeHandler.js';
import { handleZapiMessage, processQueue } from './webhook/zapiHandler.js';
import { getPhonesWithQueue } from './conversation/store.js';
import { startFollowUpJob } from './followup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// Fotos da equipe
app.use('/fotos', express.static(join(__dirname, '../public/fotos')));

// Propostas servidas na raiz do domínio
app.use('/', express.static(join(__dirname, '../public/planos')));

// Webhooks
app.post('/webhook/lead', handleMakeLead);
app.post('/webhook/zapi', handleZapiMessage);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) + 's' });
});

app.listen(config.port, () => {
  console.log(`
🚀 SDR WhatsApp rodando na porta ${config.port}

Endpoints:
  POST /webhook/lead  → Recebe leads do Make
  POST /webhook/zapi  → Recebe mensagens da Zapi
  GET  /health        → Status do servidor
  GET  /:file         → Propostas geradas
  GET  /fotos/:file   → Fotos da equipe
  `);

  startFollowUpJob();

  setInterval(async () => {
    const hora = new Date().getHours();
    const dia = new Date().getDay();
    const fimDeSemana = dia === 0 || dia === 6;
    const abriu = fimDeSemana ? hora === 8 : hora === 8;

    if (abriu) {
      const phones = await getPhonesWithQueue();
      for (const phone of phones) {
        await processQueue(phone);
      }
    }
  }, 60 * 1000);
});
