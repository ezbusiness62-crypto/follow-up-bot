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

function readLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
  catch (e) { return []; }
}
function writeLeads(leads) { fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2)); }

function buildMessages(leadName) {
  var now = Date.now();
  var DAY = 24 * 60 * 60 * 1000;
  return [
    { id: uuidv4(), day: 1, scheduledAt: now + 1*DAY, sentAt: null, status: 'pending', body: 'Hey ' + leadName + ', this is ' + AGENT_NAME + ' from ' + AGENCY_NAME + '. Just wanted to make sure you got everything you needed. Still looking for homes in ' + AREA + '? I\'d love to help.' },
    { id: uuidv4(), day: 3, scheduledAt: now + 3*DAY, sentAt: null, status: 'pending', body: 'Hey ' + leadName + ', just checking in. I have some new listings that might be a great fit for you. Want me to send them over?' },
    { id: uuidv4(), day: 7, scheduledAt: now + 7*DAY, sentAt: null, status: 'pending', body: 'Hey ' + leadName + ', last follow up from me. If you\'re still in the market I\'m here to help. No pressure at all.' }
  ];
}

async function sendText(to, body) {
  var msg = await twilioClient.messages.create({ body: body, from: process.env.TWILIO_PHONE_NUMBER, to: to });
  return msg.sid;
}

async function processDueMessages() {
  var leads = readLeads(); var now = Date.now(); var changed = false;
  for (var i = 0; i < leads.length; i++) {
    var lead = leads[i]; if (lead.optedOut) continue;
    for (var j = 0; j < lead.messages.length; j++) {
      var msg = lead.messages[j];
      if (msg.status !== 'pending' || msg.scheduledAt > now) continue;
      try { var sid = await sendText(lead.phone, msg.body); msg.status = 'sent'; msg.sentAt = now; msg.twilioSid = sid; console.log('[SENT] ' + lead.name); }
      catch (err) { msg.status = 'failed'; msg.error = err.message; console.error('[FAIL] ' + err.message); }
      changed = true;
    }
  }
  if (changed) writeLeads(leads);
}

cron.schedule('0 * * * *', function() { processDueMessages(); });

app.post('/api/leads', function(req, res) {
  var name = req.body.name; var phone = req.body.phone;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
  var normalized = phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, '');
  var leads = readLeads();
  if (leads.find(function(l) { return l.phone === normalized; })) return res.status(409).json({ error: 'Lead already exists' });
  var lead = { id: uuidv4(), name: name, phone: normalized, createdAt: Date.now(), optedOut: false, messages: buildMessages(name) };
  leads.push(lead); writeLeads(leads); res.status(201).json(lead);
});

app.get('/api/leads', function(req, res) { res.json(readLeads()); });

app.delete('/api/leads/:id', function(req, res) {
  var leads = readLeads(); var idx = leads.findIndex(function(l) { return l.id === req.params.id; });
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  leads[idx].optedOut = true;
  leads[idx].messages.forEach(function(m) { if (m.status === 'pending') m.status = 'cancelled'; });
  writeLeads(leads); res.json({ ok: true });
});

