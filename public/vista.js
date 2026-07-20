/* ============================================================
   VISTA MULTI-PRÉDIO — protótipo SCIENT
   Constrói a vista de prédios a partir dos DEALS reais do grafo.
   Abre a partir do detalhe de um Edifício ("Ver Vista Multi-Prédio").
   ============================================================ */
(function(){
'use strict';

const drawer    = document.getElementById('vista-drawer');
const host      = document.getElementById('vd-host');
const pinEl     = document.getElementById('vd-pin');
const nomeEl    = document.getElementById('vd-nome');
const metaEl    = document.getElementById('vd-meta');
const filterEl  = document.getElementById('vd-filter');
const stylesEl  = document.getElementById('vd-styles');
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
// filtro por ator: { kind:'cliente'|'broker'|'gerenciadora', value:'Grupo Primo' }
let actorFilter = null;
// cache de model+conns por focalEd — evita recomputar O(n²) em re-renders visuais
let _modelCache = null;  // { ed, model, conns }
// mapa de todos os deals do model atual (incluindo merged): id → deal
let _modelDealMap = {};
function getModelConns(){
  if(_modelCache&&_modelCache.ed===focalEd) return _modelCache;
  const model = buildModel(focalEd);
  const conns = buildConns(model);
  _modelCache = { ed:focalEd, model, conns };
  return _modelCache;
}

function andarNum(a){ const m = a && a.match(/(\d+)/); return m ? +m[1] : null; }
// Número legível do andar: usa andares[0].numero se existir,
// senão tenta o nome do objeto Andar, senão d.andar texto legado.
// Rejeita IDs HubSpot (>5 dígitos consecutivos) como número de andar.
function andarDisplay(d){
  for(const a of (d.andares||[])){
    if(a.numero != null && a.numero !== '') return String(a.numero);
  }
  for(const a of (d.andares||[])){
    if(a.nome){ const m=a.nome.match(/(\d+)/); if(m && m[1].length<=5) return m[1]; }
  }
  const m = (d.andar||'').match(/(\d+)/);
  if(m && m[1].length <= 5) return m[1];
  return d.n != null ? String(d.n) : '?';
}
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

/* Funde dois deals do mesmo andar que diferem apenas no tipo (Projeto + Obra).
   Retorna uma lista de deals onde pares P+O viram um único deal com tipo 'Projeto e Obra',
   valor somado e stage = o mais avançado dos dois.
   A condição "mesmo contexto" é relaxada: campos vazios/null/undefined são equivalentes. */
function mergeAndarTipo(deals){
  const byAndar = {};
  deals.forEach(d=>{
    const key = d.n;
    (byAndar[key] = byAndar[key]||[]).push(d);
  });
  const STAGE_ORDER = [
    'Recebido no Núcleo','Diagnóstico / Briefing / Test Fit','Estratégia Definida',
    'Proposta em Elaboração','Proposta Apresentada','Em Negociação / Short List',
    'Go/No-Go 2 — Aprovação (Ivo)','Ganho — Preparo do Processo','Contrato Assinado',
    'Perdido','Declinado',
  ];
  const stageRank = s => { const i=STAGE_ORDER.indexOf(s); return i<0?99:i; };
  // dois valores são "iguais para efeito de merge" se ambos forem vazios ou idênticos
  const sameVal = (a,b) => (a||'')===(b||'');
  const out = [];
  Object.values(byAndar).forEach(grupo=>{
    if(grupo.length===2){
      const [a,b]=grupo;
      const tipoA=a.tipo||'', tipoB=b.tipo||'';
      const isPO=(tipoA==='Projeto'&&tipoB==='Obra')||(tipoA==='Obra'&&tipoB==='Projeto');
      if(isPO){
        // mesmo contexto: cliente, broker, dono, gerenciadora coincidem (ou ambos vazios)
        const sameCtx =
          sameVal(a.cliente,b.cliente) && sameVal(a.broker,b.broker) &&
          sameVal(a.dono,b.dono)       && sameVal(a.gerenciadora,b.gerenciadora);
        if(sameCtx){
          const [adv,oth] = stageRank(a.stage)<=stageRank(b.stage) ? [a,b] : [b,a];
          out.push(Object.assign({}, adv, {
            tipo: 'Projeto e Obra',
            valor: (a.valor||0)+(b.valor||0),
            _mergedFrom: [a.id, b.id],
            _mergedTipos: [tipoA==='Projeto'?a:b, tipoA==='Obra'?a:b], // [proj, obra]
            nome: adv.nome,
          }));
          return;
        }
      }
    }
    out.push(...grupo);
  });
  return out;
}

function buildModel(focal){
  const byEd = {};
  DEALS.forEach(d=>{
    // Resolve o número do andar para uso como chave de agrupamento.
    // Prioridade:
    //   1. andares[0].numero  (campo estruturado "numero_do_andar" do HubSpot — ex: "7")
    //   2. andares[0].nome    (nome do objeto Andar — ex: "Andar 7"; rejeita IDs longos)
    //   3. d.andar            (texto legado no deal — ex: "Andar 7"; rejeita IDs longos)
    // "Rejeitar IDs longos" = string com mais de 5 dígitos consecutivos → não é nº de andar.
    function resolveN(d){
      // 1. campo numero estruturado
      for(const a of (d.andares||[])){
        if(a.numero != null && a.numero !== ''){
          const v = Number(a.numero);
          if(!isNaN(v)) return v;
        }
      }
      // 2. nome do objeto Andar (ex: "Andar 7")
      for(const a of (d.andares||[])){
        if(a.nome){
          const m = a.nome.match(/(\d+)/);
          if(m && m[1].length <= 5) return Number(m[1]);
        }
      }
      // 3. texto legado d.andar — rejeita IDs do HubSpot (>5 dígitos)
      const m = (d.andar||'').match(/(\d+)/);
      if(m && m[1].length <= 5) return Number(m[1]);
      return null;
    }
    const n = resolveN(d);
    if(n == null) return;
    (byEd[d.edificio] = byEd[d.edificio]||[]).push(Object.assign({}, d, { n }));
  });
  // Mescla deals do mesmo andar que só diferem por tipo (Projeto ↔ Obra)
  Object.keys(byEd).forEach(ed=>{ byEd[ed] = mergeAndarTipo(byEd[ed]); });

  // ---- modo filtro por ator ----
  // Quando actorFilter está ativo, mostra TODOS os prédios que têm o ator
  // e destaca apenas os deals desse ator dentro de cada prédio.
  if(actorFilter){
    const { kind, value } = actorFilter;
    const matchingEds = Object.keys(byEd).filter(ed => byEd[ed].some(d => d[kind]===value));
    // focal primeiro se estiver no conjunto, senão primeiro da lista
    const focalFirst = matchingEds.includes(focal) ? focal : matchingEds[0];
    const others = matchingEds.filter(ed => ed !== focalFirst);
    const order = [focalFirst, ...others].filter(Boolean);
    const model = order.map(ed=>{
      const deals = byEd[ed];
      const donos = [...new Set(deals.map(d=>d.dono).filter(Boolean))];
      // marca quais deals pertencem ao ator filtrado (para highlight visual)
      const dealsFiltered = deals.map(d => Object.assign({}, d, { _actorMatch: d[kind]===value }));
      return { ed, ctx:false, deals:dealsFiltered, dono:donos.join(' / ')||'—', focal:ed===focalFirst };
    });
    model.hiddenRel = 0;
    return model;
  }

  // ---- modo normal (focal + relacionados por score) ----
  const focalDeals = byEd[focal]||[];
  const fSet = k => new Set(focalDeals.map(d=>d[k]).filter(Boolean));
  const focalBy = { cliente:fSet('cliente'), dono:fSet('dono'), broker:fSet('broker'), gerenciadora:fSet('gerenciadora') };
  const scored = Object.keys(byEd).filter(ed=>ed!==focal).map(ed=>{
    const ds = byEd[ed];
    let score = 0;
    Object.keys(REL_WEIGHT).forEach(k=>{ if(ds.some(d=>d[k]&&focalBy[k].has(d[k]))) score += REL_WEIGHT[k]; });
    return { ed, score };
  }).filter(x=>x.score>0)
    .sort((a,b)=> b.score-a.score || byEd[b.ed].length-byEd[a.ed].length);
  const rel = scored.slice(0, REL_CAP);
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

  // Mapa local de todos os deals do model (inclui merged): id → deal
  // Necessário porque deals merged têm ids que não existem em DEALS global.
  _modelDealMap = {};
  model.forEach(m=>{ m.deals.forEach(d=>{ _modelDealMap[d.id]=d; }); });
  const modelDealMap = _modelDealMap;

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
  const PAD = 52; // margem esquerda para o nº do andar fora do slot
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
      const dealDim = actorFilter && d._actorMatch===false;
      const col=STAGE_COLORS[d.stage]||'#5BAEF0';
      const isPin=pinned===d.id;
      const floorY=GROUND-(slot+1)*FH+0.5;
      const dealOp = dealDim ? 0.15 : 1;
      const cy=centY(m.ed,d.id);
      const lcol=ink(col);

      // ── retângulo do slot ──
      svg+=`<rect x="${g.x+1}" y="${floorY}" width="${g.w-2}" height="${FH-1}"
        fill="${col}" fill-opacity="${0.88*dealOp}"
        stroke="${isPin?'#00DEDB':'none'}" stroke-width="${isPin?2.5:0}"
        opacity="${dealOp}"
        data-deal="${d.id}" style="cursor:pointer"></rect>`;

      // ── métricas de layout ──
      const PAD_L = 5;   // margem interna esquerda
      const PAD_R = 4;   // margem interna direita
      const bFontSz = 7; // tamanho fixo badges P/O

      // nº do andar: usa andares[0].numero (campo estruturado) para evitar
      // que IDs longos do HubSpot (ex: "32144440124440") apareçam no slot
      const andarStr = andarDisplay(d);
      const andarW = andarStr.length * 6.5 + 4; // px estimados + gap

      // largura dos badges P/O à direita
      const badgeW = d.tipo ? (d._mergedFrom ? 32 : 16) : 0;

      // largura da pílula de etapa — proporcional ao texto abreviado
      const stageLbl = STAGE_ABBR[d.stage]||d.stage;
      const stageW = stageLbl.length * 4.8 + 10; // estimativa font-mono 6.5px

      // espaço total reservado à direita (etapa + badges + gaps)
      const rightW = stageW + (badgeW > 0 ? badgeW + 3 : 0) + PAD_R + 2;

      // max-width do cliente: do fim do nº andar até o início da etapa
      // ── nº do andar (fora do slot, à esquerda) ──
      ov+=`<div data-novwrap style="left:${px(g.x-5)}%;top:${py(cy)}%;transform:translate(-100%,-50%);font-size:9px;font-family:var(--font-mono);color:rgba(14,26,26,.5);font-weight:700;opacity:${op*dealOp}">${esc(andarStr)}</div>`;

      // ── cliente final (dentro do slot, esquerda, truncado antes da etapa) ──
      const clientLeft = g.x + PAD_L;
      const clientMaxW = Math.max(10, g.w - PAD_L - PAD_R - rightW);
      if(d.cliente){
        ov+=`<div data-filter-actor="cliente" data-filter-val="${esc(d.cliente)}" style="left:${px(clientLeft)}%;top:${py(cy)}%;transform:translateY(-50%);display:inline-block;font-size:${g.w>=160?9:8}px;font-weight:600;color:${lcol};opacity:${op*dealOp};cursor:pointer;text-decoration:underline dotted;max-width:${clientMaxW}px;overflow:hidden;text-overflow:ellipsis;vertical-align:top;pointer-events:auto">${esc(d.cliente)}</div>`;
      }

      // ── etapa (centralizada verticalmente, à direita dos badges) ──
      const stageLeft = g.x + g.w - PAD_R - (badgeW > 0 ? badgeW + 3 : 0) - stageW;
      ov+=`<div data-novwrap style="left:${px(stageLeft)}%;top:${py(cy)}%;transform:translateY(-50%);display:inline-block;background:rgba(0,0,0,0.2);color:${lcol};font-size:6.5px;font-family:var(--font-mono);font-weight:700;letter-spacing:.3px;text-transform:uppercase;padding:1px 5px;border-radius:2px;opacity:${0.92*op*dealOp}">${esc(stageLbl)}</div>`;

      // ── badges P / O (extrema direita) ──
      if(d.tipo && FH > 16){
        const bRight = g.x + g.w - PAD_R;
        if(d._mergedFrom){
          ov+=`<div data-novwrap style="left:${px(bRight)}%;top:${py(cy)}%;transform:translate(-100%,-50%);display:inline-flex;gap:2px;opacity:${op*dealOp}"><span style="background:#00585C;color:#fff;font-size:${bFontSz}px;font-family:var(--font-mono);font-weight:700;padding:0 3px;border-radius:2px;line-height:1.9">P</span><span style="background:#E07800;color:#fff;font-size:${bFontSz}px;font-family:var(--font-mono);font-weight:700;padding:0 3px;border-radius:2px;line-height:1.9">O</span></div>`;
        } else {
          const tb = TIPO_BADGE[d.tipo];
          if(tb) ov+=`<div data-novwrap style="left:${px(bRight)}%;top:${py(cy)}%;transform:translate(-100%,-50%);display:inline-block;background:${tb.bg};color:#fff;font-size:${bFontSz}px;font-family:var(--font-mono);font-weight:700;padding:0 4px;border-radius:2px;line-height:1.9;opacity:${op*dealOp}">${esc(tb.label)}</div>`;
        }
      }
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

  // conexões entre prédios removidas — vínculos visíveis no painel de entidades abaixo

  host.style.overflowX = 'auto';
  // Injeta os prefixos de estilo corretos em cada div do overlay:
  // • data-novwrap → position:absolute + white-space:nowrap (nº andar, valor, pílulas, badges)
  // • demais divs  → position:absolute sem nowrap (labels de cliente/dono com max-width+overflow)
  // Isso evita que texto longo vaze horizontalmente para o prédio vizinho.
  const ovHtml = ov
    .replace(/<div data-novwrap ([^>]*style=")/g, '<div class="vd-ov" $1position:absolute;white-space:nowrap;line-height:1.2;')
    .replace(/<div ([^>]*style=")/g, '<div class="vd-ov" $1position:absolute;line-height:1.2;');
  host.innerHTML =
    `<div style="position:relative;width:${SVGW}px;height:${SVGH}px;flex-shrink:0">
       <svg width="${SVGW}" height="${SVGH}" viewBox="0 0 ${SVGW} ${SVGH}" style="display:block;position:absolute;top:0;left:0">${svg}</svg>
       <div style="position:absolute;inset:0;pointer-events:none;font-family:var(--font-head)">
         ${ovHtml}
       </div>
       <div class="vd-tip" id="vd-tip"></div>
     </div>`;

  // header
  const focal = model.find(m=>m.focal);
  nomeEl.textContent = focal.ed;
  const relCount = model.length-1;
  if(actorFilter){
    metaEl.textContent = `${model.length} prédio(s)`;
  } else {
    metaEl.textContent = `Proprietário: ${focal.dono} · ${focal.deals.length} deal(s) no prédio · ${relCount} prédio(s) relacionado(s)`
      + (model.hiddenRel ? ` (+${model.hiddenRel} ocultos)` : '');
  }
  renderFilterBadge();

  // interações
  const tip = document.getElementById('vd-tip');
  let _tipHover = false; // true enquanto o mouse está dentro do tooltip
  // click delegation no tooltip: captura "Filtrar por X" mesmo com pointer-events:auto
  tip.onclick = (e)=>{
    const fc = e.target.closest('[data-filter-cliente]');
    if(fc){ tip.style.display='none'; setActorFilter('cliente', fc.dataset.filterCliente); }
    const fa = e.target.closest('[data-filter-actor]');
    if(fa){ tip.style.display='none'; setActorFilter(fa.dataset.filterActor, fa.dataset.filterVal); }
  };
  tip.addEventListener('mouseenter', ()=>{ _tipHover=true; });
  tip.addEventListener('mouseleave', ()=>{ _tipHover=false; tip.style.display='none'; });

  host.querySelectorAll('[data-deal]').forEach(r=>{
    const d = modelDealMap[r.dataset.deal];
    if(!d) return; // segurança
    r.addEventListener('mouseenter', e=>{
      const hr=host.getBoundingClientRect(), rr=r.getBoundingClientRect();
      let x=rr.right-hr.left+12;
      if(x>hr.width-270) x=rr.left-hr.left-272;
      if(x<4) x=4;
      const y=Math.max(6,Math.min(rr.top-hr.top-8, hr.height-300));
      const col=STAGE_COLORS[d.stage]||'#5BAEF0';
      tip.style.transform=`translate(${x}px,${y}px)`;
      tip.style.display='block';
      // deal merged: link para ambos os deals originais no HubSpot
      const hubLinks = d._mergedFrom
        ? d._mergedFrom.map((id,i)=>`<a href="https://app.hubspot.com/contacts/51253038/deal/${id}" target="_blank" style="color:inherit;text-decoration:underline">Deal ${i===0?'Projeto':'Obra'} ↗</a>`).join(' · ')
        : `<a href="https://app.hubspot.com/contacts/51253038/deal/${d.id}" target="_blank" style="color:inherit;text-decoration:underline">HubSpot ↗</a>`;
      tip.innerHTML=`
        <div class="vd-tr"><span class="vd-stage" style="background:${col};color:${ink(col)}">${esc(d.stage)}</span><span class="vd-tf">${esc(d.andar||'')}</span>${d.conjunto?`<span class="vd-tf">Conj. ${esc(d.conjunto)}</span>`:''}</div>
        <div class="vd-td">${esc(d.nome)}${d._mergedFrom?'<span style="font-size:9px;font-weight:400;opacity:.6"> · Projeto e Obra (unificado)</span>':''}</div>
        <div class="vd-tm">${esc(d.edificio)}</div>
        <div class="vd-tg">
          <span>Broker</span><b>${esc(d.broker||'—')}</b>
          <span>Gerenciadora</span><b>${esc(d.gerenciadora||'—')}</b>
          <span>Dono do andar</span><b>${esc(d.dono||'—')}</b>
          ${d.tipo?`<span>Tipo</span><b style="color:${(TIPO_BADGE[d.tipo]||{bg:'#333'}).bg}">${esc(d.tipo)}</b>`:''}
          ${d._mergedFrom?`<span>Valor total</span><b style="color:#00585C">${(()=>{const v=d.valor;return v>=1e6?(v/1e6).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'M':(v/1e3).toFixed(0)+'k';})()}</b>`:''}
          ${d.contatos&&d.contatos.length?`<span>Contatos</span><b>${d.contatos.map(c=>esc(c.nome)+(c.cargo?` <span style="opacity:.6;font-weight:400">· ${esc(c.cargo)}</span>`:'')).join('<br>')}</b>`:''}
        </div>
        ${d.concorrente?`<div class="vd-tn">▲ Concorrente no deal: ${esc(d.concorrente)}</div>`:''}
        <div class="vd-th">${d.cliente?`<b style="cursor:pointer;text-decoration:underline" data-filter-cliente="${esc(d.cliente)}">⊙ Filtrar por ${esc(d.cliente)}</b> · `:''}clique para fixar · ${hubLinks}</div>`;
    });
    r.addEventListener('mouseleave', ()=>{ if(!_tipHover){ tip.style.display='none'; } });
    r.addEventListener('click', ()=>{ pinned = pinned===d.id?null:d.id; render(); });
  });
  host.querySelectorAll('[data-focus]').forEach(el=>{
    el.addEventListener('click', ()=>{ focalEd=el.dataset.focus; pinned=null; _modelCache=null; actorFilter=null; render(); const _en=NODES&&NODES.find(n=>n.type==='edificio'&&n.label===focalEd); if(typeof updateTableFromNode==='function') updateTableFromNode(_en||null); });
  });
  host.querySelector('[data-clear]').addEventListener('click', ()=>{
    if(pinned || actorFilter){ pinned=null; if(actorFilter){ actorFilter=null; _modelCache=null; } render(); }
  });
  // clique direto no label do ator no slot (overlay HTML) → actor filter
  host.querySelectorAll('[data-filter-actor]').forEach(el=>{
    el.addEventListener('click', (e)=>{ e.stopPropagation(); setActorFilter(el.dataset.filterActor, el.dataset.filterVal); });
  });
  renderPin();
  renderLegend(model);
  renderEntityPanel(model);
}

function renderPin(){
  if(!pinned){ pinEl.innerHTML=''; return; }
  const d=_modelDealMap[pinned]||DEALS.find(x=>x.id===pinned);
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
      ${d._mergedFrom
        ? d._mergedFrom.map((id,i)=>`<button class="vd-hs" onclick="window.open('https://app.hubspot.com/contacts/51253038/deal/${id}','_blank')">${i===0?'Projeto':'Obra'} no HubSpot ↗</button>`).join('')
        : `<button class="vd-hs" onclick="window.open('https://app.hubspot.com/contacts/51253038/deal/${d.id}','_blank')">Abrir no HubSpot ↗</button>`}
      <button class="vd-x" id="vd-unpin">fechar detalhe</button>
    </div>
  </div>`;
  document.getElementById('vd-unpin').onclick=()=>{ pinned=null; render(); };
}

/* ---- filtro por ator ---- */
function setActorFilter(kind, value){
  actorFilter = { kind, value };
  _modelCache = null;
  pinned = null;
  render();
}
function clearActorFilter(){
  actorFilter = null;
  _modelCache = null;
  render();
}
function renderFilterBadge(){
  if(!actorFilter){ filterEl.style.display='none'; return; }
  const LABEL = { cliente:'Cliente Final', broker:'Broker', gerenciadora:'Gerenciadora', dono:'Dono do andar', parceiro:'Parceiro', concorrente:'Concorrente' };
  filterEl.style.display='flex';
  filterEl.style.cssText='display:flex;align-items:center;gap:8px;background:#00DEDB22;border:1px solid #00DEDB;border-radius:3px;padding:4px 10px;font-size:11px;font-weight:600;color:#005554;white-space:nowrap';
  filterEl.innerHTML=`<span>⊙ ${LABEL[actorFilter.kind]||actorFilter.kind}: <b>${esc(actorFilter.value)}</b></span><button id="vd-clear-filter" style="background:none;border:none;font-size:14px;cursor:pointer;color:#005554;line-height:1;padding:0">✕</button>`;
  document.getElementById('vd-clear-filter').onclick=()=>clearActorFilter();
}

/* ---- painel de entidades ---- */
// Agrupa todas as entidades envolvidas nos deals do model atual,
// com contagem de ocorrências. Clicar num chip ativa o actor filter.
const ENTITY_KINDS = [
  { key:'cliente',      label:'Cliente Final',   color:'#3278DC' },
  { key:'broker',       label:'Broker',          color:'#00585C' },
  { key:'gerenciadora', label:'Gerenciadora',    color:'#9650DC' },
  { key:'dono',         label:'Dono do andar',   color:'#C8940A' },
  { key:'parceiro',     label:'Parceiro',        color:'#DC5028' },
  { key:'concorrente',  label:'Concorrente',     color:'#888888' },
];

function renderEntityPanel(model){
  const entEl = document.getElementById('vd-entities');
  if(!entEl) return;

  // conta ocorrências de cada entidade por tipo em todos os deals visíveis
  const counts = {}; // { 'cliente::Grupo Primo': { kind, value, count } }
  model.forEach(m=>{
    m.deals.forEach(d=>{
      ENTITY_KINDS.forEach(ek=>{
        const val = d[ek.key];
        if(!val) return;
        const key = ek.key+'::'+val;
        if(!counts[key]) counts[key]={ kind:ek.key, value:val, count:0, kindLabel:ek.label, color:ek.color };
        counts[key].count++;
      });
    });
  });

  // agrupa por tipo, ordena por contagem desc
  const byKind = {};
  Object.values(counts).forEach(e=>{
    (byKind[e.kind]=byKind[e.kind]||[]).push(e);
  });
  ENTITY_KINDS.forEach(ek=>{ if(byKind[ek.key]) byKind[ek.key].sort((a,b)=>b.count-a.count); });

  const hasData = Object.keys(byKind).length > 0;
  if(!hasData){ entEl.innerHTML=''; return; }

  const activeKind  = actorFilter?.kind  || null;
  const activeValue = actorFilter?.value || null;

  let html = `<div class="vde-title">Entidades envolvidas — clique para filtrar a vista</div>`;
  ENTITY_KINDS.forEach(ek=>{
    const items = byKind[ek.key];
    if(!items||!items.length) return;
    html += `<div class="vde-section">
      <div class="vde-kind">${esc(ek.label)}</div>
      <div class="vde-chips">`;
    items.forEach(e=>{
      const isActive = activeKind===e.kind && activeValue===e.value;
      html += `<div class="vde-chip${isActive?' active':''}" data-ek="${esc(e.kind)}" data-ev="${esc(e.value)}">
        <i style="background:${e.color}"></i>
        ${esc(e.value)}
        <span class="cnt">${e.count > 1 ? e.count+'×' : ''}</span>
      </div>`;
    });
    html += `</div></div>`;
  });

  entEl.innerHTML = html;

  // event listeners nos chips
  entEl.querySelectorAll('.vde-chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      const kind = chip.dataset.ek, value = chip.dataset.ev;
      if(actorFilter && actorFilter.kind===kind && actorFilter.value===value){
        clearActorFilter(); // segundo clique: limpa
      } else {
        setActorFilter(kind, value);
      }
    });
  });
}

function renderLegend(model){
  // Exibe apenas as barras de papel (ROLE_BARS) que aparecem nos deals visíveis
  const activeRoles=ROLE_BARS.filter(r=>model.some(m=>m.deals.some(d=>d[r.key])));
  legendEl2.innerHTML =
    `<span class="vd-dim">cor da laje = etapa</span>` +
    (activeRoles.length ? '<span class="vd-dim" style="margin-left:6px">barras: </span>'
      + activeRoles.map(r=>`<span><i style="background:${r.color}"></i>${r.key}</span>`).join('') : '');
}

/* ---- abrir / fechar ---- */
function openVista(edLabel){
  focalEd=edLabel; pinned=null; _modelCache=null; actorFilter=null;
  rebuildClientColor();
  drawer.style.display='flex';
  render();
  window.dispatchEvent(new Event('resize'));
  const _en=NODES&&NODES.find(n=>n.type==='edificio'&&n.label===edLabel);
  if(typeof updateTableFromNode==='function') updateTableFromNode(_en||null);
  // hook para URL state (configurado por index.html após carregamento)
  if(typeof window._onOpenVista==='function') window._onOpenVista(edLabel);
}
function closeVista(){
  drawer.style.display='none';
  window.dispatchEvent(new Event('resize'));
  if(typeof window._onCloseVista==='function') window._onCloseVista();
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

// Expõe openVista/closeVista globalmente para que index.html possa
// chamar diretamente ao restaurar o estado da URL (?vista=...).
window.openVista = openVista;
window.closeVista = closeVista;
})();
