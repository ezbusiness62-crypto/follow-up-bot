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

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const LEADS_FILE = path.join(__dirname, 'leads.json');
if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, '[]');

function readLeads() { try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch(e) { return []; } }
function writeLeads(leads) { fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2)); }

function buildMessages(n) {
  var now = Date.now(), DAY = 86400000;
  return [
    { id: uuidv4(), day: 1, scheduledAt: now+DAY, sentAt: null, status: 'pending', body: 'Hey '+n+', this is '+AGENT_NAME+' from '+AGENCY_NAME+'. Still looking for homes in '+AREA+'?' },
    { id: uuidv4(), day: 3, scheduledAt: now+3*DAY, sentAt: null, status: 'pending', body: 'Hey '+n+', just checking in. I have some new listings. Want me to send them over?' },
    { id: uuidv4(), day: 7, scheduledAt: now+7*DAY, sentAt: null, status: 'pending', body: 'Hey '+n+', last follow up from me. No pressure at all.' }
  ];
}

async function sendText(to, body) {
  var msg = await twilioClient.messages.create({ body: body, from: process.env.TWILIO_PHONE_NUMBER, to: to });
  return msg.sid;
}

cron.schedule('0 * * * *', async function() {
  var leads = readLeads(), now = Date.now(), changed = false;
  for (var i=0; i<leads.length; i++) {
    if (leads[i].optedOut) continue;
    for (var j=0; j<leads[i].messages.length; j++) {
      var msg = leads[i].messages[j];
      if (msg.status !== 'pending' || msg.scheduledAt > now) continue;
      try { msg.twilioSid = await sendText(leads[i].phone, msg.body); msg.status='sent'; msg.sentAt=now; }
      catch(e) { msg.status='failed'; msg.error=e.message; }
      changed = true;
    }
  }
  if (changed) writeLeads(leads);
});

app.post('/api/leads', function(req,res) {
  var name=req.body.name, phone=req.body.phone;
  if (!name||!phone) return res.status(400).json({error:'name and phone required'});
  var p = phone.startsWith('+') ? phone : '+1'+phone.replace(/\D/g,'');
  var leads = readLeads();
  if (leads.find(function(l){return l.phone===p;})) return res.status(409).json({error:'Lead exists'});
  var lead = {id:uuidv4(),name:name,phone:p,createdAt:Date.now(),optedOut:false,messages:buildMessages(name)};
  leads.push(lead); writeLeads(leads); res.status(201).json(lead);
});

app.get('/api/leads', function(req,res) { res.json(readLeads()); });

app.delete('/api/leads/:id', function(req,res) {
  var leads=readLeads(), idx=leads.findIndex(function(l){return l.id===req.params.id;});
  if (idx===-1) return res.status(404).json({error:'not found'});
  leads[idx].optedOut=true;
  leads[idx].messages.forEach(function(m){if(m.status==='pending')m.status='cancelled';});
  writeLeads(leads); res.json({ok:true});
});

app.post('/api/leads/:id/resend/:mid', async function(req,res) {
  var leads=readLeads();
  var lead=leads.find(function(l){return l.id===req.params.id;});
  var msg=lead&&lead.messages.find(function(m){return m.id===req.params.mid;});
  if (!lead||!msg) return res.status(404).json({error:'not found'});
  try { msg.twilioSid=await sendText(lead.phone,msg.body); msg.status='sent'; msg.sentAt=Date.now(); writeLeads(leads); res.json({ok:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/stats', function(req,res) {
  var leads=readLeads(), msgs=leads.reduce(function(a,l){return a.concat(l.messages);},[]);
  res.json({total:leads.length,active:leads.filter(function(l){return !l.optedOut;}).length,sent:msgs.filter(function(m){return m.status==='sent';}).length,pending:msgs.filter(function(m){return m.status==='pending';}).length});
});

app.use(express.static(path.join(__dirname,'public')));
app.get('*', function(req,res) { res.sendFile(path.join(__dirname,'public','index.html')); });

app.listen(PORT, function() { console.log('Running on port '+PORT); });