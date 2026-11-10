/* Minecraft Cloud: Modrinth-inspired browse and direct-to-server install.
   The page uses native Tauri IPC, never downloads release files to Windows. */
(function () {
  "use strict";

  const invoke = (name, args) => window.__TAURI__.core.invoke(name, args || {});
  const escape = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const pretty = (value) => String(value || "").replace(/(^|-)([a-z])/g, (_, _h, c) => " " + c.toUpperCase()).trim();
  const compact = (n) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(n) || 0);
  const dateAgo = (date) => {
    const time = new Date(date).getTime();
    if (!Number.isFinite(time)) return "Unknown";
    const days = Math.max(0, Math.floor((Date.now() - time) / 86400000));
    return days < 1 ? "Today" : days < 30 ? days + "d ago" : days < 365 ? Math.floor(days / 30) + "mo ago" : Math.floor(days / 365) + "y ago";
  };
  const categories = [
    ["adventure", "🧭"], ["cursed", "👻"], ["decoration", "🏡"],
    ["economy", "💰"], ["equipment", "⚔"], ["food", "🍞"],
    ["game-mechanics", "⚙"], ["library", "📚"], ["magic", "✨"],
    ["management", "🗂"], ["minigame", "🎮"], ["mobs", "🐾"],
    ["optimization", "⚡"], ["social", "💬"], ["storage", "📦"],
    ["technology", "🔧"], ["transportation", "🚂"], ["utility", "🛠"],
    ["worldgen", "🌎"]
  ];
  const versions = ["26.3", "26.2", "26.1.2", "26.1.1", "26.1", "1.21.11", "1.21.10"];
  const loaders = ["paper", "purpur", "spigot", "bukkit"];
  const ordering = [["downloads", "Most downloaded"], ["relevance", "Relevance"],
    ["follows", "Most followed"], ["updated", "Recently updated"], ["newest", "Newest"]];
  const state = {
    kind: "plugin", query: "", category: "", version: "26.3", loader: "",
    sort: "downloads", page: 0, total: 0, hits: [], loading: false,
    loaded: false, installing: "", notice: "", error: false, installed: [],
    queued: {}, queueLoaded: false, queueBusy: false,
    inventory: {installed:{},pluginFiles:[],datapackFiles:[]}, inventoryLoaded:false,inventoryBusy:false,
    inventoryLive:null,inventorySession:null,latestReleases:{},tab:"browse",contentActions:{},actionsLoaded:false,
    actionBusy:false,versionLoading:false,updatingAll:false,
    sortTouched: false,
    detailId:null,detailKind:null,detailInfo:null,detailError:"",detailLoading:false,detailEpoch:0,
    online: false, epoch: 0, searchTimer: null
  };
  const root = () => document.getElementById("mc-marketplace");
  const active = () => Boolean(root());
  const trustedIcon = (url) => typeof url === "string" &&
    url.startsWith("https://cdn.modrinth.com/") && !/["'<>\s]/.test(url) ? url : "";

  function status(message, error) {
    state.notice = message || "";
    state.error = Boolean(error);
    const slot = document.getElementById("mc-market-status");
    if (slot) {
      slot.textContent = state.notice;
      slot.hidden = !state.notice;
      slot.classList.toggle("is-error", state.error);
      const manager=document.getElementById("mc-manager-status");
      if(manager){manager.textContent=state.notice;manager.hidden=!state.notice;manager.classList.toggle("is-error",state.error); }
    }
  }

  function card(item) {
    const id = escape(item.project_id || "");
    const title = escape(item.title || item.slug || "Untitled project");
    const img = trustedIcon(item.icon_url);
    const icon = img ? '<img class="mc-discover-icon" src="' + escape(img) + '" alt="" loading="lazy">' :
      '<span class="mc-discover-icon mc-discover-icon-fallback" aria-hidden="true">⬡</span>';
    const rawCats = (item.display_categories || item.categories || []).filter(
      c => !loaders.includes(c) && categories.some(ca => ca[0] === c)).slice(0, 3);
    const pills = rawCats.map(cat => '<span class="mc-discover-tag">' + escape(pretty(cat)) + '</span>').join("");
    const other = item.categories && item.categories.filter(c => loaders.includes(c)).slice(0, 2) || [];
    const loaderTags = other.map(cat => '<span class="mc-discover-loader">' + escape(pretty(cat)) + '</span>').join("");
    const installing = state.installing === item.project_id;
    const record = state.inventory.installed?.[item.project_id] ||
      state.installed.find(x=>x.projectId===item.project_id);
    const files=state.kind==="plugin"?state.inventory.pluginFiles:state.inventory.datapackFiles;
    const normalized=value=>String(value||"").toLowerCase().replace(/[^a-z0-9]/g,"");
    const titleStem=normalized(item.slug||item.title);
    const suffix=state.kind==="plugin"?".jar":".zip";
    const unmanaged=!record && Array.isArray(files) && files.some(file=>{
      if(!String(file).endsWith(suffix))return false;
      const stem=normalized(String(file).slice(0,-suffix.length));
      return stem===titleStem || stem===normalized(item.title);
    });
    const latest=state.latestReleases[item.project_id];
    const queued=state.queued[item.project_id];
    const same=record&&latest&&record.versionId===latest.id;
    const hasKnown=Boolean(record?.versionId);
    const checking=Boolean(record?.versionId)&&(!latest||latest.pending);
    const unavailable=Boolean(record?.versionId&&latest?.unavailable);
    const current=Boolean(same||unmanaged||record&&!hasKnown);
    const disabled = Boolean(state.installing) || state.version !== "26.3" ||
      Boolean(current&&!queued) || Boolean(checking&&!queued) || Boolean(unavailable&&!queued);
    const buttonLabel = installing?"Processing…" : queued?"Cancel" :
      current?(record?.enabled===false?"Disabled":"Installed") : checking?"Checking…" : unavailable?"Version unavailable" :
      record && hasKnown ? (state.online?"Update":"Queue update") :
      state.online?"Install":"Queue install";
    return '<article class="mc-discover-card">' +
      '<div class="mc-discover-art">' + icon + '</div>' +
      '<div class="mc-discover-card-main"><div class="mc-discover-title">' +
      '<button type="button" class="mc-project-open" data-market-action="details" data-id="'+id+'" data-kind="'+escape(state.kind)+'">' + title + '</button><span>by ' + escape(item.author || "Unknown") + '</span></div>' +
      '<p class="mc-discover-description">' + escape(item.description || "No description provided.") + '</p>' +
      '<div class="mc-discover-tags">' +
      '<span class="mc-discover-tag">' + (state.kind === "plugin" ? "Server plugin" : "Data pack") + '</span>' +
      pills + loaderTags + '</div></div>' +
      '<div class="mc-discover-card-side"><div class="mc-discover-numbers">' +
      '<span title="Downloads">↓ ' + compact(item.downloads) + '</span>' +
      '<span title="Followers">♡ ' + compact(item.follows) + '</span>' +
      '<span class="mc-discover-date" title="Last updated">◷ ' + escape(dateAgo(item.date_modified)) + '</span></div>' +
      '<div class="mc-install-actions"><button type="button" class="mc-discover-install" data-market-action="'+(queued?'unqueue':'install')+'" data-id="' +
      id + '" ' + (disabled&&!queued ? 'disabled' : '') + '>' + buttonLabel + '</button>' +
      '' +
      '</div></div></article>';
  }

  function renderResults() {
    const list = document.getElementById("mc-market-results");
    if (!list) return;
    if (state.loading) {
      list.innerHTML = Array.from({ length: 5 }, () =>
        '<div class="mc-discover-skeleton"><span></span><div><i></i><i></i><i></i></div></div>').join("");
    } else if (!state.hits.length) {
      list.innerHTML = '<div class="mc-discover-empty"><span>⌕</span><strong>No matching projects</strong>' +
        '<p>Try a different category, version, or search term.</p></div>';
    } else {
      list.innerHTML = state.hits.map(card).join("");
    }
    const resultHeader = document.getElementById("mc-market-results-label");
    if (resultHeader) {
      const label = state.query ? 'Results for “' + state.query + '”' : 'Popular ' +
        (state.kind === "plugin" ? "plugins" : "datapacks");
      resultHeader.textContent = label;
    }
    const total = document.getElementById("mc-market-count");
    if (total) total.textContent = state.loading ? "Loading…" :
      state.total.toLocaleString() + " projects · " + (state.page + 1) + " of " +
      Math.max(1, Math.ceil(state.total / 20)) + " pages";
    const prev = document.getElementById("mc-market-prev");
    const next = document.getElementById("mc-market-next");
    if (prev) prev.disabled = state.page === 0 || state.loading;
    if (next) next.disabled = state.loading || (state.page + 1) * 20 >= state.total;
    const selected = document.getElementById("mc-market-filter-info");
    if (selected) selected.textContent = state.version === "26.3" ?
      "Verified install target: Paper 26.3" :
      "Browsing " + (state.version || "all versions") + ". Install requires Paper 26.3.";
  }

  function filters() {
    return '<aside class="mc-discover-sidebar"><section class="mc-discover-filter">' +
      '<h3>Game version</h3>' +
      '<button type="button" class="mc-discover-choice ' + (!state.version ? "active" : "") +
      '" data-market-action="version" data-value="">All versions</button>' +
      versions.map(v => '<button type="button" class="mc-discover-choice ' +
        (state.version === v ? "active" : "") + '" data-market-action="version" data-value="' +
        escape(v) + '">' + escape(v) + (v === "26.3" ? '<span>Server</span>' : '') + '</button>').join("") +
      '</section>' +
      (state.kind === "plugin" ? '<section class="mc-discover-filter"><h3>Loader</h3>' +
        '<button type="button" class="mc-discover-choice ' + (!state.loader ? "active" : "") +
        '" data-market-action="loader" data-value="">All Paper-compatible</button>' +
        loaders.map(l => '<button type="button" class="mc-discover-choice ' +
          (state.loader === l ? "active" : "") + '" data-market-action="loader" data-value="' +
          l + '">' + escape(pretty(l)) + '</button>').join("") +
        '</section>' : '') +
      '<section class="mc-discover-filter"><h3>Categories</h3>' +
      '<button type="button" class="mc-discover-choice ' + (!state.category ? "active" : "") +
      '" data-market-action="category" data-value="">✦ &nbsp; All categories</button>' +
      categories.map(([cat, glyph]) => '<button type="button" class="mc-discover-choice ' +
        (state.category === cat ? "active" : "") + '" data-market-action="category" data-value="' +
        escape(cat) + '"><span class="mc-discover-category-icon">' +
        glyph + '</span>' + escape(pretty(cat === "worldgen" ? "world-generation" : cat)) + '</button>').join("") +
      '</section><button type="button" class="mc-discover-clear" data-market-action="reset">↺ Reset all filters</button></aside>';
  }

  function render(online,session=null) {
    const changedOnline=state.online!==Boolean(online)||
      (Boolean(online)&&Boolean(session)&&session!==state.inventorySession);
    state.online = Boolean(online);
    if(session)state.inventorySession=session;
    if(changedOnline){state.inventoryLoaded=false;state.latestReleases={};state.actionsLoaded=false;}
    const container = document.getElementById("content");
    if (!container) return;
    container.innerHTML = '<section id="mc-marketplace" class="mc-discover">' +
      '<div class="mc-discover-head"><div><div class="mc-discover-eyebrow"><span>◉</span> CONTENT LIBRARY</div>' +
      '<h1>Plugins & Datapacks</h1><p>Browse Modrinth and install compatible content directly to Paper.</p></div>' +
      '<div class="mc-discover-server">' + (state.online ? '<span class="online">● Server connected</span>' :
        '<span class="offline">○ Offline installs will be queued</span>') + '<small>Paper 26.3</small></div></div>' +
      '<div class="mc-discover-kind-bar">' +
      '<button type="button" class="' + (state.kind === "plugin" ? "active" : "") +
      '" data-market-action="kind" data-value="plugin">⬡ Plugins</button>' +
      '<button type="button" class="' + (state.kind === "datapack" ? "active" : "") +
      '" data-market-action="kind" data-value="datapack">▤ Data Packs</button>' +
      '<span>Modrinth</span></div>' +
      '<div class="mc-library-tabs" role="tablist" aria-label="Plugin management">'+
      [["browse","Browse"],["installed","Installed"],["updates","Updates"],["queue","Queue"]]
        .map(([key,label])=>'<button type="button" data-market-action="tab" data-value="'+key+
          '" role="tab" aria-selected="'+(state.tab===key)+'" class="'+(state.tab===key?"active":"")+'">'+label+'</button>').join("")+
      '</div>'+
      '<section id="mc-installed-manager" class="mc-installed-manager" '+
        (state.tab==="browse"?'hidden':'')+'></section>'+
      '<div class="mc-discover-layout" '+(state.tab==="browse"?'':'style="display:none"')+'>' + filters() + '<div class="mc-discover-primary">' +
      '<form id="mc-market-search-form" class="mc-discover-search"><span>⌕</span>' +
      '<input id="mc-market-query" type="search" autocomplete="off" placeholder="Search ' +
      (state.kind === "plugin" ? "plugins" : "datapacks") + '…" value="' + escape(state.query) +
      '" aria-label="Search Modrinth">' +
      '<button type="submit">Search</button></form>' +
      '<div class="mc-discover-toolbar"><label>Sort by <select id="mc-market-sort">' +
      ordering.map(([v, label]) => '<option value="' + v + '" ' +
        (state.sort === v ? "selected" : "") + '>' + escape(label) + '</option>').join("") +
      '</select></label><span id="mc-market-count"></span></div>' +
      '<div id="mc-market-filter-info" class="mc-discover-info"></div>' +
      '<div id="mc-market-status" class="mc-discover-status" role="status" aria-live="polite" ' +
      (state.notice ? "" : "hidden") + '>' + escape(state.notice) + '</div>' +
      '<div id="mc-market-installed"></div>' +
      '<h2 id="mc-market-results-label" class="mc-discover-results-heading"></h2>' +
      '<div id="mc-market-results" class="mc-discover-list"></div>' +
      '<div class="mc-discover-pagination"><button type="button" id="mc-market-prev" data-market-action="previous">← Previous</button>' +
      '<button type="button" id="mc-market-next" data-market-action="next">Next →</button></div>' +
      '</div></div></section>';
    const slot = document.getElementById("mc-market-status");
    if (slot) slot.classList.toggle("is-error", state.error);
    renderInstalled();
    renderResults();
    renderInstalledManager();
    ensureQueueLoaded();
    ensureContentActionsLoaded();
    ensureInventoryLoaded();
  }

  function renderInstalled() {
    const area = document.getElementById("mc-market-installed");
    if (!area) return;
    const pending = state.installed.some(x => x.restartRequired);
    const queued = Object.entries(state.queued);
    const pendingBox = queued.length ? '<div class="mc-discover-installed"><div><strong>Pending next server start · ' + queued.length + '</strong><span>These downloads will be installed automatically after the latest verified backup is restored.</span></div><div class="mc-queue-entries">' + queued.map(([id,item])=>
      '<span class="mc-queue-entry">' + escape(item.title||id) + ' <button type="button" data-market-action="unqueue" data-id="' + escape(id) + '" title="Remove queued install">×</button></span>').join("") + '</div></div>' : "";
    area.innerHTML = pendingBox + (!state.installed.length ? '' :
      '<div class="mc-discover-installed"><div><strong>✓ Installed on your server</strong>' +
      '<span>' + state.installed.map(x => escape(x.name)).join(", ") +
      (pending ? " · Restart needed for plugins" : " · Reload requested for datapacks") +
      '</span></div>' + (pending ? '<button type="button" data-action="market-restart">Safely restart</button>' : '') + '</div>');
  }

  function chooseManagedRelease(candidates,record){
    if(!Array.isArray(candidates)||!candidates.length)return {unavailable:true};
    const newest=candidates.find(v=>v.version_type==="release")||candidates[0];
    const current=candidates.find(v=>v.id===record?.versionId);
    if(current?.date_published&&newest.date_published){
      const installedDate=Date.parse(current.date_published);
      const nextDate=Date.parse(newest.date_published);
      // Don't call an older compatible release an update.
      if(Number.isFinite(installedDate)&&Number.isFinite(nextDate)&&nextDate<=installedDate){
        return {...newest,id:record.versionId,upToDate:true};
      }
    }
    if((newest.dependencies||[]).some(d=>d.dependency_type==="required")){
      return {...newest,blocked:true};
    }
    return newest;
  }
  function compatibleUpdate(id, record){
    const release=state.latestReleases[id];
    if(!release||release.pending||release.unavailable||release.blocked||!release.id)return null;
    if(!record?.versionId||record.versionId===release.id)return null;
    return release;
  }
  function renderInstalledManager(){
    const area=document.getElementById("mc-installed-manager");
    if(!area)return;
    const {installed={},pluginFiles=[],datapackFiles=[]}=state.inventory;
    const entries=Object.entries(installed).filter(([id,entry])=>
      entry?.kind===state.kind&&state.contentActions[id]!=="remove");
    const queued=Object.entries(state.queued).filter(([,entry])=>entry?.kind===state.kind);
    const actions=state.kind==="plugin"?Object.entries(state.contentActions):[];
    const updates=entries.filter(([id,entry])=>
      entry.enabled!==false&&!state.contentActions[id]&&compatibleUpdate(id,entry));
    const knownNames=new Set(entries.map(([id,entry])=>"modrinth-"+id+(entry.kind==="plugin"?".jar":".zip")));
    const unmanaged=(state.kind==="plugin"?pluginFiles:datapackFiles)
      .filter(name=>!knownNames.has(name)).sort((a,b)=>a.localeCompare(b));
    const title=state.tab==="installed"?"Installed content":
      state.tab==="updates"?"Compatible updates":"Pending content changes";
    const content=state.inventoryLoaded?(
      state.tab==="queue"?
        (queued.length||actions.length?
          '<div class="mc-managed-list">'+
          queued.map(([id,item])=>'<div class="mc-managed-row"><div><strong>'+
            escape(item.title||id)+'</strong><span>Version '+escape(item.versionId)+
            ' · Pending install/update</span></div><button class="btn small" data-market-action="unqueue" data-id="'+escape(id)+'">× Remove</button></div>').join("")+
          actions.map(([id,action])=>'<div class="mc-managed-row"><div><strong>'+
            escape(installed[id]?.title||id)+'</strong><span>Pending: '+escape(action)+
            '</span></div><button class="btn small" data-market-action="cancel-content" data-id="'+escape(id)+'">× Remove</button></div>').join("")+'</div>':
          '<div class="mc-managed-empty">No pending plugin or datapack changes.</div>'):
      state.tab==="updates"?
        (updates.length?'<div class="mc-managed-list">'+updates.map(([id,entry])=>
          managedRow(id,entry,true)).join("")+'</div>':
          '<div class="mc-managed-empty">'+(state.versionLoading?
            'Checking installed projects for compatible releases…':
            'No confirmed compatible updates found.')+'</div>'):
      '<div class="mc-managed-list">'+
        entries.map(([id,entry])=>managedRow(id,entry,false)).join("")+
        unmanaged.map(name=>'<div class="mc-managed-row"><div><strong>'+
          escape(name)+'</strong><span>Unmanaged file · Version unknown · Read-only</span></div>'+
          '<span class="mc-managed-neutral">Unmanaged</span></div>').join("")+
        (!entries.length&&!unmanaged.length?
          '<div class="mc-managed-empty">No installed content detected.</div>':'')+
      '</div>'
    ):'<div class="mc-managed-empty">Checking installed content from the live server or verified backup…</div>';
    area.innerHTML='<div id="mc-manager-status" class="mc-discover-status" role="status" aria-live="polite" '+
      (state.notice?'':'hidden')+'>'+escape(state.notice)+'</div>'+
      '<div class="mc-managed-heading"><div><h2>'+title+'</h2>'+
      '<p>'+(state.online?'From the running Paper server':
        'From the most recent verified backup')+
      ' · Paper 26.3</p></div><div class="mc-managed-toolbar">'+
      (state.tab==="updates"?
        '<button type="button" data-market-action="update-all" class="btn primary small" '+
        (state.updatingAll||state.versionLoading||!updates.length?'disabled':'')+
        '>Queue '+updates.length+' update(s)</button>':'')+
      '<button type="button" class="btn small" data-market-action="refresh-installed" '+
      (state.inventoryBusy||state.versionLoading?'disabled':'')+'>Refresh versions</button></div></div>'+
      '<div class="mc-managed-notice">Changes are staged for the next safe Paper startup. Queued removals disappear from Installed but remain reversible under Queue.</div>'+
      content+
      '<p class="mc-managed-footnote">Only verified Modrinth-managed plugins can be disabled or removed here. Other JARs remain visible but cannot be modified by this manager.</p>';
  }
  function managedRow(id,record,updatesOnly){
    const latest=state.latestReleases[id];
    const update=compatibleUpdate(id,record);
    const pending=state.queued[id];
    const action=state.contentActions[id];
    const checking=latest?.pending||!latest;
    const available=latest&&!latest.pending&&!latest.unavailable&&latest.id;
    const stateLabel=action?'Queued '+action:
      pending?'Update queued':record.enabled===false?'Disabled':
      update?'Update available':checking?'Checking versions…':
      latest?.blocked?'Required dependency missing':
      available?'Current version':'Version unavailable';
    const commands=record.kind==="plugin"?
      action?'<button type="button" class="btn small" data-market-action="cancel-content" data-id="'+escape(id)+'">Cancel '+escape(action)+'</button>':
        '<button type="button" class="btn small" data-market-action="content-action" data-value="'+
          (record.enabled===false?'enable':'disable')+'" data-id="'+escape(id)+'">'+
          (record.enabled===false?'Queue enable':'Queue disable')+'</button>'+
        '<button type="button" class="btn small danger" data-market-action="content-action" data-value="remove" data-id="'+escape(id)+'">Queue removal</button>'
      :'';
    return '<div class="mc-managed-row"><div class="mc-managed-meta"><button type="button" class="mc-project-open" data-market-action="details" data-id="'+escape(id)+'" data-kind="'+escape(record.kind)+'">'+
      escape(record.title||id)+'</button><span>Installed: '+escape(record.version||"Unknown")+
      ' · '+escape(stateLabel)+
      (update?' · Available: '+escape(update.version_number||update.name||"Compatible release"):'')+
      '</span></div><div class="mc-managed-actions">'+
      (update&&!pending&&!action&&record.enabled!==false?
        '<button type="button" class="btn primary small" data-market-action="update-installed" data-id="'+
        escape(id)+'" '+(state.updatingAll?'disabled':'')+'>Queue update</button>':'')+
      (!updatesOnly?commands:'')+'</div></div>';
  }
  async function ensureContentActionsLoaded(force=false){
    if(state.actionBusy||state.actionsLoaded&&!force)return;
    state.actionBusy=true;
    try{
      const actions=await invoke("modrinth_content_actions_list");
      state.contentActions=actions&&typeof actions==="object"?actions:{};
      state.actionsLoaded=true;
      if(active())renderInstalledManager();
    }catch(error){status("Could not load queued plugin actions: "+String(error).slice(0,140),true);}
    finally{state.actionBusy=false;}
  }
  async function loadManagedReleases(force=false){
    if(state.versionLoading)return;
    state.versionLoading=true;
    try{
      const entries=Object.entries(state.inventory.installed||{})
        .filter(([,entry])=>entry?.kind===state.kind).slice(0,40);
      for(const [id,entry] of entries){
        if(!force&&state.latestReleases[id])continue;
        state.latestReleases[id]={pending:true};
        try{
          const candidates=await invoke("modrinth_versions",{projectId:id,kind:entry.kind});
          state.latestReleases[id]=chooseManagedRelease(candidates,entry);
        }catch{state.latestReleases[id]={unavailable:true};}
        if(active())renderInstalledManager();
      }
    }finally{state.versionLoading=false;if(active())renderInstalledManager();}
  }
  async function queueInstalledUpdate(projectId){
    const record=state.inventory.installed?.[projectId];
    const release=compatibleUpdate(projectId,record);
    if(!record||!release||record.enabled===false||state.contentActions[projectId])return;
    if(state.queued[projectId])return;
    await invoke("modrinth_queue_add",{projectId,versionId:release.id,
      kind:record.kind,title:record.title||projectId});
    state.queued[projectId]={versionId:release.id,kind:record.kind,title:record.title||projectId};
    renderInstalled();renderInstalledManager();
  }
  async function updateAll(){
    if(state.updatingAll||state.versionLoading)return;
    const available=Object.entries(state.inventory.installed||{})
      .filter(([id,record])=>record?.kind===state.kind&&record.enabled!==false&&
        !state.queued[id]&&!state.contentActions[id]&&compatibleUpdate(id,record));
    if(!available.length)return status("No verified compatible updates are available.",false);
    if(!window.confirm("Queue "+available.length+" compatible update(s) for the next safe Paper startup? "+
      "Existing plugin data and the last verified backup will be preserved."))return;
    state.updatingAll=true;let success=0,errors=[];
    try{
      for(const [id] of available){
        try{await queueInstalledUpdate(id);success++;}
        catch(error){errors.push(id+": "+String(error).slice(0,75));}
      }
      status(success+" update(s) queued."+(errors.length?" Failed: "+errors.slice(0,3).join("; "):""),Boolean(errors.length));
    }finally{state.updatingAll=false;renderInstalledManager();}
  }
  async function setContentAction(projectId,action){
    const entry=state.inventory.installed?.[projectId];
    if(!entry||entry.kind!=="plugin"||!["enable","disable","remove"].includes(action))return;
    if(!window.confirm("Queue "+action+" for "+(entry.title||projectId)+"?\n\n"+
      "The action applies only at the next safe Paper startup. "+
      (action==="remove"?"The JAR will be removed; plugin configuration data and verified backups remain.":"The plugin JAR is preserved for recovery.")))return;
    try{
      await invoke("modrinth_content_action_set",{projectId,action});
      state.contentActions[projectId]=action;state.actionsLoaded=true;
      status("Plugin "+action+" queued for next server startup.",false);
      renderInstalledManager();renderResults();renderDetail();
    }catch(error){status("Could not queue plugin action: "+String(error).slice(0,160),true);}
  }
  async function cancelContentAction(projectId){
    if(!state.contentActions[projectId])return;
    try{
      await invoke("modrinth_content_action_remove",{projectId});
      delete state.contentActions[projectId];
      renderInstalledManager();renderResults();renderDetail();
      status("Queued plugin action removed. Already applied changes are not reversed.",false);
    }catch(error){status("Could not remove action: "+String(error).slice(0,160),true);}
  }

  async function ensureQueueLoaded(force=false){
    if((state.queueLoaded&&!force)||state.queueBusy)return;
    state.queueBusy=true;
    try{
      const queued=await invoke("modrinth_queue_list");
      state.queued=queued&&typeof queued==="object"?queued:{};
      state.queueLoaded=true;
      if(active()){renderInstalled();renderResults();renderInstalledManager();}
    }catch(e){status("Could not load pending installs: "+String(e).slice(0,150),true)}
    finally{state.queueBusy=false;}
  }
  async function unqueue(projectId){
    if(!state.queued[projectId])return;
    try{
      await invoke("modrinth_queue_remove",{projectId});
      delete state.queued[projectId];
      renderInstalled();renderResults();renderInstalledManager();
      status("Queued install removed.",false);
    }catch(e){status("Could not remove queued install: "+String(e).slice(0,150),true)}
  }
  async function ensureInventoryLoaded(force=false){
    if(state.inventoryBusy || state.inventoryLoaded&&!force&&state.inventoryLive===state.online)return;
    state.inventoryBusy=true;
    try{
      const inventory=await invoke("modrinth_installed_inventory",{live:state.online});
      if(inventory&&typeof inventory==="object"){
        state.inventory={installed:inventory.installed||{},pluginFiles:inventory.pluginFiles||[],datapackFiles:inventory.datapackFiles||[]};
        state.inventoryLoaded=true;state.inventoryLive=state.online;
        if(active()){renderResults();renderInstalledManager();loadLatestReleases();loadManagedReleases();}
      }
    }catch(error){
      // A server may have no backups yet. Browsing Modrinth still works.
      state.inventoryLoaded=false;
      if(active())status("Installed-version check unavailable: "+String(error).slice(0,130),true);
    }finally{state.inventoryBusy=false;}
  }
  async function loadLatestReleases(){
    const records=state.inventory.installed||{};
    const hits=state.hits.filter(item=>records[item.project_id]&&!state.latestReleases[item.project_id]);
    for(const item of hits.slice(0,20)){
      const id=item.project_id;
      if(state.latestReleases[id])continue;
      state.latestReleases[id]={pending:true};
      try{
        const candidates=await invoke("modrinth_versions",{projectId:id,kind:state.kind});
        state.latestReleases[id]=Array.isArray(candidates)?
          candidates.find(v=>v.version_type==="release")||candidates[0]||{unavailable:true}:{unavailable:true};
      }catch{state.latestReleases[id]={unavailable:true};}
      if(active())renderResults();
    }
  }
  async function search() {
    const epoch = ++state.epoch;
    state.loading = true;
    renderResults();
    try {
      const result = await invoke("modrinth_search", {
        query: state.query, kind: state.kind, category: state.category,
        sort: state.sort, version: state.version, loader: state.kind === "plugin" ? state.loader : "",
        offset: state.page * 20
      });
      if (epoch !== state.epoch) return;
      state.hits = Array.isArray(result.hits) ? result.hits : [];
      state.total = Number(result.total_hits) || 0;
      state.loaded = true;
      status("", false);
      loadLatestReleases();
    } catch (error) {
      if (epoch !== state.epoch) return;
      state.hits = [];
      state.total = 0;
      state.loaded = true;
      status("Could not load Modrinth results: " + String(error).slice(0, 160), true);
    } finally {
      if (epoch === state.epoch) {
        state.loading = false;
        renderResults();
      }
    }
  }
  function ensureLoaded() { if (!state.loaded && !state.loading) search(); }
  function setFilter(key, value) {
    clearTimeout(state.searchTimer);
    if (key === "sort") state.sortTouched = true;
    if (key === "kind") {
      state.kind = value;
      state.loader = "";
    } else state[key] = value;
    state.page = 0;
    state.loaded = false;
    state.epoch++;
    if (active()) render(state.online);
    search();
  }
  async function install(projectId) {
    if (state.installing) return;
    if(state.queued[projectId])return status("This project is queued. Use × to remove it before choosing another release.",false);
    if (state.version !== "26.3") return status("Select version 26.3 to install onto this server.", true);
    const candidate = state.hits.find(x => x.project_id === projectId);
    if (!candidate) return;
    state.installing = projectId;
    status(state.online ? "Checking and installing " + candidate.title + "…" : "Checking and queuing " + candidate.title + " for next startup…", false);
    renderResults();
    try {
      const versionsFound = await invoke("modrinth_versions", { projectId, kind: state.kind });
      if (!Array.isArray(versionsFound) || !versionsFound.length)
        throw Error("No verified Paper 26.3 release is available.");
      const version = versionsFound.find(v => v.version_type === "release") || versionsFound[0];
      if (!state.online) {
        await invoke("modrinth_queue_add",{projectId,versionId:version.id,kind:state.kind,title:candidate.title||projectId});
        state.queued[projectId]={versionId:version.id,kind:state.kind,title:candidate.title||projectId};
        status(candidate.title+" queued. It will download directly to Paper after the next verified world restore.", false);
        renderInstalled();
        return;
      }
      const answer = await invoke("direct_command", { kind: "marketplace-install",
        args: { projectId, versionId: version.id, kind: state.kind } });
      if (!answer || !answer.ok || !answer.result || !answer.result.installed)
        throw Error("The server did not confirm installation.");
      const result = answer.result;
      state.installed = state.installed.filter(x => x.projectId !== projectId);
      state.installed.push({ ...result, projectId });
      state.inventory.installed[projectId]={versionId:version.id,kind:state.kind,version:version.version_number,title:candidate.title};
      state.latestReleases[projectId]=version;
      status(result.name + (result.restartRequired ?
        " installed successfully. Use Safe Restart to activate this plugin." :
        " installed successfully. Datapack reload requested."), false);
      renderInstalled();
    } catch (error) {
      status("Installation failed: " + String(error).replace(/^Error:\s*/, "").slice(0, 220), true);
    } finally {
      state.installing = "";
      renderResults();
    }
  }

  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-market-action]");
    if (!el || !active()) return;
    event.preventDefault();
    const action = el.dataset.marketAction;
    const value = el.dataset.value || "";
    if (["kind", "category", "version", "loader"].includes(action)) setFilter(action, value);
    if (action === "reset") {
      state.query = ""; state.category = ""; state.version = "26.3";
      state.loader = ""; state.sort = "downloads"; state.sortTouched = false; state.page = 0;
      state.epoch++; state.loaded = false;
      render(state.online); search();
    }
    if (action === "install") install(el.dataset.id);
    if (action === "unqueue") unqueue(el.dataset.id);
    if (action === "refresh-installed"){state.latestReleases={};ensureInventoryLoaded(true);}
    if (action === "tab"){state.tab=value;render(state.online);if(value!=="browse")loadManagedReleases();return;}
    if (action === "update-installed") queueInstalledUpdate(el.dataset.id).catch(e=>status("Could not queue update: "+String(e).slice(0,160),true));
    if (action === "update-all") updateAll();
    if (action === "content-action") setContentAction(el.dataset.id,value);
    if (action === "cancel-content") cancelContentAction(el.dataset.id);
    if (action === "previous" && state.page > 0) {
      state.page--; search();
      root()?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (action === "next" && (state.page + 1) * 20 < state.total) {
      state.page++; search();
      root()?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target.id !== "mc-market-query" || !active()) return;
    state.query = event.target.value.slice(0, 100);
    state.page = 0;
    if (!state.sortTouched) {
      state.sort = state.query ? "relevance" : "downloads";
      const select = document.getElementById("mc-market-sort");
      if (select) select.value = state.sort;
    }
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(search, 400);
  });
  document.addEventListener("change", (event) => {
    if (event.target.id !== "mc-market-sort" || !active()) return;
    setFilter("sort", event.target.value);
  });
  document.addEventListener("submit", (event) => {
    if (event.target.id !== "mc-market-search-form" || !active()) return;
    event.preventDefault();
    clearTimeout(state.searchTimer);
    state.query = document.getElementById("mc-market-query").value.slice(0, 100);
    state.page = 0;
    if (!state.sortTouched) {
      state.sort = state.query ? "relevance" : "downloads";
      const select = document.getElementById("mc-market-sort");
      if (select) select.value = state.sort;
    }
    search();
  });
  window.McMarketplace = { render, ensureLoaded,
    refreshQueueState:()=>Promise.all([ensureQueueLoaded(true),ensureContentActionsLoaded(true)]) };
})();
