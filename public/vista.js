/* ============================================================
   VISTA MULTI-PRÉDIO — protótipo SCIENT
   Constrói a vista de prédios a partir dos DEALS reais do grafo.
   Abre a partir do detalhe de um Edifício ("Ver Vista Multi-Prédio").
   ============================================================ */
(function(){
'use strict';

const drawer = document.getElementById('vista-drawer');
const host   = document.getElementById('vd-host');
const pinEl  = document.getElementById('vd-pin');
const nomeEl = document.getElementById('vd-nome');
const metaEl = document.getElementById('vd-meta');
const stylesEl = document.getElementById('vd-styles');
const legendEl2 = document.getElementById('vd-legend');

const STAGE_COLORS = {
  'Recebido no Núcleo':              '#AACCE0',
  'Diagnóstico / Briefing / Test Fit':'#5BAEF0',
  'Estratégia Definida':             '#9650DC',
  'Proposta em Elaboração':          '#E0A800',
  'Proposta Apresentada':            '#E07800',
  'Em Negociação / Short List':      '#DC5028',
  'Go/No-Go 2 — Aprovação (Ivo)':   '#B83060',
  'Ganho — Preparo do Processo':     '#00AA50',
  'Contrato Assinado':               '#00585C',
  'Perdido':                         '#888888',
  'Declinado':                       '#BBBBBB',
};
const CLIENT_PALETTE = ['#3278DC','#9650DC','#E63232','#00AA50','#E0A800','#00585C','#DC6432','#3232AA'];
const clientColor = {};
function rebuildClientColor(){
  // chamado em openVista() para garantir que DEALS já tem os dados reais do HubSpot
  const clients = [...new Set(DEALS.map(d=>d.cliente).filter(Boolean))];
  clients.forEach((c,i)=>{ if(!clientColor[c]) clientColor[c]=CLIENT_PALETTE[i%CLIENT_PALETTE.length]; });
}

// Estilo único: Corte 2.5D (visualização 3D isométrica)
const STYLES = {
  corte: { label:'Corte 2.5D', body:'#EDF1F1', stroke:'#B7C3C3', sw:1, fl:'rgba(14,26,26,.10)', hatch:false, ground:'#2A3333', gw:3, depth:true }
};
let styleKey = 'corte';
let focalEd = null;   // label do edifício focal
let pinned = null;    // deal id fixado
// cache de model+conns por focalEd — evita recomputar O(n²) em re-renders visuais
let _modelCache = null;  // { ed, model, conns }
function getModelConns(){
  if(_modelCache&&_modelCache.ed===focalEd) return _modelCache;
  const model = buildModel(focalEd);
  const conns = buildConns(model);
  _modelCache = { ed:focalEd, model, conns };
  return _modelCache;
}

function andarNum(a){ const m = a && a.match(/(\d+)/); return m ? +m[1] : null; }
function ink(hex){
  const n=parseInt(hex.slice(1),16), r=n>>16, g=(n>>8)&255, b=n&255;
  return (r*.299+g*.587+b*.114)>150 ? '#0E1A1A' : '#FFF';
}
function esc(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtVShort(v){ if(!v) return null; if(v>=1000000) return (v/1000000).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'M'; return (v/1000).toFixed(0)+'k'; }

/* ---- modelo: prédios + deals com andar ---- */
// Vínculo entre prédios (cliente OU dono OU broker OU gerenciadora), com peso
// por força da relação. Teto pra um vínculo onipresente (broker) não inundar.
const REL_CAP = 8;
const REL_WEIGHT = { cliente:100, dono:40, broker:10, gerenciadora:8 };

function buildModel(focal){
  const byEd = {};
  DEALS.forEach(d=>{
    const n = andarNum(d.andar);
    if(n==null) return;
    (byEd[d.edificio] = byEd[d.edificio]||[]).push(Object.assign({}, d, { n }));
  });
  const focalDeals = byEd[focal]||[];
  const fSet = k => new Set(focalDeals.map(d=>d[k]).filter(Boolean));
  const focalBy = { cliente:fSet('cliente'), dono:fSet('dono'), broker:fSet('broker'), gerenciadora:fSet('gerenciadora') };
  // pontua cada outro prédio pela força do vínculo com o focal
  const scored = Object.keys(byEd).filter(ed=>ed!==focal).map(ed=>{
    const ds = byEd[ed];
    let score = 0;
    Object.keys(REL_WEIGHT).forEach(k=>{ if(ds.some(d=>d[k]&&focalBy[k].has(d[k]))) score += REL_WEIGHT[k]; });
    return { ed, score };
  }).filter(x=>x.score>0)
    .sort((a,b)=> b.score-a.score || byEd[b.ed].length-byEd[a.ed].length);
  const rel = scored.slice(0, REL_CAP);
  // focal primeiro, relacionados à direita (scroll horizontal revela o resto)
  const order = [{ed:focal}, ...rel.map(r=>({ed:r.ed}))];
  const model = order.map(o=>{
    const deals = byEd[o.ed];
    const donos = [...new Set(deals.map(d=>d.dono).filter(Boolean))];
    return { ed:o.ed, ctx:false, deals, dono: donos.join(' / ')||'—', focal:o.ed===focal };
  });
  model.hiddenRel = Math.max(0, scored.length - rel.length);
  return model;
}

const CLOSED_STAGES = ['Ganho — Preparo do Processo','Contrato Assinado'];
// vínculo mais forte entre dois deals (cliente > dono > broker > gerenciadora)
function pairLink(fd, od){
  if(fd.cliente && od.cliente===fd.cliente)           return { kind:'cliente',      via:fd.cliente };
  if(fd.dono && od.dono===fd.dono)                     return { kind:'dono',         via:fd.dono };
  if(fd.broker && od.broker===fd.broker)               return { kind:'broker',       via:fd.broker };
  if(fd.gerenciadora && od.gerenciadora===fd.gerenciadora) return { kind:'gerenciadora', via:fd.gerenciadora };
  return null;
}
const LINK_LABEL = { cliente:'Mesmo cliente', dono:'Mesmo dono', broker:'Mesmo broker', gerenciadora:'Mesma gerenciadora' };

function buildConns(model){
  const conns = [];
  // Para cada par (focal-deal, outro-deal), guarda o vínculo mais forte encontrado
  // por par de edifícios (focal → ed), evitando linhas sobrepostas.
  const focal = model.find(m=>m.focal);
  model.forEach(m=>{
    if(m.focal) return;
    // Melhor vínculo entre qualquer fd do focal e qualquer od do prédio m
    let bestLink=null, bestFd=null, bestOd=null;
    focal.deals.forEach(fd=>{
      m.deals.forEach(od=>{
        const link = pairLink(fd, od);
        if(!link) return;
        // prioridade: menor índice em REL_WEIGHT keys = maior peso
        if(!bestLink || Object.keys(REL_WEIGHT).indexOf(link.kind) < Object.keys(REL_WEIGHT).indexOf(bestLink.kind)){
          bestLink=link; bestFd=fd; bestOd=od;
        }
      });
    });
    if(!bestLink) return;
    const dashed = !CLOSED_STAGES.includes(bestOd.stage) && !CLOSED_STAGES.includes(bestFd.stage);
    conns.push({
      kind:bestLink.kind, via:bestLink.via,
      cliente: bestLink.kind==='cliente' ? bestLink.via : null,
      a:{ed:focal.ed,n:bestFd.n,id:bestFd.id}, b:{ed:m.ed,n:bestOd.n,id:bestOd.id},
      dashed, anot: LINK_LABEL[bestLink.kind]+' · '+bestLink.via, ctx:m.ctx
    });
  });
  return conns;
}

/* ---- render ---- */
const SVGH=610, GROUND=536, TOP=40;

// Cores dos rótulos — barras coloridas dentro do andar
const ROLE_BARS=[
  {key:'broker',      color:'#00585C'},
  {key:'gerenciadora',color:'#9650DC'},
  {key:'dono',        color:'#C8940A'},
  {key:'parceiro',    color:'#DC5028'},
  {key:'concorrente', color:'#888888'},
];
const TIPO_BADGE={
  'Projeto':         {label:'P',   bg:'#00585C'},
  'Obra':            {label:'O',   bg:'#E07800'},
  'Projeto e Obra':  {label:'P+O', bg:'#9650DC'},
};

function render(){
  const S = STYLES[styleKey];
  const { model, conns } = getModelConns();

  // Compacto: só andares ocupados, altura fixa por slot
  const maxOccupied = Math.max(...model.map(m=>m.deals.length), 1);
  const FH = Math.min(58, Math.floor((GROUND-TOP)/maxOccupied));

  // Slot map: por edifício, mapeia dealId → posição vertical (0 = andar mais baixo)
  const slotMap={};
  model.forEach(m=>{
    const sorted=[...m.deals].sort((a,b)=>a.n-b.n);
    slotMap[m.ed]={};
    sorted.forEach((d,i)=>{ slotMap[m.ed][d.id]=i; });
  });
  const centY=(ed,did)=>GROUND-(slotMap[ed][did]+0.5)*FH;

  const GAP = 48;
  const PAD = 40;
  const widths = model.map(m=>m.focal?220:160);
  const totalW = widths.reduce((a,c)=>a+c,0)+(model.length-1)*GAP;
  const SVGW = Math.max(860, totalW + PAD*2);
  let cx = PAD;
  const geo={};
  model.forEach((m,i)=>{ geo[m.ed]={x:cx,w:widths[i],i}; cx+=widths[i]+GAP; });
  const dxo=10, dyo=7;

  let svg='', ov='';
  const px = v=>(v/SVGW*100).toFixed(3), py = v=>(v/SVGH*100).toFixed(3);

  // patterns (hachura)
  if(S.hatch){
    const cols=[...new Set(model.flatMap(m=>m.deals.map(d=>STAGE_COLORS[d.stage]||'#5BAEF0')))];
    svg+='<defs>'+cols.map(c=>
      `<pattern id="vh-${c.slice(1)}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="${c}" fill-opacity="0.10"></rect>
        <line x1="0" y1="0" x2="0" y2="6" stroke="${c}" stroke-width="1.6" stroke-opacity="0.55"></line>
      </pattern>`).join('')+'</defs>';
  }
  svg+=`<rect x="0" y="0" width="${SVGW}" height="${SVGH}" fill="transparent" data-clear="1"></rect>`;

  const STAGE_ABBR={
    'Recebido no Núcleo':'Recebido','Diagnóstico / Briefing / Test Fit':'Diag./TF',
    'Estratégia Definida':'Estratégia','Proposta em Elaboração':'Prop. Elab.',
    'Proposta Apresentada':'Proposta','Em Negociação / Short List':'Short List',
    'Go/No-Go 2 — Aprovação (Ivo)':'Go/No-Go','Ganho — Preparo do Processo':'Ganho',
    'Contrato Assinado':'Contrato','Perdido':'Perdido','Declinado':'Declinado',
  };

  model.forEach(m=>{
    const g=geo[m.ed], op=m.ctx?0.5:1;
    const nSlots=m.deals.length;
    const topY=GROUND-nSlots*FH, h=nSlots*FH;
    svg+=`<g opacity="${op}">`;
    if(S.depth){
      svg+=`<polygon points="${g.x},${topY} ${g.x+dxo},${topY-dyo} ${g.x+g.w+dxo},${topY-dyo} ${g.x+g.w},${topY}" fill="#D8DFDF" stroke="#B7C3C3" stroke-width="1"></polygon>`;
      svg+=`<polygon points="${g.x+g.w},${topY} ${g.x+g.w+dxo},${topY-dyo} ${g.x+g.w+dxo},${GROUND-dyo} ${g.x+g.w},${GROUND}" fill="#CBD4D4" stroke="#B7C3C3" stroke-width="1"></polygon>`;
    }
    const bcur=m.focal?'default':'pointer';
    svg+=`<rect x="${g.x}" y="${topY}" width="${g.w}" height="${h}" fill="${S.body}" stroke="${S.stroke}" stroke-width="${S.sw}" ${m.focal?'':`data-focus="${esc(m.ed)}"`} style="cursor:${bcur}"></rect>`;
    // divisórias entre slots (só entre andares ocupados)
    for(let i=1;i<nSlots;i++){
      const y=GROUND-i*FH;
      svg+=`<line x1="${g.x}" y1="${y}" x2="${g.x+g.w}" y2="${y}" stroke="${S.fl}" stroke-width="1" pointer-events="none"></line>`;
    }
    m.deals.forEach(d=>{
      const slot=slotMap[m.ed][d.id];
      const col=STAGE_COLORS[d.stage]||'#5BAEF0';
      const isPin=pinned===d.id;
      const fill=S.hatch?`url(#vh-${col.slice(1)})`:col;
      const floorY=GROUND-(slot+1)*FH+0.5;
      svg+=`<rect x="${g.x+1}" y="${floorY}" width="${g.w-2}" height="${FH-1}"
        fill="${fill}" fill-opacity="${S.hatch?1:0.88}"
        stroke="${isPin?'#00DEDB':(S.hatch?col:'none')}" stroke-width="${isPin?2.5:(S.hatch?1:0)}"
        data-deal="${d.id}" style="cursor:pointer"></rect>`;
      const roles=ROLE_BARS.filter(r=>d[r.key]);
      roles.forEach((r,ri)=>{
        svg+=`<rect x="${g.x+2+ri*7}" y="${floorY+FH-7}" width="5" height="4" fill="${r.color}" rx="1" opacity="0.9" pointer-events="none"></rect>`;
      });
      const lcol=S.hatch?'#0E1A1A':ink(col);
      const cy=centY(m.ed,d.id);
      const label=d.cliente||d.nome||'—';
      const short=g.w<130?label.split(' ')[0]:(g.w<160?label.split(' ').slice(0,2).join(' '):label);
      const stageLbl=STAGE_ABBR[d.stage]||d.stage;
      const hasDono=d.dono&&FH>30;
      const textY=hasDono?cy-FH*0.14:cy;
      // badge tipo — canto superior esquerdo
      if(d.tipo&&TIPO_BADGE[d.tipo]&&FH>26){
        const tb=TIPO_BADGE[d.tipo];
        ov+=`<div style="left:${px(g.x+3)}%;top:${py(floorY+3)}%;background:${tb.bg};color:#fff;font-size:6px;font-family:var(--font-mono);font-weight:700;padding:0 3px;border-radius:2px;line-height:1.6;opacity:${op*0.9}">${tb.label}</div>`;
      }
      if(!m.ctx||g.w>=130) ov+=`<div style="left:${px(g.x+6)}%;top:${py(textY)}%;transform:translateY(-50%);font-size:${g.w>=160?9.5:8.5}px;font-weight:600;color:${lcol};opacity:${op}">${esc(short)}</div>`;
      if(hasDono&&(!m.ctx||g.w>=130)){
        const donoShort=g.w<140?d.dono.split(' ')[0]:d.dono;
        ov+=`<div style="left:${px(g.x+6)}%;top:${py(cy+FH*0.18)}%;transform:translateY(-50%);font-size:7.5px;font-style:italic;color:${lcol};opacity:${op*0.6};white-space:nowrap;overflow:hidden;max-width:${g.w*0.6}px">${esc(donoShort)}</div>`;
      }
      const pillBg=S.hatch?'rgba(255,255,255,0.55)':col;
      const pillCol=S.hatch?'#0E1A1A':ink(col);
      ov+=`<div style="left:${px(g.x+g.w-5)}%;top:${py(cy)}%;transform:translate(-100%,-50%);background:${pillBg};color:${pillCol};font-size:${g.w>=160?7.5:7}px;font-family:var(--font-mono);font-weight:700;letter-spacing:.3px;text-transform:uppercase;padding:1px 5px;border-radius:2px;opacity:${.92*op}">${esc(stageLbl)}</div>`;
      // badge contatos — canto superior direito
      if(d.contatos&&d.contatos.length&&FH>26){
        ov+=`<div style="left:${px(g.x+g.w-4)}%;top:${py(floorY+3)}%;transform:translate(-100%,0);background:rgba(14,26,26,.22);color:#fff;font-size:6px;font-family:var(--font-mono);padding:0 3px;border-radius:2px;line-height:1.6;opacity:${op*0.85}">●${d.contatos.length}</div>`;
      }
      const vShort = fmtVShort(d.valor);
      if(vShort){
        ov+=`<div style="left:${px(g.x-5)}%;top:${py(cy)}%;transform:translate(-100%,-50%);font-size:8px;font-family:var(--font-mono);color:#00585C;font-weight:700;opacity:${op};white-space:nowrap">${esc(vShort)}</div>`;
      } else {
        ov+=`<div style="left:${px(g.x-7)}%;top:${py(cy)}%;transform:translate(-100%,-50%);font-size:8.5px;font-family:var(--font-mono);color:rgba(14,26,26,.5);opacity:${op}">${d.n}º</div>`;
      }
    });
    // colchete de mesmo-dono
    const donoGroups={};
    m.deals.forEach(d=>{ if(d.dono){ (donoGroups[d.dono]=donoGroups[d.dono]||[]).push(d); } });
    Object.entries(donoGroups).forEach(([dono,ds])=>{
      if(ds.length<2) return;
      const slots=ds.map(d=>slotMap[m.ed][d.id]);
      const topSlot=Math.max(...slots), botSlot=Math.min(...slots);
      const y1=GROUND-(topSlot+1)*FH+4, y2=GROUND-botSlot*FH-4;
      const bx=g.x+g.w+5;
      svg+=`<line x1="${bx}" y1="${y1}" x2="${bx}" y2="${y2}" stroke="#C8940A" stroke-width="1.5" opacity="${op*0.8}" pointer-events="none"></line>`;
      svg+=`<line x1="${bx}" y1="${y1}" x2="${bx+5}" y2="${y1}" stroke="#C8940A" stroke-width="1.5" opacity="${op*0.8}" pointer-events="none"></line>`;
      svg+=`<line x1="${bx}" y1="${y2}" x2="${bx+5}" y2="${y2}" stroke="#C8940A" stroke-width="1.5" opacity="${op*0.8}" pointer-events="none"></line>`;
      const lbl=dono.length>12?dono.slice(0,11)+'…':dono;
      ov+=`<div style="left:${px(bx+8)}%;top:${py((y1+y2)/2)}%;transform:translateY(-50%);font-size:7px;color:#C8940A;font-weight:600;white-space:nowrap;opacity:${op}">${esc(lbl)}</div>`;
    });
    ov+=`<div data-focus="${esc(m.ed)}" style="left:${px(g.x+g.w/2)}%;top:${py(GROUND+16)}%;transform:translate(-50%,-50%);font-size:11px;font-weight:${m.focal?700:600};color:${m.focal?'#0E1A1A':'#3a4a4a'};opacity:${op};${m.focal?'':'pointer-events:auto;cursor:pointer'}">${esc(m.ed)}</div>`;
    if(m.focal) svg+=`<rect x="${g.x+g.w/2-20}" y="${GROUND+37}" width="40" height="2.5" fill="#00DEDB"></rect>`;
    svg+='</g>';
  });


  // chão + árvores
  svg+=`<line x1="${PAD/2}" y1="${GROUND}" x2="${SVGW-PAD/2}" y2="${GROUND}" stroke="${S.ground}" stroke-width="${S.gw}"></line>`;
  const txs=[];
  for(let i=0;i<model.length-1;i++){ const g1=geo[model[i].ed]; txs.push(g1.x+g1.w+GAP/2); }
  const g0=geo[model[0].ed], gl=geo[model[model.length-1].ed];
  txs.push(g0.x-28, gl.x+gl.w+28);
  txs.forEach((tx,i)=>{ const s=i%2?0.8:1.1;
    svg+=`<g opacity="0.72"><line x1="${tx}" y1="${GROUND}" x2="${tx}" y2="${GROUND-11*s}" stroke="#2A3333" stroke-width="1.5"></line><circle cx="${tx}" cy="${GROUND-15*s}" r="${5.5*s}" fill="#2A3333"></circle></g>`;
  });

  // conexões
  conns.forEach((c,ci)=>{
    const ga=geo[c.a.ed], gb=geo[c.b.ed];
    const aC=ga.x+ga.w/2, bC=gb.x+gb.w/2;
    let x1,x2;
    if(aC<bC){ x1=ga.x+ga.w; x2=gb.x; } else { x1=ga.x; x2=gb.x+gb.w; }
    if(S.depth && aC<bC) x1+=dxo;
    const y1=centY(c.a.ed,c.a.id), y2=centY(c.b.ed,c.b.id);
    const lift = Math.abs(ga.i-gb.i)>1 ? 58 : 0;
    const dxc=(x2-x1)*.4;
    const d=`M${x1},${y1} C${x1+dxc},${y1-lift} ${x2-dxc},${y2-lift} ${x2},${y2}`;
    const mx=(x1+3*(x1+dxc)+3*(x2-dxc)+x2)/8, my=(y1+3*(y1-lift)+3*(y2-lift)+y2)/8;
    const col = c.kind==='cliente' ? (clientColor[c.via]||'#3278DC')
              : c.kind==='dono'    ? '#C8940A'
              : c.kind==='broker'  ? '#00585C'
              : '#9650DC';
    svg+=`<path d="${d}" fill="none" stroke="${col}" stroke-width="1.8" ${c.dashed?'stroke-dasharray="6 5"':''} opacity="0.55" stroke-linecap="round" data-conn="${ci}" data-conn-a="${c.a.id}" data-conn-b="${c.b.id}"></path>`;
    svg+=`<path d="${d}" fill="none" stroke="transparent" stroke-width="14" data-connhit="${ci}" style="cursor:pointer"></path>`;
    ov+=`<div style="left:${px(mx)}%;top:${py(my)}%;transform:translate(-50%,-50%);font-size:8.5px;font-family:var(--font-mono);color:#3a4a4a;background:#fff;border:1px solid rgba(14,26,26,.2);padding:2px 7px;border-radius:2px;opacity:1;display:none" data-connbadge="${ci}">${esc(c.anot)}</div>`;
  });

  host.style.overflowX = 'auto';
  host.innerHTML =
    `<div style="position:relative;width:${SVGW}px;height:${SVGH}px;flex-shrink:0">
       <svg width="${SVGW}" height="${SVGH}" viewBox="0 0 ${SVGW} ${SVGH}" style="display:block;position:absolute;top:0;left:0">${svg}</svg>
       <div style="position:absolute;inset:0;pointer-events:none;font-family:var(--font-head)">
         ${ov.replace(/<div /g,'<div class="vd-ov" ').replace(/style="/g,'style="position:absolute;white-space:nowrap;line-height:1.2;')}
       </div>
       <div class="vd-tip" id="vd-tip"></div>
     </div>`;

  // header
  const focal = model.find(m=>m.focal);
  nomeEl.textContent = focal.ed;
  const relCount = model.length-1;
  metaEl.textContent = `Proprietário: ${focal.dono} · ${focal.deals.length} deal(s) no prédio · ${relCount} prédio(s) relacionado(s)`
    + (model.hiddenRel ? ` (+${model.hiddenRel} ocultos)` : '')
    + ` · ${conns.length} conexão(ões)`;

  // interações
  const tip = document.getElementById('vd-tip');
  function showConns(dealId){
    host.querySelectorAll('[data-conn]').forEach(p=>{
      const active = p.dataset.connA===dealId||p.dataset.connB===dealId;
      p.setAttribute('opacity', active ? (p.getAttribute('stroke-dasharray')?'0.85':'0.95') : '0.15');
    });
    host.querySelectorAll('[data-connbadge]').forEach(b=>{ b.style.display='none'; });
  }
  function hideConns(){
    if(pinned) return;
    host.querySelectorAll('[data-conn]').forEach(p=>p.setAttribute('opacity','0.55'));
    host.querySelectorAll('[data-connbadge]').forEach(b=>{ b.style.display='none'; });
  }

  host.querySelectorAll('[data-deal]').forEach(r=>{
    const d = DEALS.find(x=>x.id===r.dataset.deal);
    r.addEventListener('mouseenter', e=>{
      showConns(d.id);
      const hr=host.getBoundingClientRect(), rr=r.getBoundingClientRect();
      let x=rr.right-hr.left+12;
      if(x>hr.width-270) x=rr.left-hr.left-272;
      if(x<4) x=4;
      const y=Math.max(6,Math.min(rr.top-hr.top-8, hr.height-300));
      const col=STAGE_COLORS[d.stage]||'#5BAEF0';
      tip.style.transform=`translate(${x}px,${y}px)`;
      tip.style.display='block';
      tip.innerHTML=`
        <div class="vd-tr"><span class="vd-stage" style="background:${col};color:${ink(col)}">${esc(d.stage)}</span><span class="vd-tf">${esc(d.andar||'')}</span>${d.conjunto?`<span class="vd-tf">Conj. ${esc(d.conjunto)}</span>`:''}</div>
        <div class="vd-td">${esc(d.nome)}</div>
        <div class="vd-tm">${esc(d.edificio)}</div>
        <div class="vd-tg">
          <span>Broker</span><b>${esc(d.broker||'—')}</b>
          <span>Gerenciadora</span><b>${esc(d.gerenciadora||'—')}</b>
          <span>Dono do andar</span><b>${esc(d.dono||'—')}</b>
          ${d.tipo?`<span>Tipo</span><b style="color:${(TIPO_BADGE[d.tipo]||{bg:'#333'}).bg}">${esc(d.tipo)}</b>`:''}
          ${d.contatos&&d.contatos.length?`<span>Contatos</span><b>${d.contatos.map(c=>esc(c.nome)+(c.cargo?` <span style="opacity:.6;font-weight:400">· ${esc(c.cargo)}</span>`:'')).join('<br>')}</b>`:''}
        </div>
        ${d.concorrente?`<div class="vd-tn">▲ Concorrente no deal: ${esc(d.concorrente)}</div>`:''}
        <div class="vd-th">clique para fixar os detalhes · Abrir no HubSpot ↗</div>`;
    });
    r.addEventListener('mouseleave', ()=>{ tip.style.display='none'; hideConns(); });
    r.addEventListener('click', ()=>{ pinned = pinned===d.id?null:d.id; render(); });
  });
  host.querySelectorAll('[data-focus]').forEach(el=>{
    el.addEventListener('click', ()=>{ focalEd=el.dataset.focus; pinned=null; _modelCache=null; render(); const _en=NODES&&NODES.find(n=>n.type==='edificio'&&n.label===focalEd); if(typeof updateTableFromNode==='function') updateTableFromNode(_en||null); });
  });
  host.querySelector('[data-clear]').addEventListener('click', ()=>{ if(pinned){ pinned=null; render(); } });
  host.querySelectorAll('[data-connhit]').forEach(p=>{
    const ci=p.dataset.connhit;
    const line=host.querySelector(`[data-conn="${ci}"]`);
    const badge=host.querySelector(`[data-connbadge="${ci}"]`);
    p.addEventListener('mouseenter',()=>{ line.setAttribute('stroke-width','2.6'); if(badge){badge.style.display='block';badge.style.borderColor=line.getAttribute('stroke');} });
    p.addEventListener('mouseleave',()=>{ line.setAttribute('stroke-width','1.2'); if(badge){badge.style.display='none';} });
  });

  if(pinned) showConns(pinned);
  renderPin();
  renderLegend(model, conns);
}

function renderPin(){
  if(!pinned){ pinEl.innerHTML=''; return; }
  const d=DEALS.find(x=>x.id===pinned);
  const col=STAGE_COLORS[d.stage]||'#5BAEF0';
  pinEl.innerHTML=`<div class="vd-pinbox">
    <div class="vd-pinl">
      <span class="vd-stage" style="background:${col};color:${ink(col)}">${esc(d.stage)}</span>
      <div class="vd-pind">${esc(d.nome)}</div>
      <div class="vd-pinm">${esc(d.edificio)} · ${esc(d.andar||'')}</div>
    </div>
    <div class="vd-kv">
      <div><div class="vd-kl">Cliente</div><div class="vd-kvv">${esc(d.cliente)}</div></div>
      <div><div class="vd-kl">Broker</div><div class="vd-kvv">${esc(d.broker||'—')}</div></div>
      <div><div class="vd-kl">Gerenciadora</div><div class="vd-kvv">${esc(d.gerenciadora||'—')}</div></div>
      <div><div class="vd-kl">Dono do andar</div><div class="vd-kvv">${esc(d.dono||'—')}</div></div>
      ${d.tipo?`<div><div class="vd-kl">Tipo</div><div class="vd-kvv" style="color:${(TIPO_BADGE[d.tipo]||{bg:'#333'}).bg}">${esc(d.tipo)}</div></div>`:''}
      ${d.conjunto?`<div><div class="vd-kl">Conjunto</div><div class="vd-kvv">${esc(d.conjunto)}</div></div>`:''}
      ${d.contatos&&d.contatos.length?`<div style="grid-column:1/-1"><div class="vd-kl">Contatos</div><div class="vd-kvv">${d.contatos.map(c=>`<div style="margin-bottom:3px">${esc(c.nome)}${c.cargo?`<span style="color:rgba(14,26,26,.45);font-size:10px"> · ${esc(c.cargo)}</span>`:''}</div>`).join('')}</div></div>`:''}
      <div><div class="vd-kl">Nota</div><div class="vd-kvv" style="color:#6b5200">${esc(d.concorrente?('Concorrente: '+d.concorrente):(d.parceiro?('Parceiro: '+d.parceiro):'—'))}</div></div>
    </div>
    <div class="vd-pinbtns">
      <button class="vd-hs">Abrir no HubSpot ↗</button>
      <button class="vd-x" id="vd-unpin">fechar detalhe</button>
    </div>
  </div>`;
  document.getElementById('vd-unpin').onclick=()=>{ pinned=null; render(); };
}

const LINK_LEG = { dono:{c:'#C8940A',l:'mesmo dono'}, broker:{c:'#00585C',l:'mesmo broker'}, gerenciadora:{c:'#9650DC',l:'mesma gerenc.'} };
function renderLegend(model, conns){
  const clients=[...new Set(conns.filter(c=>c.kind==='cliente').map(c=>c.via))];
  const kinds=[...new Set(conns.map(c=>c.kind))].filter(k=>k!=='cliente');
  // Exibe apenas as barras de papel (ROLE_BARS) que aparecem nos deals visíveis
  const activeRoles=ROLE_BARS.filter(r=>model.some(m=>m.deals.some(d=>d[r.key])));
  legendEl2.innerHTML =
    clients.map(c=>`<span><i style="background:${clientColor[c]||'#3278DC'}"></i>${esc(c)}</span>`).join('') +
    kinds.map(k=>`<span><svg width="26" height="6" viewBox="0 0 26 6"><line x1="0" y1="3" x2="26" y2="3" stroke="${LINK_LEG[k].c}" stroke-width="2.4"></line></svg>${LINK_LEG[k].l}</span>`).join('') +
    `<span><svg width="26" height="6" viewBox="0 0 26 6"><line x1="0" y1="3" x2="26" y2="3" stroke="#3a4a4a" stroke-width="1.6"></line></svg>ganho / contrato</span>
     <span><svg width="26" height="6" viewBox="0 0 26 6"><line x1="0" y1="3" x2="26" y2="3" stroke="#3a4a4a" stroke-width="1.6" stroke-dasharray="5 4"></line></svg>em negociação</span>` +
    (activeRoles.length ? '<span class="vd-dim" style="margin-left:6px">barras no andar: </span>'
      + activeRoles.map(r=>`<span><i style="background:${r.color}"></i>${r.key}</span>`).join('') : '') +
    `<span class="vd-dim">cor da laje = etapa · linha = vínculo entre prédios</span>`;
}

/* ---- abrir / fechar ---- */
function openVista(edLabel){
  focalEd=edLabel; pinned=null; _modelCache=null;
  rebuildClientColor();
  drawer.style.display='flex';
  render();
  window.dispatchEvent(new Event('resize'));
  const _en=NODES&&NODES.find(n=>n.type==='edificio'&&n.label===edLabel);
  if(typeof updateTableFromNode==='function') updateTableFromNode(_en||null);
}
function closeVista(){
  drawer.style.display='none';
  window.dispatchEvent(new Event('resize'));
}
document.getElementById('vd-back').onclick=()=>{ closeVista(); if(typeof updateTableFromNode==='function') updateTableFromNode(null); };

/* ---- abrir direto ao clicar num nó de Edifício ou Andar no grafo ---- */
const _selectNode = selectNode;
selectNode = function(id, center, skipVista){
  _selectNode(id, center);
  if(skipVista) return;
  const n = nodesMap.get(id);
  if(!n) return;
  let ed = null;
  if(n.type==='edificio') ed = n.label;
  else if(n.type==='andar') ed = n.meta && n.meta.edificio;
  if(ed && DEALS.some(d=>d.edificio===ed && andarNum(d.andar)!=null)){
    openVista(ed);
  } else {
    closeVista();
  }
};

/* ---- gancho no painel de detalhe: botão no detalhe de Edifício ---- */
const _renderDetail = renderDetail;
renderDetail = function(id){
  _renderDetail(id);
  if(!id) return;
  const n=nodesMap.get(id);
  if(n && n.type==='edificio'){
    const hasFloors = DEALS.some(d=>d.edificio===n.label && andarNum(d.andar)!=null);
    if(!hasFloors) return;
    const btn=document.createElement('button');
    btn.textContent='Ver Vista Multi-Prédio →';
    btn.style.cssText='width:100%;background:var(--tiffany,#00DEDB);color:#0E1A1A;border:none;border-radius:3px;padding:11px 14px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;margin-top:12px;';
    btn.onmouseenter=()=>btn.style.background='#3FE9E6';
    btn.onmouseleave=()=>btn.style.background='var(--tiffany,#00DEDB)';
    btn.onclick=()=>openVista(n.label);
    const panel=document.getElementById('detail-panel');
    const badge=panel.querySelector('.node-badge');
    (badge?badge.parentNode:panel).insertBefore(btn, panel.querySelector('.conn-group'));
  }
};
})();
