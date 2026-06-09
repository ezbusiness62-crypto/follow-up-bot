require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const LEADS_FILE = path.join(__dirname, 'data', 'leads.json');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.use(express.json());
app.use(express.static('public'));

// ── Data helpers ──────────────────────────────────────────────────────────────

function readLeads() {
  try {
    return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function buildMessages(lead) {
  const { name, agentName, agency, area, submittedAt } = lead;
  const base = new Date(submittedAt);

  const at = (days) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    // Send at 10 AM on that day (use UTC noon so most US time zones hit morning)
    d.setUTCHours(16, 0, 0, 0);
    return d.toISOString();
  };

  return [
    {
      id: 1,
      day: 1,
      scheduledAt: at(1),
      sentAt: null,
      status: 'pending',
      body: `Hey ${name}, this is ${agentName} from ${agency}. Just wanted to make sure you got everything you needed. Still looking for homes in ${area}? I'd love to help.`,
    },
    {
      id: 2,
      day: 3,
      scheduledAt: at(3),
      sentAt: null,
      status: 'pending',
      body: `Hey ${name}, just checking in. I have some new listings that might be a great fit for you. Want me to send them over?`,
    },
    {
      id: 3,
      day: 7,
      scheduledAt: at(7),
      sentAt: null,
      status: 'pending',
      body: `Hey ${name}, last follow up from me. If you're still in the market I'm here to help. No pressure at all.`,
    },
  ];
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Add a new lead
app.post('/api/leads', (req, res) => {
  const { name, phone, agentName, agency, area } = req.body;

  if (!name || !phone || !agentName || !agency || !area) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const leads = readLeads();

  const lead = {
    id: Date.now().toString(),
    name,
    phone,
    agentName,
    agency,
    area,
    submittedAt: new Date().toISOString(),
    messages: [],
  };

  lead.messages = buildMessages(lead);
  leads.push(lead);
  writeLeads(leads);

  res.status(201).json({ success: true, lead });
});

// Get all leads
app.get('/api/leads', (req, res) => {
  res.json(readLeads());
});

// Delete a lead
app.delete('/api/leads/:id', (req, res) => {
  let leads = readLeads();
  leads = leads.filter((l) => l.id !== req.params.id);
  writeLeads(leads);
  res.json({ success: true });
});

// Manually trigger the send check (useful for testing)
app.post('/api/send-due', async (req, res) => {
  const results = await processDueMessages();
  res.json({ sent: results });
});

// ── SMS sender ────────────────────────────────────────────────────────────────

async function processDueMessages() {
  const leads = readLeads();
  const now = new Date();
  const sent = [];

  for (const lead of leads) {
    for (const msg of lead.messages) {
      if (msg.status !== 'pending') continue;
      if (new Date(msg.scheduledAt) > now) continue;

      try {
        await twilioClient.messages.create({
          body: msg.body,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: lead.phone,
        });

        msg.status = 'sent';
        msg.sentAt = new Date().toISOString();
        sent.push({ leadId: lead.id, leadName: lead.name, messageDay: msg.day });
        console.log(`[SMS sent] ${lead.name} (Day ${msg.day})`);
      } catch (err) {
        msg.status = 'failed';
        msg.error = err.message;
        console.error(`[SMS failed] ${lead.name} (Day ${msg.day}): ${err.message}`);
      }
    }
  }

  writeLeads(leads);
  return sent;
}

// ── Cron job: runs every hour ─────────────────────────────────────────────────

cron.schedule('0 * * * *', async () => {
  console.log(`[Cron] Checking for due messages at ${new Date().toISOString()}`);
  await processDueMessages();
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Cron job will check for due messages every hour.`);
});
