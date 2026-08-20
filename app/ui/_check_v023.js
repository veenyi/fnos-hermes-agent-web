
"use strict";
/* ═══════════════════════════════════════════════════════════
   Hermes Agent Studio UI v0.23 — 重构版
   聊天室 / @Agent / 专家广场 / 模型切换 / 状态 / 设置
   API 层对齐 monitor（/api/*）+ WebSocket 流式聊天
   ═══════════════════════════════════════════════════════════ */

var BASE="";
var monitorToken="";
function resolveBase(){
  try{
    var b=document.querySelector("base");var href=(b&&b.getAttribute("href"))||document.baseURI||window.location.pathname;
    var p=String(href).split("?")[0].split("#")[0];
    if(/\/[^/]+\.[a-zA-Z0-9]+$/.test(p))p=p.replace(/\/[^/]+\.[a-zA-Z0-9]+$/,"");
    return p.replace(/\/$/,"")||"";
  }catch(e){return (window.location.pathname||"").replace(/\/$/,"")||"";}
}
function apiUrl(p){return BASE+p;}
function wsUrl(p){var pr=location.protocol==="https:"?"wss:":"ws:";return pr+"//"+location.host+apiUrl(p);}
function fetchToken(){
  return fetch(apiUrl("/api/health"),{cache:"no-store"}).then(function(r){return r.ok?r.json():null;}).then(function(d){
    if(d&&d.token){monitorToken=d.token;try{localStorage.setItem("hs-token",d.token);}catch(e){}}
    return d;
  }).catch(function(){return null;});
}
function api(path,method,body){
  method=method||"GET";
  var headers={"Content-Type":"application/json"};
  if(monitorToken)headers["X-Monitor-Token"]=monitorToken;
  var opts={method:method,headers:headers,cache:"no-store"};
  if(body)opts.body=JSON.stringify(body);
  return fetch(apiUrl(path),opts).then(function(r){
    return r.json().catch(function(){return {};}).then(function(j){
      if(!r.ok){var er=new Error(j.error||("HTTP "+r.status));er.status=r.status;er.payload=j;throw er;}
      return j;
    });
  });
}
function apiGet(path){return api(path,"GET").catch(function(e){return {ok:false,error:e.message};});}
function apiPost(path,body){return api(path,"POST",body).catch(function(e){return {ok:false,error:e.message};});}
function toast(msg,type){
  var d=document.createElement("div");d.className="toast "+(type||"");
  d.textContent=msg;document.getElementById("toasts").appendChild(d);
  setTimeout(function(){d.style.opacity="0";d.style.transition="opacity .3s";setTimeout(function(){d.remove();},350);},3200);
}
function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}

/* ── 导航 ── */
function goto(v){
  document.querySelectorAll(".nav-item").forEach(function(n){n.classList.toggle("active",n.getAttribute("data-v")===v);});
  $("chatView").classList.toggle("hidden",v!=="chat");
  $("expertsView").classList.toggle("hidden",v!=="experts");
  $("modelsView").classList.toggle("hidden",v!=="models");
  $("statusView").classList.toggle("hidden",v!=="status");
  $("settingsView").classList.toggle("hidden",v!=="settings");
  closeSide();
  if(v==="chat")renderSessions();
  if(v==="experts")renderExperts();
  if(v==="models")loadModels();
  if(v==="status")loadStatus();
}
function openSide(){$("side").classList.add("open");$("mask").classList.add("show");}
function closeSide(){$("side").classList.remove("open");$("mask").classList.remove("show");}

