require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AGENT_NAME = process.env.AGENT_NAME || 'Your Agent';
const AGENCY_NAME = process.env.AGENCY_NAME || 'Our Agency';
const AREA = process.env.AREA || 'your area';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const LEADS_FILE = path.join(__dirname, 'leads.json');
if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, '[]');

function readLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
  catch (e) { return []; }
}

function writeLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

function buildMessages(leadName) {
  var now = Date.now();
  var DAY = 24 * 60 * 60 * 1000;
  return [
    {
      id: uuidv4(), day: 1,
      scheduledAt: now + 1 * DAY, sentAt: null, status: 'pending',
      body: 'Hey ' + leadName + ', this is ' + AGENT_NAME + ' from ' + AGENCY_NAME + '. Just wanted to make sure you got everything you needed. Still looking for homes in ' + AREA + '? I\'d love to help.'
    },
    {
      id: uuidv4(), day: 3,
      scheduledAt: now + 3 * DAY, sentAt: null, status: 'pending',
      body: 'Hey ' + leadName + ', just checking in. I have some new listings that might be a great fit for you. Want me to send them over?'
    },
    {
      id: uuidv4(), day: 7,
      scheduledAt: now + 7 * DAY, sentAt: null, status: 'pending',
      body: 'Hey ' + leadName + ', last follow up from me. If you\'re still in the market I\'m here to help. No pressure at all.'
    }
  ];
}

async function sendText(to, body) {
  var msg = await twilioClient.messages.create({
    body: body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: to
  });
  return msg.sid;
}

async function processDueMessages() {
  var leads = readLeads();
  var now = Date.now();
  var changed = false;
  for (var i = 0; i < leads.length; i++) {
    var lead = leads[i];
    if (lead.optedOut) continue;
    for (var j = 0; j < lead.messages.length; j++) {
      var msg = lead.messages[j];
      if (msg.status !== 'pending' || msg.scheduledAt > now) continue;
      try {
        var sid = await sendText(lead.phone, msg.body);
        msg.status = 'sent';
        msg.sentAt = now;
        msg.twilioSid = sid;
        console.log('[SENT] ' + lead.name + ' day-' + msg.day);
      } catch (err) {
        msg.status = 'failed';
        msg.error = err.message;
        console.error('[FAIL] ' + lead.name + ' day-' + msg.day + ': ' + err.message);
      }
      changed = true;
    }
  }
  if (changed) writeLeads(leads);
}

cron.schedule('0 * * * *', function() {
  console.log('[CRON] Checking for due messages...');
  processDueMessages();
});

app.post('/api/leads', function(req, res) {
  var name = req.body.name;
  var phone = req.body.phone;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
  var normalized = phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, '');
  var leads = readLeads();
  if (leads.find(function(l) { return l.phone === normalized; }))
    return res.status(409).json({ error: 'Lead with this phone number already exists' });
  var lead = {
    id: uuidv4(), name: name, phone: normalized,
    createdAt: Date.now(), optedOut: false,
    messages: buildMessages(name)
  };
  leads.push(lead);
  writeLeads(leads);
  res.status(201).json(lead);
});

app.get('/api/leads', function(req, res) {
  res.json(readLeads());
});

app.delete('/api/leads/:id', function(req, res) {
  var leads = readLeads();
  var idx = leads.findIndex(function(l) { return l.id === req.params.id; });
  if (idx === -1) return res.status(404).json({ error: 'Lead not found' });
  leads[idx].optedOut = true;
  leads[idx].messages.forEach(function(m) { if (m.status === 'pending') m.status = 'cancelled'; });
  writeLeads(leads);
  res.json({ ok: true });
});

app.post('/api/leads/:id/resend/:msgId', async function(req, res) {
  var leads = readLeads();
  var lead = leads.find(function(l) { return l.id === req.params.id; });
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  var msg = lead.messages.find(function(m) { return m.id === req.params.msgId; });
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  try {
    var sid = await sendText(lead.phone, msg.body);
    msg.status = 'sent'; msg.sentAt = Date.now(); msg.twilioSid = sid;
    writeLeads(leads);
    res.json({ ok: true, sid: sid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', function(req, res) {
  var leads = readLeads();
  var allMsgs = leads.reduce(function(acc, l) { return acc.concat(l.messages); }, []);
  res.json({
    total: leads.length,
    active: leads.filter(function(l) { return !l.optedOut; }).length,
    sent: allMsgs.filter(function(m) { return m.status === 'sent'; }).length,
    pending: allMsgs.filter(function(m) { return m.status === 'pending'; }).length
  });
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, function() {
  console.log('Real Estate Follow-Up Bot running on port ' + PORT);
  console.log('Agent: ' + AGENT_NAME + ' | Agency: ' + AGENCY_NAME + ' | Area: ' + AREA);
});