app.post('/api/leads/:id/resend/:msgId', async function(req, res) {
  var leads = readLeads();
  var lead = leads.find(function(l) { return l.id === req.params.id; });
  if (!lead) return res.status(404).json({ error: 'Not found' });
  var msg = lead.messages.find(function(m) { return m.id === req.params.msgId; });
  if (!msg) return res.status(404).json({ error: 'Not found' });
  try { var sid = await sendText(lead.phone, msg.body); msg.status = 'sent'; msg.sentAt = Date.now(); msg.twilioSid = sid; writeLeads(leads); res.json({ ok: true, sid: sid }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', function(req, res) {
  var leads = readLeads();
  var allMsgs = leads.reduce(function(acc, l) { return acc.concat(l.messages); }, []);
  res.json({ total: leads.length, active: leads.filter(function(l) { return !l.optedOut; }).length, sent: allMsgs.filter(function(m) { return m.status === 'sent'; }).length, pending: allMsgs.filter(function(m) { return m.status === 'pending'; }).length });
});

app.get('*', function(req, res) {
  res.send(['<!DOCTYPE html>','<html lang="en">','<head>','<meta charset="UTF-8">','<meta name="viewport" content="width=device-width,initial-scale=1">','<title>RE Follow-Up</title>','<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">','<style>','*{box-sizing:border-box;margin:0;padding:0}','body{font-family:"DM Sans",sans-serif;background:#F1F5FB;color:#0F172A}','header{background:linear-gradient(135deg,#0A1F5C,#1A4FBF);color:#fff;padding:0 32px;height:64px;display:flex;align-items:center;justify-content:space-between}','.logo{font-size:18px;font-weight:700}','.stats{background:#fff;border-bottom:1px solid #CBD5E1;display:flex;padding:0 32px}','.stat{padding:16px 28px 16px 0;border-right:1px solid #CBD5E1;margin-right:28px}','.stat:last-child{border-right:none}','.stat-val{font-size:26px;font-weight:700;color:#1A4FBF}','.stat-lbl{font-size:12px;color:#64748B;text-transform:uppercase;letter-spacing:.5px}','main{display:grid;grid-template-columns:360px 1fr;gap:24px;padding:28px 32px}','.card{background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(10,31,92,.1);overflow:hidden;margin-bottom:20px}','.card-head{padding:18px 22px;border-bottom:1px solid #CBD5E1;font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}','.dot{width:8px;height:8px;border-radius:50%;background:#1A4FBF;display:inline-block}','.form-body{padding:22px;display:flex;flex-direction:column;gap:16px}','label{font-size:13px;font-weight:500;color:#64748B;display:block;margin-bottom:5px}','input{width:100%;padding:10px 14px;border:1.5px solid #CBD5E1;border-radius:8px;font-family:inherit;font-size:14px;outline:none}','input:focus{border-color:#1A4FBF}','.btn-primary{background:#1A4FBF;color:#fff;border:none;border-radius:8px;padding:11px;width:100%;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}','.btn-sm{padding:5px 12px;font-size:12px;border-radius:6px;border:none;cursor:pointer;font-family:inherit;font-weight:600}','.btn-danger{background:#FEE2E2;color:#DC2626}','.btn-send{background:#DCFCE7;color:#16A34A}','.btn-refresh{background:#EFF4FF;color:#1A4FBF}','.toast{display:none;padding:10px 14px;border-radius:8px;font-size:13px;font-weight:500;margin-top:4px}','.toast.ok{background:#DCFCE7;color:#16A34A;display:block}','.toast.err{background:#FEE2E2;color:#DC2626;display:block}','.sched{padding:0 22px 22px}','.sched-row{display:flex;gap:12px;padding:14px 0;border-bottom:1px dashed #CBD5E1;align-items:flex-start}','.sched-row:last-child{border-bottom:none}','.day-badge{min-width:52px;padding:3px 0;text-align:center;background:#EFF4FF;color:#1A4FBF;font-size:11px;font-weight:700;border-radius:6px}','.prev-txt{font-size:12.5px;color:#64748B;line-height:1.5}','.leads-list{display:flex;flex-direction:column}','.lead-row{border-bottom:1px solid #CBD5E1;padding:18px 22px}','.lead-row:last-child{border-bottom:none}','.lead-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}','.lead-name{font-size:15px;font-weight:600}','.lead-phone{font-size:12.5px;color:#64748B}','.lead-date{font-size:11px;color:#94A3B8;margin-top:2px}','.opted-out .lead-name{text-decoration:line-through;color:#94A3B8}','.msgs{display:flex;flex-direction:column;gap:6px}','.msg-row{display:flex;align-items:center;gap:10px;background:#F8FAFD;border-radius:8px;padding:8px 12px;font-size:12.5px}','.pill{padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600}','.pill-pending{background:#FEF3C7;color:#D97706}','.pill-sent{background:#DCFCE7;color:#16A34A}','.pill-failed{background:#FEE2E2;color:#DC2626}','.pill-cancelled{background:#F1F5F9;color:#94A3B8}','.msg-day{font-weight:600;color:#1A4FBF;min-width:44px}','.msg-sched{color:#64748B;flex:1}','.msg-act{margin-left:auto}','.empty{padding:60px 22px;text-align:center;color:#64748B;font-size:14px}','.search-wrap{padding:14px 22px;border-bottom:1px solid #CBD5E1}','.card-head-right{display:flex;align-items:center;justify-content:space-between;width:100%}','@media(max-width:900px){main{grid-template-columns:1fr}}','</style>','</head>','<body>','<header>','<div class="logo">RE Follow-Up</div>','<div style="font-size:13px;opacity:.75">Automated Text Sequences</div>','</header>','<div class="stats">','<div class="stat"><div class="stat-val" id="s1">-</div><div class="stat-lbl">Total Leads</div></div>','<div class="stat"><div class="stat-val" id="s2">-</div><div class="stat-lbl">Active</div></div>','<div class="stat"><div class="stat-val" id="s3">-</div><div class="stat-lbl">Texts Sent</div></div>','<div class="stat"><div class="stat-val" id="s4">-</div><div class="stat-lbl">Pending</div></div>','</div>','<main>','<div>','<div class="card">','<div class="card-head"><span class="dot"></span> Add New Lead</div>','<div class="form-body">','<div><label>Lead Name</label><input type="text" id="iName" placeholder="e.g. Sarah Johnson"></div>','<div><label>Phone Number</label><input type="tel" id="iPhone" placeholder="e.g. 5125550001"></div>','<div id="toast" class="toast"></div>','<button class="btn-primary" id="addBtn">Add Lead and Schedule Texts</button>','</div></div>','<div class="card">','<div class="card-head"><span class="dot"></span> Follow-Up Schedule</div>','<div class="sched">','<div class="sched-row"><div class="day-badge">Day 1</div><div class="prev-txt">Hey [name], this is [agent] from [agency]. Still looking for homes in [area]?</div></div>','<div class="sched-row"><div class="day-badge">Day 3</div><div class="prev-txt">Hey [name], just checking in. New listings that might be a great fit.</div></div>','<div class="sched-row"><div class="day-badge">Day 7</div><div class="prev-txt">Hey [name], last follow up. No pressure at all.</div></div>','</div></div>','</div>','<div class="card" style="align-self:start">','<div class="card-head"><div class="card-head-right"><div style="display:flex;align-items:center;gap:8px"><span class="dot"></span> Active Leads</div><button class="btn-sm btn-refresh" id="refBtn">Refresh</button></div></div>','<div class="search-wrap"><input type="text" id="search" placeholder="Search by name or phone..."></div>','<div class="leads-list" id="leads"></div>','</div>','</main>','<script>','var all=[];','function fmt(ts){return new Date(ts).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});}','function pc(s){return{pending:"pill-pending",sent:"pill-sent",failed:"pill-failed",cancelled:"pill-cancelled"}[s]||"pill-pending";}','function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}','function loadStats(){fetch("/api/stats").then(function(r){return r.json();}).then(function(s){document.getElementById("s1").textContent=s.total;document.getElementById("s2").textContent=s.active;document.getElementById("s3").textContent=s.sent;document.getElementById("s4").textContent=s.pending;}).catch(function(){});}','function loadLeads(){fetch("/api/leads").then(function(r){return r.json();}).then(function(d){all=d.sort(function(a,b){return b.createdAt-a.createdAt;});render(all);loadStats();}).catch(function(){});}','document.getElementById("search").addEventListener("input",function(){var q=this.value.toLowerCase();render(all.filter(function(l){return l.name.toLowerCase().indexOf(q)>-1||l.phone.indexOf(q)>-1;}));});','function render(leads){var el=document.getElementById("leads");if(!leads.length){el.innerHTML="<div class=\'empty\'>No leads yet. Add one to get started.</div>";return;}el.innerHTML=leads.map(function(l){return "<div class=\'lead-row"+(l.optedOut?" opted-out":"")+"\'><div class=\'lead-top\'><div><div class=\'lead-name\'>"+esc(l.name)+"</div><div class=\'lead-phone\'>"+esc(l.phone)+"</div><div class=\'lead-date\'>Added "+fmt(l.createdAt)+(l.optedOut?" - Opted out":"")+"</div></div><div>"+(!l.optedOut?"<button class=\'btn-sm btn-danger\' onclick=\'optOut(\""+l.id+"\")\'>Opt Out</button>":"")+"</div></div><div class=\'msgs\'>"+l.messages.map(function(m){return "<div class=\'msg-row\'><span class=\'msg-day\'>Day "+m.day+"</span><span class=\'msg-sched\'>"+(m.status==="sent"?"Sent "+fmt(m.sentAt):m.status==="cancelled"?"Cancelled":"Due "+fmt(m.scheduledAt))+"</span><span class=\'pill "+pc(m.status)+"\'>"+m.status+"</span><span class=\'msg-act\'>"+((m.status==="pending"||m.status==="failed")&&!l.optedOut?"<button class=\'btn-sm btn-send\' onclick=\'resend(\""+l.id+"\",\""+m.id+"\")\'>Send now</button>":"")+"</span></div>";}).join("")+"</div></div>";}).join("");}','document.getElementById("addBtn").addEventListener("click",function(){var name=document.getElementById("iName").value.trim();var phone=document.getElementById("iPhone").value.trim();var toast=document.getElementById("toast");toast.className="toast";if(!name||!phone){toast.textContent="Please enter both name and phone.";toast.className="toast err";return;}fetch("/api/leads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name,phone:phone})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});}).then(function(res){if(!res.ok){toast.textContent=res.d.error||"Error";toast.className="toast err";return;}toast.textContent="Lead added! 3 texts scheduled for "+name+".";toast.className="toast ok";document.getElementById("iName").value="";document.getElementById("iPhone").value="";loadLeads();}).catch(function(){toast.textContent="Network error.";toast.className="toast err";});});','document.getElementById("refBtn").addEventListener("click",loadLeads);','function optOut(id){if(!confirm("Opt out and cancel all pending texts?"))return;fetch("/api/leads/"+id,{method:"DELETE"}).then(function(){loadLeads();});}','function resend(lid,mid){fetch("/api/leads/"+lid+"/resend/"+mid,{method:"POST"}).then(function(r){return r.json();}).then(function(d){if(d.ok)loadLeads();else alert("Failed: "+d.error);});}','loadLeads();','setInterval(loadLeads,60000);','<\/script>','</body>','</html>'].join('\n'));
});

app.listen(PORT, function() { console.log('Server running on port ' + PORT); });