/* ── 会话管理 ── */
var sessions=[];var currentSession=null;var currentPersona=null;
function listSessions(){
  return apiGet("/api/sessions").then(function(r){
    if(r&&r.sessions)sessions=(r.sessions||[]).sort(function(a,b){return (b.updated_at||0)-(a.updated_at||0);});
    else sessions=[];
    renderSessions();
    if(!currentSession&&sessions.length)selectSession(sessions[0].id);
    return sessions;
  });
}
function newSession(opts){
  opts=opts||{};
  var payload={};
  if(opts.agent)payload.agent=opts.agent;
  if(opts.model)payload.model=opts.model;
  if(opts.workspace)payload.workspace=opts.workspace;
  return fetch(apiUrl("/api/sessions"),{method:"POST",headers:monitorToken?{"X-Monitor-Token":monitorToken,"Content-Type":"application/json"}:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
    .then(function(r){return r.json();}).then(function(s){
      s.model=payload.model||"";
      sessions.unshift(s);
      currentPersona=null;
      if(opts.persona){s.persona=opts.persona;}
      selectSession(s.id);
      renderSessions();
      return s;
    }).catch(function(e){toast("创建会话失败: "+e.message,"err");});
}
function selectSession(id){
  currentSession=id;
  renderSessions();
  var s=sessions.find(function(x){return x.id===id;});
  if(!s)return;
  $("chatTitle").textContent=s.title||"新对话";
  var p=(s.persona&&s.persona.label)?s.persona.label:null;
  if(p){$("chatPersona").textContent=(s.persona.emoji||"🧠")+" "+p;$("chatPersona").classList.remove("hidden");}
  else{$("chatPersona").classList.add("hidden");}
  var m=s.model||"";
  if(m){$("chatModelTag").textContent="模型: "+m;$("chatModelTag").classList.remove("hidden");}
  else{$("chatModelTag").classList.add("hidden");}
  $("modelCurName").textContent=m||"跟随默认";
  loadSessionMessages(id);
}
function renderSessions(){
  var box=$("sessionList");box.innerHTML="";
  if(!sessions.length){box.innerHTML='<div style="padding:20px;text-align:center;color:var(--txt3);font-size:12px">暂无会话<br>点击「新会话」开始</div>';return;}
  var now=Date.now();
  var order=["刚刚","今天","更早"];
  var groups={"刚刚":[],"今天":[],"更早":[]};
  sessions.forEach(function(s){
    var age=now-(s.updated_at||0);
    var g=age>=86400000?"更早":(age>=3600000?"今天":"刚刚");
    groups[g].push(s);
  });
  order.forEach(function(g){
    var list=groups[g];
    if(!list.length)return;
    var gd=document.createElement("div");gd.className="chat-group";gd.textContent=g;box.appendChild(gd);
    list.forEach(function(s){
      var it=document.createElement("div");it.className="chat-item"+(s.id===currentSession?" active":"");
      var persona=(s.persona&&s.persona.label)?(s.persona.emoji||"")+" "+s.persona.label:"";
      var dt=new Date(s.updated_at||s.created_at||Date.now());
      var tm=("0"+dt.getHours()).slice(-2)+":"+("0"+dt.getMinutes()).slice(-2);
      it.innerHTML='<div class="t1"><span class="nm">'+esc((s.title||"新对话")+(persona?" · "+persona:""))+'</span><span class="del" title="删除" onclick="event.stopPropagation();deleteSession(\''+s.id+'\')">✕</span></div>'+
        '<div class="t2"><span>'+tm+'</span>'+(s.model?'<span class="tag gray">'+esc(s.model)+'</span>':'')+'</div>';
      it.onclick=function(){selectSession(s.id);};
      box.appendChild(it);
    });
  });
}
function deleteSession(id){
  if(!confirm("删除该会话？"))return;
  fetch(apiUrl("/api/sessions/"+encodeURIComponent(id)),{method:"DELETE",headers:monitorToken?{"X-Monitor-Token":monitorToken}:{}})
    .then(function(){
      sessions=sessions.filter(function(s){return s.id!==id;});
      if(currentSession===id){currentSession=null;currentPersona=null;$("chatTitle").textContent="新对话";$("chatPersona").classList.add("hidden");$("chatModelTag").classList.add("hidden");$("msgWrap").innerHTML="";renderEmpty();}
      renderSessions();
      toast("已删除","ok");
    }).catch(function(e){toast("删除失败: "+e.message,"err");});
}
function clearSession(){
  if(!currentSession)return;
  if(!confirm("清空当前会话消息？"))return;
  var old=sessions.find(function(s){return s.id===currentSession;});
  fetch(apiUrl("/api/sessions/"+encodeURIComponent(currentSession)),{method:"DELETE",headers:monitorToken?{"X-Monitor-Token":monitorToken}:{}})
    .then(function(){
      newSession({model:old&&old.model?old.model:"",persona:old&&old.persona?old.persona:null});
      toast("已清空","ok");
    }).catch(function(e){toast("操作失败: "+e.message,"err");});
}
function loadSessionMessages(id){
  $("msgWrap").innerHTML="";
  fetch(apiUrl("/api/sessions/"+encodeURIComponent(id)),{cache:"no-store",headers:monitorToken?{"X-Monitor-Token":monitorToken}:{}})
    .then(function(r){return r.json();}).then(function(s){
      var msgs=(s&&s.messages)||[];
      if(!msgs.length){renderEmpty();return;}
      msgs.forEach(function(m){renderMsg(m.role||"user",m.content||"",{model:m.model});});
      scrollBottom();
    }).catch(function(){renderEmpty();});
}
function renderEmpty(){
  $("msgWrap").innerHTML='<div class="empty-chat"><div class="big">💬</div><div class="et">开始新的对话</div>'+
    '<div class="es">输入 @ 可唤起 268 位专家中的任意一位，或在「专家广场」挑选角色开始对话。模型按会话固定：在右上角选择模型后开启新会话，当前会话模型保持不变。</div></div>';
}

/* ── 消息渲染 ── */
function renderContent(text){
  if(!text)return "";
  try{return DOMPurify.sanitize(marked.parse(text),{ADD_ATTR:["target"]});}
  catch(e){return esc(text).replace(/\n/g,"<br>");}
}
function renderMsg(role,content,opts){
  opts=opts||{};
  var wrap=$("msgWrap");
  var empty=wrap.querySelector(".empty-chat");if(empty)empty.remove();
  var m=document.createElement("div");
  m.className="msg "+role;
  var av=(role==="user")?"你":(role==="error")?"!":"AI";
  var nm=(role==="user")?"你":(role==="assistant")?"Hermes":(role==="error")?"错误":"系统";
  var bodyHTML="";
  if(opts.reasoning&&opts.reasoning.trim()){
    bodyHTML+='<div class="reasoning"><div class="rt" onclick="var r=this.parentElement;r.classList.toggle(\'open\')">🧠 思考过程</div><div class="rc" style="display:none">'+esc(opts.reasoning)+'</div></div>';
  }
  if(typeof content==="string"&&content.trim())bodyHTML+=renderContent(content);
  m.innerHTML='<div class="avatar">'+av+'</div><div class="body"><div class="meta"><span class="role">'+nm+'</span>'+(opts.model?'<span class="tag gray">'+esc(opts.model)+'</span>':'')+'</div><div class="content">'+bodyHTML+'</div></div>';
  wrap.appendChild(m);
  return m;
}
function scrollBottom(){var a=$("msgArea");a.scrollTop=a.scrollHeight;}

/* ── 流式聊天（WS 主通道 + SSE 降级） ── */
var wsChat=null;var streamActive=false;var streamAbort=false;
var streamModel=null;var streamBuf=null;var __stopCurrentStream=null;
function chatWsUrl(sid){return wsUrl("/api/chat/ws?session_id="+encodeURIComponent(sid)+"&token="+encodeURIComponent(monitorToken||""));}
function doSend(){
  if(streamActive){stopStream();return;}
  var ta=$("compose");var text=ta.value.trim();
  if(!currentSession){newSession().then(function(){setTimeout(doSend,120);});return;}
  if(!text&&!pendingAttachments.length){return;}
  var message=text;
  if(pendingAttachments.length){
    var parts=[text||""];
    pendingAttachments.forEach(function(a){parts.push("["+(a.isImg?"图片":"附件")+":"+a.name+"]");});
    message=parts.join("\n");
  }
  pendingAttachments=[];renderAttachPreview();
  ta.value="";autoGrow();
  var s=sessions.find(function(x){return x.id===currentSession;});
  var model=(s&&s.model)||"";
  var persona=(s&&s.persona)?s.persona:null;
  streamModel=model;
  renderMsg("user",message,{model:model||null});
  startStream({session_id:currentSession,message:message,system:persona?persona.prompt:"",model:model,provider:""});
  scrollBottom();
}
function startStream(payload){
  streamActive=true;streamAbort=false;__stopCurrentStream=null;
  $("sendBtn").textContent="停止";$("sendBtn").classList.add("stop");
  streamBuf={content:"",reasoning:"",tools:[],msgEl:null};
  var m=renderMsg("assistant","",{model:streamModel||null});
  streamBuf.msgEl=m;
  var cEl=m.querySelector(".content");
  cEl.innerHTML="<span class='stream-cursor'></span>";
  var done=false;
  function finish(){
    if(done)return;done=true;
    streamActive=false;streamAbort=false;__stopCurrentStream=null;
    $("sendBtn").textContent="发送 ↵";$("sendBtn").classList.remove("stop");
    var cur=streamBuf.msgEl.querySelector(".stream-cursor");if(cur)cur.remove();
    if(!streamBuf.content.trim()&&streamBuf.reasoning){streamBuf.msgEl.querySelector(".content").innerHTML='<span style="color:var(--txt3);font-size:12px">（无文本输出）</span>';}
    var s=sessions.find(function(x){return x.id===currentSession;});
    if(s)refreshSession(s);
  }
  function appendDelta(d){
    streamBuf.content+=d;
    var c=streamBuf.msgEl.querySelector(".content");
    c.innerHTML="";
    if(streamBuf.reasoning.trim()){
      var r=document.createElement("div");r.className="reasoning";
      r.innerHTML='<div class="rt" onclick="var p=this.parentElement;p.classList.toggle(\'open\')">🧠 思考过程</div><div class="rc" style="display:none">'+esc(streamBuf.reasoning)+'</div>';
      c.appendChild(r);
    }
    var t=document.createElement("div");t.innerHTML=renderContent(streamBuf.content);
    while(t.firstChild)c.appendChild(t.firstChild);
    c.insertAdjacentHTML("beforeend","<span class='stream-cursor'></span>");
    scrollBottom();
  }
  function renderToolLine(t){
    var c=streamBuf.msgEl.querySelector(".content");
    var tb=document.createElement("div");tb.className="toolbox";
    tb.innerHTML="<span class='spin'></span><span class='tb'>"+esc(t)+"</span>";
    c.appendChild(tb);scrollBottom();
  }
  function appendError(msg){
    var c=streamBuf.msgEl.querySelector(".content");
    c.innerHTML+=renderContent("⚠️ "+msg);
    scrollBottom();
  }
  function handle(p){
    if(p.reasoning&&p.reasoning.length){streamBuf.reasoning+=p.reasoning;}
    else if(p.tool_progress){renderToolLine(p.tool_progress);}
    else if(p.delta){appendDelta(p.delta);}
    else if(p.error){toast("调用失败: "+p.error,"err");appendError(p.error);}
    else if(p.info){if(!streamBuf.content)toast(p.info);}
    else if(p.done){finish();}
  }
  function connectWS(){
    if(streamAbort){finish();return;}
    var ws;try{ws=new WebSocket(chatWsUrl(payload.session_id));}catch(e){sseFallback();return;}
    wsChat=ws;
    ws.onmessage=function(e){
      try{var p=JSON.parse(e.data);handle(p);}catch(ex){}
    };
    ws.onerror=function(){try{ws.close();}catch(e){}};
    ws.onclose=function(ev){
      if(streamAbort){finish();return;}
      if(ev.code!==1000){sseFallback();}
      else{finish();}
    };
    fetch(apiUrl("/api/chat/ws-send"),{
      method:"POST",headers:{"Content-Type":"application/json","X-Monitor-Token":monitorToken||""},
      body:JSON.stringify({session_id:payload.session_id,message:payload.message,system:payload.system||"",model:payload.model||"",provider:payload.provider||""})
    }).catch(function(){sseFallback();});
  }
  var sseUsed=false;
  var abortCtrl=new AbortController();
  function sseFallback(){
    if(sseUsed||streamAbort)return;sseUsed=true;
    if(wsChat){try{wsChat.close();}catch(e){}}
    fetch(apiUrl("/api/chat/stream"),{
      method:"POST",headers:{"Content-Type":"application/json","X-Monitor-Token":monitorToken||""},
      body:JSON.stringify(payload),
      signal:abortCtrl.signal
    }).then(function(r){
      if(!r.ok||!r.body)throw new Error("SSE "+r.status);
      var rd=r.body.getReader();var dec=new TextDecoder();var buf="";
      function pump(){
        return rd.read().then(function(res){
          if(res.done){finish();return;}
          buf+=dec.decode(res.value,{stream:true});
          var parts=buf.split("\n\n");buf=parts.pop()||"";
          parts.forEach(function(blk){
            var lines=blk.split("\n");var data="";
            lines.forEach(function(l){if(l.indexOf("data:")===0)data=l.slice(5).trim();});
            if(!data)return;
            try{var p=JSON.parse(data);handle(p);}catch(e){}
          });
          return pump();
        }).catch(function(){if(!streamAbort)finish();});
      }
      return pump();
    }).catch(function(e){if(!streamAbort){finish();appendError(e.message);}});
  }
  __stopCurrentStream=function(){
    streamAbort=true;
    fetch(apiUrl("/api/chat/stop"),{method:"POST",headers:{"Content-Type":"application/json","X-Monitor-Token":monitorToken||""},body:JSON.stringify({session_id:payload.session_id})}).catch(function(){});
    try{abortCtrl.abort();}catch(e){}
    if(wsChat){try{wsChat.close();}catch(e){}}
    finish();
  };
  connectWS();
}
function stopStream(){
  if(__stopCurrentStream)__stopCurrentStream();
  else{streamActive=false;$("sendBtn").textContent="发送 ↵";$("sendBtn").classList.remove("stop");}
}
function refreshSession(s){
  if(!s)return;
  fetch(apiUrl("/api/sessions/"+encodeURIComponent(s.id)+"/sync"),{cache:"no-store",headers:monitorToken?{"X-Monitor-Token":monitorToken}:{}})
    .then(function(){return listSessions();}).catch(function(){});
}

/* ── 附件 ── */
var pendingAttachments=[];
function pickFile(isImg){
  var fi=$("fileInput");
  fi.accept=isImg?"image/*":"";
  fi.setAttribute("data-isimg",isImg?"1":"0");
  fi.value="";fi.click();
}
function handleFilePick(ev){
  var f=ev.target.files&&ev.target.files[0];
  if(!f)return;
  var isImg=$("fileInput").getAttribute("data-isimg")==="1";
  pendingAttachments.push({name:f.name,isImg:isImg});
  renderAttachPreview();
}
function renderAttachPreview(){
  var box=$("attachPreview");box.innerHTML="";
  pendingAttachments.forEach(function(a,i){
    var d=document.createElement("div");d.className="ap";
    d.innerHTML=(a.isImg?"🖼️ ":"📎 ")+esc(a.name)+'<span class="x" onclick="removeAttach('+i+')">✕</span>';
    box.appendChild(d);
  });
}
function removeAttach(i){pendingAttachments.splice(i,1);renderAttachPreview();}
function autoGrow(){
  var ta=$("compose");ta.style.height="auto";ta.style.height=Math.min(ta.scrollHeight,180)+"px";
}
$("compose").addEventListener("input",autoGrow);
$("compose").addEventListener("keydown",function(e){
  if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();doSend();}
  if(e.key==="Escape"){closeAtPanel();}
});

/* ── 模型切换 ── */
var provData={providers:[],active:"",model:""};
function loadModels(){
  apiGet("/api/config").then(function(r){
    provData={providers:(r&&(r.providers||r.ymlProviders))||[],active:r&&(r.active_provider||r.activeProvName)||"",model:r&&(r.active_model||r.activeModel)||""};
    renderProvList();
    renderModelMenu();
    fillModelSettings();
  });
}
function renderProvList(){
  var box=$("provList");box.innerHTML="";
  if(!provData.providers.length){box.innerHTML='<div style="padding:16px;color:var(--txt3);font-size:12.5px">未配置提供商。请在本页「默认模型」中配置。</div>';return;}
  provData.providers.forEach(function(p){
    var row=document.createElement("div");row.className="mrow";
    var isActive=String(p.name)===String(provData.active)||String(p.id)===String(provData.active);
    row.innerHTML='<div style="min-width:0;flex:1"><div class="mn">'+esc(p.name||p.id)+'</div>'+
      '<div class="mb">'+esc(p.base_url||"")+'</div></div>'+
      '<span class="tag gray">'+esc(p.model||"auto")+'</span>'+
      (p.api_key_configured?'<span class="tag green">已配置</span>':'')+
      (isActive?'<span class="cur">当前</span>':'');
    box.appendChild(row);
  });
}
function renderModelMenu(){
  var menu=$("modelMenu");menu.innerHTML="";
  var dopt=document.createElement("div");dopt.className="model-opt"+(provData.model?"":" sel");
  dopt.innerHTML='<span class="mn">跟随默认</span><span class="mb">'+esc(provData.active||"")+" · "+esc(provData.model||"")+'</span>';
  dopt.onclick=function(){selectModelForNew("");};
  menu.appendChild(dopt);
  provData.providers.forEach(function(p){
    var models=(p.models&&p.models.length)?p.models:([p.model||""].filter(Boolean));
    if(!models.length)models.push("auto");
    models.forEach(function(md){
      var opt=document.createElement("div");opt.className="model-opt";
      opt.innerHTML='<span class="mn">'+esc(md)+'</span><span class="mb">'+esc(p.name||p.id)+'</span>';
      opt.onclick=function(){selectModelForNew(md,p.name);};
      menu.appendChild(opt);
    });
  });
  var tip=document.createElement("div");tip.className="model-tip";
  tip.textContent="💡 模型按会话固定：选择模型后将开启新会话。当前会话模型见头部标签。";
  menu.appendChild(tip);
}
function toggleModelMenu(){$("modelMenu").classList.toggle("hidden");}
document.addEventListener("click",function(e){
  if(!e.target.closest||!e.target.closest("#modelPicker")){$("modelMenu").classList.add("hidden");}
});
function selectModelForNew(model,provider){
  $("modelMenu").classList.add("hidden");
  var s=sessions.find(function(x){return x.id===currentSession;});
  if(!model){
    if(s&&!s.model){toast("本会话跟随默认模型","ok");}
    else if(s){s.model="";$("chatModelTag").classList.add("hidden");$("modelCurName").textContent="跟随默认";toast("本会话跟随默认模型","ok");}
    return;
  }
  if(s&&(!s.messages||!s.messages.length)){
    s.model=model;
    $("chatModelTag").textContent="模型: "+model;$("chatModelTag").classList.remove("hidden");
    $("modelCurName").textContent=model;
    toast("本会话使用模型: "+model,"ok");
  }else{
    toast("已切换模型，将开启新会话: "+model);
    newSession({model:model});
  }
}

/* ── 默认模型设置 ── */
function fillModelSettings(){
  var selP=$("defProvider");selP.innerHTML="";
  var selM=$("defModel");selM.innerHTML="";
  provData.providers.forEach(function(p){
    var o=document.createElement("option");
    o.value=p.name||p.id;o.textContent=(p.name||p.id);
    selP.appendChild(o);
  });
  if(selP.options.length===0){
    var o=document.createElement("option");o.value="";o.textContent="（未发现提供商）";selP.appendChild(o);
  }
  selP.value=provData.active||selP.options[0].value;
  refreshDefModels();
  selP.onchange=refreshDefModels;
}
function refreshDefModels(){
  var selP=$("defProvider");var selM=$("defModel");
  var p=provData.providers.find(function(x){return (x.name||x.id)===selP.value;});
  selM.innerHTML="";
  var models=(p&&p.models&&p.models.length)?p.models:([(p&&p.model)||""].filter(Boolean));
  (models.length?models:["auto"]).forEach(function(md){
    var o=document.createElement("option");o.value=md;o.textContent=md;
    if(md===provData.model||(!provData.model&&md==="auto"))o.selected=true;
    selM.appendChild(o);
  });
}
function saveDefaultModel(){
  var selP=$("defProvider");var selM=$("defModel");
  if(!selP.value||!selM.value){toast("请选择提供商和模型","err");return;}
  var body={active_provider:selP.value,providers:provData.providers.map(function(p){
    return {id:p.id,name:p.name,base_url:p.base_url,model:(p.name||p.id)===selP.value?selM.value:p.model,api_key:p.api_key_masked||"",is_custom:!!p.is_custom};
  })};
  apiPost("/api/config",body).then(function(r){
    if(r&&r.ok!==false){toast("默认模型已保存: "+selM.value,"ok");loadModels();}
    else toast("保存失败: "+((r&&r.error)||"未知错误"),"err");
  }).catch(function(e){toast("保存失败: "+e.message,"err");});
}

/* ── 专家广场 ── */
var expDept="all";var expFavs=[];
try{expFavs=JSON.parse(localStorage.getItem("hs-exp-favs")||"[]");}catch(e){}
function getExperts(){return window.AGENCY_PERSONAS||[];}
function getDepts(){return window.AGENCY_DEPTS||[];}
function renderExpTabs(){
  var tabs=$("expTabs");tabs.innerHTML="";
  var all=document.createElement("div");
  all.className="exp-tab"+(expDept==="all"?" active":"");
  all.textContent="全部 ("+getExperts().length+")";
  all.onclick=function(){expDept="all";renderExpTabs();renderExperts();};
  tabs.appendChild(all);
  getDepts().forEach(function(d){
    var t=document.createElement("div");
    t.className="exp-tab"+(expDept===d.id?" active":"");
    t.textContent=d.label+" ("+d.count+")";
    t.onclick=function(){expDept=d.id;renderExpTabs();renderExperts();};
    tabs.appendChild(t);
  });
}
function renderExperts(){
  var kw=($("expSearch").value||"").trim().toLowerCase();
  var list=getExperts().filter(function(x){
    if(expDept!=="all"&&x.dept!==expDept)return false;
    if(kw){
      var hay=(x.label+" "+(x.desc||"")+" "+(x.dept_label||"")).toLowerCase();
      if(hay.indexOf(kw)<0)return false;
    }
    return true;
  });
  var grid=$("expGrid");grid.innerHTML="";
  if(!list.length){grid.innerHTML='<div style="grid-column:1/-1;text-align:center;color:var(--txt3);padding:40px">没有匹配的专家</div>';return;}
  list.forEach(function(x){
    var card=document.createElement("div");card.className="exp-card";
    var fav=expFavs.indexOf(x.id)>=0;
    card.innerHTML='<span class="fav'+(fav?" on":"")+'" onclick="toggleFav(\''+x.id+'\',this)">'+(fav?"★":"☆")+'</span>'+
      '<div class="e1"><div class="em">'+esc(x.emoji||"🧠")+'</div><div><div class="en">'+esc(x.label)+'</div><div class="ed">'+esc(x.dept_label||"")+'</div></div></div>'+
      '<div class="desc">'+esc(x.desc||"")+'</div>'+
      '<div class="ops"><button class="btn primary" onclick="chatWithExpert(\''+x.id+'\')">对话</button><button class="btn" onclick="viewExpert(\''+x.id+'\')">详情</button></div>';
    grid.appendChild(card);
  });
}
function toggleFav(id,el){
  var i=expFavs.indexOf(id);
  if(i>=0)expFavs.splice(i,1);else expFavs.push(id);
  try{localStorage.setItem("hs-exp-favs",JSON.stringify(expFavs));}catch(e){}
  el.textContent=(i>=0)?"☆":"★";el.classList.toggle("on",i<0);
}
function viewExpert(id){
  var x=getExperts().find(function(e){return e.id===id;});
  if(!x)return;
  var d=document.createElement("div");
  d.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px";
  d.onclick=function(ev){if(ev.target===d)d.remove();};
  var box=document.createElement("div");
  box.className="card";
  box.style.cssText="max-width:560px;width:100%;max-height:80vh;overflow-y:auto;padding:20px";
  box.innerHTML='<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">'+
    '<div style="width:44px;height:44px;border-radius:12px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center;font-size:24px">'+esc(x.emoji||"🧠")+'</div>'+
    '<div><div style="font-size:16px;font-weight:700">'+esc(x.label)+'</div><div style="font-size:12px;color:var(--txt2)">'+esc(x.dept_label||"")+'</div></div></div>'+
    '<div style="font-size:13px;color:var(--txt2);margin-bottom:14px">'+esc(x.desc||"")+'</div>'+
    '<div style="font-size:12px;color:var(--txt3);margin-bottom:8px">人格设定（system prompt）</div>'+
    '<pre style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:11.5px;line-height:1.6;max-height:300px;overflow-y:auto;white-space:pre-wrap;word-break:break-all">'+esc(x.prompt||"")+'</pre>'+
    '<div style="display:flex;gap:10px;margin-top:16px"><button class="btn primary" style="flex:1" onclick="chatWithExpert(\''+x.id+'\')">💬 与这位专家对话</button><button class="btn" onclick="this.closest(\'.card\').parentElement.remove()">关闭</button></div>';
  d.appendChild(box);document.body.appendChild(d);
}
function chatWithExpert(id){
  var x=getExperts().find(function(e){return e.id===id;});
  if(!x)return;
  newSession({persona:x}).then(function(s){
    if(s){s.persona=x;}
    renderSessions();selectSession(s.id);
    $("compose").focus();
    toast("已切换专家: "+(x.emoji||"")+" "+x.label,"ok");
  });
}

/* ── @ 提及面板 ── */
var atIdx=0;var atList=[];
function openAtPanel(){
  if(!currentSession)newSession();
  atList=getExperts();
  renderAtPanel(atList,"");
  $("atPanel").style.display="block";
}
function closeAtPanel(){$("atPanel").style.display="none";}
function renderAtPanel(list,kw){
  var panel=$("atPanel");panel.innerHTML="";
  var box=document.createElement("div");box.className="at-search";
  var inp=document.createElement("input");inp.type="text";inp.placeholder="搜索专家…";
  box.appendChild(inp);panel.appendChild(box);
  var kw2=(kw||"").toLowerCase();
  var fl=list.filter(function(x){return !kw2||(x.label+" "+x.desc+" "+(x.dept_label||"")).toLowerCase().indexOf(kw2)>=0;}).slice(0,12);
  atList=fl;atIdx=0;
  fl.forEach(function(x,i){
    var it=document.createElement("div");it.className="at-item"+(i===0?" sel":"");
    it.innerHTML='<span class="em">'+esc(x.emoji||"🧠")+'</span><span class="lb">'+esc(x.label)+'</span><span class="dp">'+esc(x.desc||"")+'</span><span class="dt">'+esc(x.dept_label||"")+'</span>';
    it.onclick=function(){chooseAt(x);};
    panel.appendChild(it);
  });
  if(!fl.length){var e=document.createElement("div");e.className="at-item";e.textContent="无匹配专家";panel.appendChild(e);}
  inp.oninput=function(){renderAtPanel(atList,this.value);};
  inp.onkeydown=function(e){
    if(e.key==="ArrowDown"){e.preventDefault();moveAt(1);}
    else if(e.key==="ArrowUp"){e.preventDefault();moveAt(-1);}
    else if(e.key==="Enter"){e.preventDefault();if(atList[atIdx])chooseAt(atList[atIdx]);}
    else if(e.key==="Escape"){closeAtPanel();}
  };
  setTimeout(function(){inp.focus();},30);
}
function moveAt(d){
  atIdx=(atIdx+d+atList.length)%atList.length;
  var items=$("atPanel").querySelectorAll(".at-item");
  items.forEach(function(el,i){el.classList.toggle("sel",i===atIdx);});
  var sel=items[atIdx];if(sel)sel.scrollIntoView({block:"nearest"});
}
function chooseAt(x){
  closeAtPanel();
  var s=sessions.find(function(z){return z.id===currentSession;});
  if(s&&(!s.messages||!s.messages.length)){
    s.persona=x;
    renderSessions();selectSession(s.id);
    $("compose").placeholder="与 "+(x.label)+" 对话…";
    toast("已绑定专家: "+(x.emoji||"")+" "+x.label,"ok");
  }else{
    chatWithExpert(x.id);
  }
  $("compose").focus();
}
$("compose").addEventListener("input",function(){
  var v=this.value;
  var m=v.match(/@([^\s@]*)$/);
  if(m){renderAtPanel(getExperts(),m[1]);$("atPanel").style.display="block";}
  else{$("atPanel").style.display="none";}
});

/* ── 状态 ── */
function loadStatus(){
  apiGet("/api/status").then(function(r){
    if(!r||r.ok===false){$("statGrid").innerHTML='<div style="grid-column:1/-1;color:var(--txt3);font-size:12.5px">状态不可用: '+esc((r&&r.error)||"")+'</div>';return;}
    var items=[
      ["网关",(r.gateway&&r.gateway.state)||(r.gateway_running?"运行中":"—")],
      ["Profile",r.active_profile||r.profile||"—"],
      ["模型",r.model||r.active_model||"—"],
      ["提供商",r.provider||"—"],
      ["进程 PID",r.gateway_pid||(r.gateway&&r.gateway.pid)||"—"],
      ["API 端口",r.api_port||(r.ports&&r.ports.api)||"—"],
      ["UI 端口",r.ui_port||(r.ports&&r.ports.ui)||"—"],
      ["会话数",r.sessions&&r.sessions.length!=null?r.sessions.length:(r.session_count||"—")],
      ["版本",r.version||"—"]
    ];
    $("statGrid").innerHTML=items.map(function(it){
      return '<div class="stat-box"><div class="k">'+esc(it[0])+'</div><div class="v">'+esc(it[1])+'</div></div>';
    }).join("");
    $("aboutBox").innerHTML='<div style="font-size:12.5px;line-height:1.8;color:var(--txt2)">Hermes Agent Studio UI v0.23（重构版）<br>后端：monitor + Hermes Gateway<br>专家库：'+(getExperts().length||"268")+' 位内置专家</div>';
  }).catch(function(){});
}
function pollStatus(){
  apiGet("/api/health").then(function(r){
    var dot=$("gwDot");var tx=$("gwText");
    if(r&&(r.token||r.status==="ok")){dot.className="dot ok";tx.textContent="网关在线";}
    else{dot.className="dot";tx.textContent="网关离线";}
  }).catch(function(){$("gwDot").className="dot err";$("gwText").textContent="服务不可达";});
}

/* ── 设置 ── */
function toggleTts(){
  var sw=$("swTts");sw.classList.toggle("on");
  try{localStorage.setItem("hs-tts",sw.classList.contains("on")?"1":"0");}catch(e){}
}
function toggleVoice(){
  var sw=$("swVoice");sw.classList.toggle("on");
  try{localStorage.setItem("hs-voice",sw.classList.contains("on")?"1":"0");}catch(e){}
}
function initSettings(){
  try{
    $("swTts").classList.toggle("on",localStorage.getItem("hs-tts")!=="0");
    $("swVoice").classList.toggle("on",localStorage.getItem("hs-voice")!=="0");
  }catch(e){}
  apiGet("/api/voice/config").then(function(r){
    if(r&&(r.voice||r.voices)){
      var v=r.voice||(r.voices&&r.voices.length?r.voices[0]:"");
      if(v)$("voiceCur").textContent="Edge · "+v;
    }
  }).catch(function(){});
}
function openVoicePicker(){
  apiGet("/api/voice/config").then(function(r){
    var voices=(r&&r.voices)||[];
    var opts=voices.length?voices.map(function(v){return '<option value="'+esc(v)+'">'+esc(v)+'</option>';}).join(""):'<option value="">（无可用音色）</option>';
    var d=document.createElement("div");
    d.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:center;justify-content:center";
    d.onclick=function(ev){if(ev.target===d)d.remove();};
    d.innerHTML='<div class="card" style="padding:20px;width:340px"><div style="font-weight:600;margin-bottom:12px">选择朗读音色</div><select id="vpSel">'+opts+'</select>'+
      '<div style="display:flex;gap:10px;margin-top:16px"><button class="btn primary" style="flex:1" id="vpOk">保存</button><button class="btn" onclick="this.closest(\'.card\').parentElement.remove()">取消</button></div></div>';
    document.body.appendChild(d);
    $("vpOk").onclick=function(){
      var v=$("vpSel").value;
      apiPost("/api/voice/config",{voice:v}).then(function(r){
        if(r&&r.ok!==false){toast("音色已保存","ok");d.remove();initSettings();}
        else toast("保存失败","err");
      }).catch(function(){toast("保存失败","err");});
    };
  }).catch(function(){toast("读取音色失败","err");});
}

/* ── 启动 ── */
(function(){
  BASE=resolveBase();
  fetchToken().then(function(){
    pollStatus();
    setInterval(pollStatus,30000);
    listSessions();
    renderExpTabs();
    initSettings();
    if(!sessions.length)renderEmpty();
  });
})();
