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
        console.error('[FAIL] ' + lead.name + ': ' + err.message);
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
    return res.status(409).json({ error: 'Lead already exists' });
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
  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RE Follow-Up</title><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet"><style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--navy:#0A1F5C;--blue:#1A4FBF;--pale:#EFF4FF;--border:#CBD5E1;--text:#0F172A;--muted:#64748B;--white:#FFFFFF;--green:#16A34A;--amber:#D97706;--red:#DC2626;--grey:#94A3B8;--radius:10px;--shadow:0 2px 12px rgba(10,31,92,.10)}body{font-family:"DM Sans",sans-serif;background:#F1F5FB;color:var(--text);min-height:100vh}header{background:linear-gradient(135deg,var(--navy) 0%,var(--blue) 100%);color:#fff;padding:0 32px;display:flex;align-items:center;justify-content:space-between;height:64px;box-shadow:0 2px 16px rgba(10,31,92,.3)}.logo{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:700}.stats-bar{background:#fff;border-bottom:1px solid var(--border);display:flex;padding:0 32px}.stat{padding:16px 28px 16px 0;display:flex;flex-direction:column;gap:2px;border-right:1px solid var(--border);margin-right:28px}.stat:last-child{border-right:none}.stat-value{font-size:26px;font-weight:700;color:var(--blue)}.stat-label{font-size:12px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}main{display:grid;grid-template-columns:360px 1fr;gap:24px;padding:28px 32px;max-width:1400px}.card{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}.card-header{padding:18px 22px;border-bottom:1px solid var(--border);font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}.dot{width:8px;height:8px;border-radius:50%;background:var(--blue)}.form-body{padding:22px;display:flex;flex-direction:column;gap:16px}label{font-size:13px;font-weight:500;color:var(--muted);display:block;margin-bottom:5px}input{width:100%;padding:10px 14px;border:1.5px solid var(--border);border-radius:8px;font-family:inherit;font-size:14px;color:var(--text);outline:none}input:focus{border-color:var(--blue)}.btn{padding:11px 20px;border:none;border-radius:8px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}.btn-primary{background:var(--blue);color:#fff;width:100%}.btn-primary:hover{opacity:.9}.btn-sm{padding:5px 12px;font-size:12px;border-radius:6px}.btn-danger{background:#FEE2E2;color:var(--red)}.btn-send{background:#DCFCE7;color:var(--green)}.toast{display:none;padding:10px 14px;border-radius:8px;font-size:13px;font-weight:500}.toast.success{background:#DCFCE7;color:var(--green);display:block}.toast.error{background:#FEE2E2;color:var(--red);display:block}.schedule-preview{padding:0 22px 22px;display:flex;flex-direction:column}.schedule-item{display:flex;align-items:flex-start;gap:12px;padding:14px 0;border-bottom:1px dashed var(--border)}.schedule-item:last-child{border-bottom:none}.day-badge{min-width:52px;padding:3px 0;text-align:center;background:var(--pale);color:var(--blue);font-size:11px;font-weight:700;border-radius:6px}.preview-text{font-size:12.5px;color:var(--muted);line-height:1.5}.leads-list{display:flex;flex-direction:column}.lead-row{border-bottom:1px solid var(--border);padding:18px 22px}.lead-row:last-child{border-bottom:none}.lead-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.lead-name{font-size:15px;font-weight:600}.lead-phone{font-size:12.5px;color:var(--muted)}.lead-date{font-size:11px;color:var(--grey);margin-top:2px}.opted-out .lead-name{text-decoration:line-through;color:var(--grey)}.messages-grid{display:flex;flex-direction:column;gap:6px}.msg-row{display:flex;align-items:center;gap:10px;background:#F8FAFD;border-radius:8px;padding:8px 12px;font-size:12.5px}.status-pill{padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600;white-space:nowrap}.pill-pending{background:#FEF3C7;color:var(--amber)}.pill-sent{background:#DCFCE7;color:var(--green)}.pill-failed{background:#FEE2E2;color:var(--red)}.pill-cancelled{background:#F1F5F9;color:var(--grey)}.msg-day{font-weight:600;color:var(--blue);min-width:44px}.msg-sched{color:var(--muted);flex:1}.msg-actions{margin-left:auto}.empty-state{padding:60px 22px;text-align:center;color:var(--muted);font-size:14px}.search-bar{padding:14px 22px;border-bottom:1px solid var(--border)}@media(max-width:900px){main{grid-template-columns:1fr}}</style></head><body><header><div class="logo"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>RE Follow-Up</div><div style="font-size:13px;opacity:.75">Automated Text Sequences</div></header><div class="stats-bar"><div class="stat"><div class="stat-value" id="statTotal">-</div><div class="stat-label">Total Leads</div></div><div class="stat"><div class="stat-value" id="statActive">-</div><div class="stat-label">Active</div></div><div class="stat"><div class="stat-value" id="statSent">-</div><div class="stat-label">Texts Sent</div></div><div class="stat"><div class="stat-value" id="statPending">-</div><div class="stat-label">Pending</div></div></div><main><div style="display:flex;flex-direction:column;gap:20px"><div class="card"><div class="card-header"><div class="dot"></div>Add New Lead</div><div class="form-body"><div><label>Lead Name</label><input type="text" id="inputName" placeholder="e.g. Sarah Johnson"/></div><div><label>Phone Number</label><input type="tel" id="inputPhone" placeholder="e.g. 5125550001"/></div><div id="formToast" class="toast"></div><button class="btn btn-primary" onclick="addLead()">Add Lead and Schedule Texts</button></div></div><div class="card"><div class="card-header"><div class="dot"></div>Follow-Up Schedule</div><div class="schedule-preview"><div class="schedule-item"><div class="day-badge">Day 1</div><div class="preview-text">Hey [name], this is [agent] from [agency]. Still looking for homes in [area]?</div></div><div class="schedule-item"><div class="day-badge">Day 3</div><div class="preview-text">Hey [name], just checking in. I have some new listings that might be a great fit.</div></div><div class="schedule-item"><div class="day-badge">Day 7</div><div class="preview-text">Hey [name], last follow up from me. No pressure at all.</div></div></div></div></div><div class="card" style="align-self:start"><div class="card-header" style="justify-content:space-between"><div style="display:flex;align-items:center;gap:8px"><div class="dot"></div>Active Leads</div><button class="btn btn-sm" style="background:var(--pale);color:var(--blue)" onclick="loadLeads()">Refresh</button></div><div class="search-bar"><input type="text" id="searchInput" placeholder="Search by name or phone..." oninput="filterLeads()"/></div><div class="leads-list" id="leadsList"></div></div></main><script>var allLeads=[];function fmtDate(ts){return new Date(ts).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}function pillClass(s){return{pending:"pill-pending",sent:"pill-sent",failed:"pill-failed",cancelled:"pill-cancelled"}[s]||"pill-pending"}function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}async function loadStats(){try{var s=await fetch("/api/stats").then(function(r){return r.json()});document.getElementById("statTotal").textContent=s.total;document.getElementById("statActive").textContent=s.active;document.getElementById("statSent").textContent=s.sent;document.getElementById("statPending").textContent=s.pending}catch(e){}}async function loadLeads(){try{allLeads=await fetch("/api/leads").then(function(r){return r.json()});allLeads.sort(function(a,b){return b.createdAt-a.createdAt});renderLeads(allLeads);await loadStats()}catch(e){}}function filterLeads(){var q=document.getElementById("searchInput").value.toLowerCase();renderLeads(allLeads.filter(function(l){return l.name.toLowerCase().includes(q)||l.phone.includes(q)}))}function renderLeads(leads){var el=document.getElementById("leadsList");if(!leads.length){el.innerHTML="<div class=\'empty-state\'>No leads yet. Add one to get started.</div>";return}el.innerHTML=leads.map(function(lead){return"<div class=\'lead-row"+(lead.optedOut?" opted-out":"")+"\'><div class=\'lead-top\'><div><div class=\'lead-name\'>"+esc(lead.name)+"</div><div class=\'lead-phone\'>"+esc(lead.phone)+"</div><div class=\'lead-date\'>Added "+fmtDate(lead.createdAt)+(lead.optedOut?" - Opted out":"")+"</div></div><div>"+(!lead.optedOut?"<button class=\'btn btn-sm btn-danger\' onclick=\'optOut(\""+lead.id+"\")\'>Opt Out</button>":"")+"</div></div><div class=\'messages-grid\'>"+lead.messages.map(function(msg){return"<div class=\'msg-row\'><span class=\'msg-day\'>Day "+msg.day+"</span><span class=\'msg-sched\'>"+(msg.status==="sent"?"Sent "+fmtDate(msg.sentAt):msg.status==="cancelled"?"Cancelled":"Due "+fmtDate(msg.scheduledAt))+"</span><span class=\'status-pill "+pillClass(msg.status)+"\'>"+msg.status+"</span><span class=\'msg-actions\'>"+(( msg.status==="pending"||msg.status==="failed")&&!lead.optedOut?"<button class=\'btn btn-sm btn-send\' onclick=\'resend(\""+lead.id+"\",\""+msg.id+"\")\'>Send now</button>":"")+"</span></div>"}).join("")+"</div></div>"}).join("")}async function addLead(){var name=document.getElementById("inputName").value.trim();var phone=document.getElementById("inputPhone").value.trim();var toast=document.getElementById("formToast");toast.className="toast";toast.textContent="";if(!name||!phone){toast.textContent="Please enter both name and phone.";toast.className="toast error";return}try{var r=await fetch("/api/leads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name,phone:phone})});var data=await r.json();if(!r.ok){toast.textContent=data.error||"Something went wrong.";toast.className="toast error";return}toast.textContent="Lead added! 3 texts scheduled for "+name+".";toast.className="toast success";document.getElementById("inputName").value="";document.getElementById("inputPhone").value="";await loadLeads()}catch(e){toast.textContent="Network error.";toast.className="toast error"}}async function optOut(id){if(!confirm("Opt this lead out?"))return;var r=await fetch("/api/leads/"+id,{method:"DELETE"});if(r.ok)await loadLeads()}async function resend(leadId,msgId){var r=await fetch("/api/leads/"+leadId+"/resend/"+msgId,{method:"POST"});var data=await r.json();if(r.ok)await loadLeads();else alert("Failed: "+data.error)}document.addEventListener("DOMContentLoaded",function(){loadLeads();["inputName","inputPhone"].forEach(function(id){document.getElementById(id).addEventListener("keydown",function(e){if(e.key==="Enter")addLead()})})});setInterval(loadLeads,60000);</script></body></html>';
  res.send(html);
});

app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
