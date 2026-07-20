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
let showVacant = false; // mostrar andares/conjuntos VAGOS (sem deal) além dos ocupados
let focalEd = null;   // label do edifício focal
let pinned = null;    // deal id fixado
// filtro por ator: { kind:'cliente'|'broker'|'gerenciadora', value:'Grupo Primo' }
let actorFilter = null;
// cache de model+conns por focalEd — evita recomputar O(n²) em re-renders visuais
let _modelCache = null;  // { ed, model, conns }
// mapa de todos os deals do model atual (incluindo merged): id → deal
let _modelDealMap = {};
function getModelConns(){
  if(_modelCache&&_modelCache.ed===focalEd&&_modelCache.vacant===showVacant) return _modelCache;
  const model = buildModel(focalEd);
  const conns = buildConns(model);
  _modelCache = { ed:focalEd, vacant:showVacant, model, conns };
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

/* Funde todos os deals do mesmo andar que compartilham o mesmo cliente final.
   Regra: mesmo prédio + mesmo andar + mesmo cliente → slot único.
   - valor: soma de todos os deals fundidos
   - stage: o mais avançado
   - tipo: se todos iguais usa o tipo; senão lista os tipos únicos (ex: "Projeto / Obra")
   - _mergedFrom: array de ids originais (undefined se só 1 deal)
   Deals de clientes diferentes no mesmo andar geram slots separados (como esperado). */
function mergeAndarTipo(deals){
  const STAGE_ORDER = [
    'Recebido no Núcleo','Diagnóstico / Briefing / Test Fit','Estratégia Definida',
    'Proposta em Elaboração','Proposta Apresentada','Em Negociação / Short List',
    'Go/No-Go 2 — Aprovação (Ivo)','Ganho — Preparo do Processo','Contrato Assinado',
    'Perdido','Declinado',
  ];
  const stageRank = s => { const i=STAGE_ORDER.indexOf(s); return i<0?99:i; };

  // chave de agrupamento: andar + cliente (null/undefined tratados como string vazia)
  const groupKey = d => `${d.n}||${(d.cliente||'').trim().toLowerCase()}`;

  const groups = {};
  const order  = [];
  deals.forEach(d=>{
    const k = groupKey(d);
    if(!groups[k]){ groups[k]=[]; order.push(k); }
    groups[k].push(d);
  });

  const out = [];
  order.forEach(k=>{
    const grupo = groups[k];
    if(grupo.length === 1){ out.push(grupo[0]); return; }

    // múltiplos deals: funde em slot único
    const best = grupo.reduce((a,b)=> stageRank(a.stage)<=stageRank(b.stage)?a:b);
    const tiposUnicos = [...new Set(grupo.map(d=>d.tipo).filter(Boolean))];
    const tipoFinal = tiposUnicos.length===0 ? null
                    : tiposUnicos.length===1 ? tiposUnicos[0]
                    : tiposUnicos.join(' / ');
    const valorTotal = grupo.reduce((s,d)=>s+(d.valor||0),0);
    out.push(Object.assign({}, best, {
      tipo: tipoFinal,
      valor: valorTotal||null,
      _mergedFrom: grupo.map(d=>d.id),
      _mergedTipos: grupo,
      nome: best.nome,
    }));
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
    return addVacantFloors(model);
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
  return addVacantFloors(model);
}

// Acrescenta ao model os andares VAGOS (sem deal) de cada prédio, a partir do
// inventário (window.FLOORS_BY_EDIFICIO_ID). Só quando showVacant está ligado.
// Cada slot vago é um pseudo-deal { _vacant:true } que o render desenha em cinza.
function addVacantFloors(model){
  if(!showVacant) return model;
  const FLOORS = window.FLOORS_BY_EDIFICIO_ID || {};
  model.forEach(m=>{
    const edId = (m.deals.find(d=>d.edificioId)||{}).edificioId;
    const floors = edId && FLOORS[edId];
    if(!floors || !floors.length) return;
    const occupied = new Set(m.deals.map(d=>d.n));
    floors.forEach(f=>{
      const num = (f.numero!=null && f.numero!=='') ? Number(f.numero) : null;
      if(num==null || isNaN(num) || occupied.has(num)) return;
      occupied.add(num);
      m.deals.push({ id:`_vac_${edId}_${num}`, n:num, _vacant:true,
        nome:f.nome||('Andar '+num), disp:f.disp||null, area:f.area||null,
        cliente:null, stage:null, valor:null, tipo:null, edificio:m.ed });
    });
  });
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

      // ── andar VAGO (sem deal): slot cinza tracejado, sem interação ──
      if(d._vacant){
        const fyv=GROUND-(slot+1)*FH+0.5;
        const cyv=centY(m.ed,d.id);
        svg+=`<rect x="${g.x+1}" y="${fyv}" width="${g.w-2}" height="${FH-1}"
          fill="#E7ECEC" fill-opacity="0.9" stroke="#C2CCCC" stroke-width="0.8" stroke-dasharray="3 2"
          data-vacant="1" style="cursor:default" pointer-events="none"></rect>`;
        ov+=`<div data-novwrap style="left:${px(g.x-5)}%;top:${py(cyv)}%;transform:translate(-100%,-50%);font-size:9px;font-family:var(--font-mono);color:rgba(14,26,26,.32);font-weight:700;opacity:${op}">${esc(andarDisplay(d))}</div>`;
        if(FH>13){
          const vlabel = d.disp ? esc(d.disp) : (d.area?`${esc(String(d.area))} m²`:'Disponível');
          ov+=`<div style="left:${px(g.x+5)}%;top:${py(cyv)}%;transform:translateY(-50%);font-size:7.5px;font-style:italic;color:rgba(14,26,26,.42);opacity:${op}">${vlabel}</div>`;
        }
        return;
      }

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

      // ── badges de tipo (P / O lado a lado, extrema direita) ──
      // Para deals fundidos: um badge por tipo único; para deal simples: um badge se tiver tipo.
      const badgeTipos = d._mergedFrom
        ? [...new Set((d._mergedTipos||[]).map(x=>x.tipo).filter(Boolean))]
        : (d.tipo ? [d.tipo] : []);
      const badgeW = badgeTipos.length > 0 ? badgeTipos.length * 18 : 0;

      // ── valor (ex: "2.1M" ou "850k") — exibe quando tem valor e slot tem altura suficiente ──
      const valorStr = d.valor ? fmtVShort(d.valor) : null;
      const valorW = valorStr ? (valorStr.length * 5.5 + 8) : 0; // estimativa px

      // largura da pílula de etapa
      const stageLbl = STAGE_ABBR[d.stage]||d.stage;
      const stageW = stageLbl.length * 4.8 + 10;

      // espaço total reservado à direita: badges + valor + etapa + gaps
      const rightW = (badgeW > 0 ? badgeW + 3 : 0) + (valorW > 0 ? valorW + 3 : 0) + stageW + PAD_R + 2;

      // ── nº do andar (fora do slot, à esquerda) ──
      ov+=`<div data-novwrap style="left:${px(g.x-5)}%;top:${py(cy)}%;transform:translate(-100%,-50%);font-size:9px;font-family:var(--font-mono);color:rgba(14,26,26,.5);font-weight:700;opacity:${op*dealOp}">${esc(andarStr)}</div>`;

      // ── cliente final (dentro do slot, esquerda, truncado antes da área direita) ──
      const clientLeft = g.x + PAD_L;
      const clientMaxW = Math.max(10, g.w - PAD_L - rightW);
      if(d.cliente){
        ov+=`<div data-filter-actor="cliente" data-filter-val="${esc(d.cliente)}" style="left:${px(clientLeft)}%;top:${py(cy)}%;transform:translateY(-50%);display:inline-block;font-size:${g.w>=160?9:8}px;font-weight:600;color:${lcol};opacity:${op*dealOp};cursor:pointer;text-decoration:underline dotted;max-width:${clientMaxW}px;overflow:hidden;text-overflow:ellipsis;vertical-align:top;pointer-events:auto">${esc(d.cliente)}</div>`;
      }

      // constrói a área direita da direita para a esquerda: badges → valor → etapa
      let curRight = g.x + g.w - PAD_R;

      // ── badges P/O (extrema direita) ──
      if(badgeTipos.length > 0 && FH > 16){
        const badgeSpans = badgeTipos.map(t=>{
          const tb = TIPO_BADGE[t] || {label:t.charAt(0).toUpperCase(), bg:'#666'};
          return `<span style="background:${tb.bg};color:#fff;font-size:${bFontSz}px;font-family:var(--font-mono);font-weight:700;padding:0 3px;border-radius:2px;line-height:1.9">${esc(tb.label)}</span>`;
        }).join('');
        ov+=`<div data-novwrap style="left:${px(curRight)}%;top:${py(cy)}%;transform:translate(-100%,-50%);display:inline-flex;gap:2px;opacity:${op*dealOp}">${badgeSpans}</div>`;
        curRight -= badgeW + 3;
      }

      // ── valor (entre badges e etapa) ──
      if(valorStr && FH > 16){
        ov+=`<div data-novwrap style="left:${px(curRight)}%;top:${py(cy)}%;transform:translate(-100%,-50%);font-size:7.5px;font-family:var(--font-mono);font-weight:700;color:${lcol};opacity:${0.75*op*dealOp}">${esc(valorStr)}</div>`;
        curRight -= valorW + 3;
      }

      // ── etapa ──
      const stageLeft = curRight - stageW;
      ov+=`<div data-novwrap style="left:${px(stageLeft)}%;top:${py(cy)}%;transform:translateY(-50%);display:inline-block;background:rgba(0,0,0,0.2);color:${lcol};font-size:6.5px;font-family:var(--font-mono);font-weight:700;letter-spacing:.3px;text-transform:uppercase;padding:1px 5px;border-radius:2px;opacity:${0.92*op*dealOp}">${esc(stageLbl)}</div>`;
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
  const focalDealsReais = focal.deals.filter(d=>!d._vacant).length; // exclui vagos
  if(actorFilter){
    metaEl.textContent = `${model.length} prédio(s)`;
  } else {
    metaEl.textContent = `Proprietário: ${focal.dono} · ${focalDealsReais} deal(s) no prédio · ${relCount} prédio(s) relacionado(s)`
      + (model.hiddenRel ? ` (+${model.hiddenRel} ocultos)` : '');
  }
  renderVacantToggle();
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
      // scrollLeft compensa o scroll horizontal do host (overflow-x:auto)
      const sl=host.scrollLeft||0;
      // posição do rect em coordenadas do conteúdo do host
      const rectLeft  = rr.left  - hr.left + sl;
      const rectRight = rr.right - hr.left + sl;
      // largura visível do host (sem scroll)
      const visW = hr.width;
      // tenta abrir à direita do slot; se não couber, abre à esquerda
      let x = rectRight + 12;
      if(x - sl + 270 > visW) x = rectLeft - 272;
      x = Math.max(sl + 4, x);
      const y=Math.max(6,Math.min(rr.top-hr.top-8, hr.height-300));
      const col=STAGE_COLORS[d.stage]||'#5BAEF0';
      tip.style.transform=`translate(${x}px,${y}px)`;
      tip.style.display='block';
      // deal merged: link para cada deal original no HubSpot
      const hubLinks = d._mergedFrom
        ? d._mergedFrom.map((id,i)=>{
            const orig = (d._mergedTipos||[])[i];
            const label = orig&&orig.tipo ? orig.tipo : `Deal ${i+1}`;
            return `<a href="https://app.hubspot.com/contacts/51253038/deal/${id}" target="_blank" style="color:inherit;text-decoration:underline">${esc(label)} ↗</a>`;
          }).join(' · ')
        : `<a href="https://app.hubspot.com/contacts/51253038/deal/${d.id}" target="_blank" style="color:inherit;text-decoration:underline">HubSpot ↗</a>`;
      const mergedLabel = d._mergedFrom ? `<span style="font-size:9px;font-weight:400;opacity:.6"> · ${d._mergedFrom.length} deals (unificados por andar)</span>` : '';
      tip.innerHTML=`
        <div class="vd-tr"><span class="vd-stage" style="background:${col};color:${ink(col)}">${esc(d.stage)}</span>${d.conjunto?`<span class="vd-tf">Conj. ${esc(d.conjunto)}</span>`:''}</div>
        <div class="vd-td">${esc(d.nome)}${mergedLabel}</div>
        <div class="vd-tm">${esc(d.edificio)}</div>
        <div class="vd-tg">
          <span>Broker</span><b>${esc(d.broker||'—')}</b>
          <span>Gerenciadora</span><b>${esc(d.gerenciadora||'—')}</b>
          <span>Dono do andar</span><b>${esc(d.dono||'—')}</b>
          ${d.tipo?`<span>Tipo</span><b style="color:${(TIPO_BADGE[d.tipo]||{bg:'#333'}).bg}">${esc(d.tipo)}</b>`:''}
          ${d._mergedFrom?`<span>Valor total</span><b style="color:#00585C">${(()=>{const v=d.valor;if(!v)return '—';return v>=1e6?(v/1e6).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'M':(v/1e3).toFixed(0)+'k';})()}</b>`:''}
          ${d.contatos&&d.contatos.length?`<span>Contatos</span><b>${d.contatos.map(c=>esc(c.nome)+(c.cargo?` <span style="opacity:.6;font-weight:400">· ${esc(c.cargo)}</span>`:'')).join('<br>')}</b>`:''}
        </div>
        ${d.concorrente?`<div class="vd-tn">▲ Concorrente no deal: ${esc(d.concorrente)}</div>`:''}
        <div class="vd-th">${d.cliente?`<b style="cursor:pointer;text-decoration:underline" data-filter-cliente="${esc(d.cliente)}">⊙ Filtrar por ${esc(d.cliente)}</b> · `:''}clique para fixar · ${hubLinks}</div>`;
    });
    r.addEventListener('mouseleave', ()=>{ if(!_tipHover){ tip.style.display='none'; } });
    r.addEventListener('click', ()=>{ pinned = pinned===d.id?null:d.id; render(); syncDetail(pinned ? d.id : edNodeId(focalEd)); });
  });
  host.querySelectorAll('[data-focus]').forEach(el=>{
    el.addEventListener('click', ()=>{ focalEd=el.dataset.focus; pinned=null; _modelCache=null; actorFilter=null; render(); const _en=NODES&&NODES.find(n=>n.type==='edificio'&&n.label===focalEd); if(typeof updateTableFromNode==='function') updateTableFromNode(_en||null); syncDetail(_en?_en.id:edNodeId(focalEd)); });
  });
  host.querySelector('[data-clear]').addEventListener('click', ()=>{
    if(pinned || actorFilter){ pinned=null; if(actorFilter){ actorFilter=null; _modelCache=null; } render(); syncDetail(edNodeId(focalEd)); }
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
    </div>
    <div class="vd-pinbtns">
      ${d._mergedFrom
        ? d._mergedFrom.map((id,i)=>{
            const orig=(d._mergedTipos||[])[i];
            const label=orig&&orig.tipo?orig.tipo:`Deal ${i+1}`;
            return `<button class="vd-hs" onclick="window.open('https://app.hubspot.com/contacts/51253038/deal/${id}','_blank')">${esc(label)} no HubSpot ↗</button>`;
          }).join('')
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
  syncDetail(actorNodeId(kind, value)); // Detalhe acompanha o ator filtrado
}
function clearActorFilter(){
  actorFilter = null;
  _modelCache = null;
  render();
  syncDetail(edNodeId(focalEd)); // volta o Detalhe ao prédio focal
}
// Toggle "Andares vagos" no header (usa o slot #vd-styles, antes ocioso).
function renderVacantToggle(){
  if(!stylesEl) return;
  const on = showVacant;
  stylesEl.innerHTML =
    `<button id="vd-vacant" title="Mostrar andares/conjuntos sem negócio vinculado"
       style="height:30px;border:1px solid ${on?'#00585C':'rgba(14,26,26,.18)'};background:${on?'rgba(0,222,219,.12)':'#fff'};color:${on?'#00585C':'rgba(14,26,26,.6)'};border-radius:3px;padding:0 11px;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px">
       <span style="width:9px;height:9px;border-radius:2px;background:${on?'#00585C':'#C2CCCC'}"></span>Andares vagos: ${on?'ON':'OFF'}</button>`;
  const btn=document.getElementById('vd-vacant');
  if(btn) btn.onclick=()=>{ showVacant=!showVacant; _modelCache=null; render(); };
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

  // conta ocorrências de cada entidade por tipo.
  // No modo normal: apenas deals do prédio focal.
  // No modo actorFilter: todos os prédios visíveis (o filtro já define o escopo).
  const dealsParaPanel = actorFilter
    ? model.flatMap(m=>m.deals)
    : (model.find(m=>m.focal)||model[0]).deals;

  const counts = {}; // { 'cliente::Grupo Primo': { kind, value, count } }
  dealsParaPanel.forEach(d=>{
    ENTITY_KINDS.forEach(ek=>{
      const val = d[ek.key];
      if(!val) return;
      const key = ek.key+'::'+val;
      if(!counts[key]) counts[key]={ kind:ek.key, value:val, count:0, kindLabel:ek.label, color:ek.color };
      counts[key].count++;
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
  // Roteia pelo mesmo caminho: mostra a vista se houver relação, senão o vazio.
  enterVista({ ed: edLabel, kind: null, value: null }, null);
}
function closeVista(){
  drawer.style.display='none';
  window.dispatchEvent(new Event('resize'));
  if(typeof window._onCloseVista==='function') window._onCloseVista();
}
document.getElementById('vd-back').onclick=()=>{ closeVista(); if(typeof updateTableFromNode==='function') updateTableFromNode(null); };

/* ---- helpers: resolve edifício focal + actorFilter a partir de qualquer nó ---- */
// Retorna { ed, kind, value } ou null se não houver prédio com andares para esse nó.
// kind/value preenchidos apenas para atores (broker, gerenciadora, etc.) → actorFilter.
function resolveVistaTarget(n){
  if(!n) return null;
  const ACTOR_KEYS = ['broker','gerenciadora','cliente','dono','parceiro','concorrente'];

  if(n.type==='edificio'){
    if(!DEALS.some(d=>d.edificio===n.label)) return null;
    return { ed: n.label, kind: null, value: null };
  }
  if(n.type==='andar'){
    const ed = n.meta && n.meta.edificio;
    if(!ed) return null;
    return { ed, kind: null, value: null };
  }
  if(n.type==='deal'){
    const d = DEALS.find(x=>x.id===n.id);
    if(!d || !d.edificio) return null;
    return { ed: d.edificio, kind: null, value: null };
  }
  // ator: broker, gerenciadora, cliente, dono, parceiro, concorrente
  const actorKey = ACTOR_KEYS.find(k=>{
    if(k==='broker')       return n.type==='broker';
    if(k==='gerenciadora') return n.type==='gerenciadora';
    if(k==='cliente')      return n.type==='cliente';
    if(k==='dono')         return n.type==='dono';
    // parceiro e concorrente mapeados como 'escritorio' na teia
    if(k==='parceiro'||k==='concorrente') return n.type==='escritorio';
    return false;
  });
  if(!actorKey && n.type!=='escritorio') return null;

  // para escritorio precisamos descobrir se é parceiro ou concorrente
  let kind = actorKey;
  if(n.type==='escritorio'){
    // tenta parceiro primeiro, depois concorrente
    kind = DEALS.some(d=>d.parceiro===n.label) ? 'parceiro' : 'concorrente';
  }

  const dealsDoAtor = DEALS.filter(d=>d[kind]===n.label && d.edificio);
  if(!dealsDoAtor.length) return null;
  // prédio focal = o que tem mais deals desse ator
  const edCount = {};
  dealsDoAtor.forEach(d=>{ edCount[d.edificio]=(edCount[d.edificio]||0)+1; });
  const ed = Object.entries(edCount).sort((a,b)=>b[1]-a[1])[0][0];
  return { ed, kind, value: n.label };
}

/* ---- sincroniza o painel "Detalhe" (lateral) com a interação na vista ---- */
// Prefixos de id de nó no grafo (definidos em index.html ao montar NODES).
const NODE_PFX = { cliente:'C:', broker:'B:', gerenciadora:'G:', dono:'DO:', parceiro:'E:', concorrente:'E:' };
function actorNodeId(kind, value){ const p=NODE_PFX[kind]; return p ? p+value : null; }
function edNodeId(edLabel){ return 'ED:'+edLabel; }
// Atualiza o Detalhe para um nó SEM reabrir/alterar a vista (skipVista=true evita
// recursão de volta para enterVista/render). No-op se o nó não existir.
function syncDetail(nodeId){
  if(nodeId && typeof selectNode==='function' && typeof nodesMap!=='undefined' && nodesMap.has(nodeId)){
    selectNode(nodeId, false, true);
  }
}

/* ---- entrar na vista para um alvo (ou mostrar vazio se não houver relação) ---- */
// A Vista Multi-Prédio só faz sentido quando há RELAÇÃO entre edifícios: o modelo
// precisa ter >=2 prédios (focal + ao menos um relacionado, ou >=2 prédios com o
// ator no modo filtro). Se o nó não resolve prédio nenhum, ou o prédio focal não
// se relaciona com nenhum outro, mostra o estado vazio em vez de abrir a vista.
function enterVista(target, nodeForEmpty){
  if(!target){ showVistaEmpty(nodeForEmpty, null); return; }
  focalEd     = target.ed;
  pinned      = null;
  _modelCache = null;
  actorFilter = target.kind ? { kind: target.kind, value: target.value } : null;
  rebuildClientColor();
  drawer.style.display='flex';
  const { model } = getModelConns(); // usa focalEd/actorFilter recém-definidos
  if(model.length < 2){ showVistaEmpty(nodeForEmpty, target.ed); return; }
  render();
  window.dispatchEvent(new Event('resize'));
  const _en = NODES && NODES.find(x=>x.type==='edificio' && x.label===target.ed);
  if(typeof updateTableFromNode==='function') updateTableFromNode(_en||null);
  if(typeof window._onOpenVista==='function') window._onOpenVista(target.ed);
}

// Estado vazio: painel aberto, sem prédios, com a mensagem pedida.
function showVistaEmpty(n, ed){
  drawer.style.display='flex';
  pinned=null; actorFilter=null; _modelCache=null;
  const label = ed || (n && n.label) || 'Nó selecionado';
  nomeEl.textContent = label;
  metaEl.textContent = 'Sem relação entre edifícios';
  filterEl.style.display='none';
  pinEl.innerHTML=''; legendEl2.innerHTML='';
  const entEl=document.getElementById('vd-entities'); if(entEl) entEl.innerHTML='';
  host.style.overflowX='hidden';
  host.innerHTML=`<div style="padding:56px 32px;text-align:center;line-height:1.65">
       <div style="font-size:34px;margin-bottom:14px;opacity:.32">🏢</div>
       <div style="font-size:14px;font-weight:600;color:rgba(14,26,26,.7)">Não existe relação entre edifícios para este nó</div>
       <div style="font-size:12px;margin-top:8px;color:rgba(14,26,26,.5)">Este nó não compartilha cliente, dono, broker ou gerenciadora com outros prédios.</div>
     </div>`;
  window.dispatchEvent(new Event('resize'));
  // Só reflete na URL/tabela quando é um prédio real (evita ?vista=<rótulo> inválido).
  if(ed){
    const _en = NODES && NODES.find(x=>x.type==='edificio' && x.label===ed);
    if(typeof updateTableFromNode==='function') updateTableFromNode(_en||null);
    if(typeof window._onOpenVista==='function') window._onOpenVista(ed);
  }
}

/* ---- abrir direto ao clicar num nó ---- */
const _selectNode = selectNode;
selectNode = function(id, center, skipVista){
  _selectNode(id, center);
  if(skipVista) return;
  const n = nodesMap.get(id);
  enterVista(resolveVistaTarget(n), n);
};

/* ---- botão "Ver Vista" no painel de detalhes para qualquer nó com prédio ---- */
const _renderDetail = renderDetail;
renderDetail = function(id){
  _renderDetail(id);
  if(!id) return;
  const n=nodesMap.get(id);
  const target=resolveVistaTarget(n);
  if(!target) return;
  const isActor = !!target.kind;
  const btnLabel = isActor
    ? `Ver Vista · ${n.label} →`
    : 'Ver Vista Multi-Prédio →';
  const btn=document.createElement('button');
  btn.textContent=btnLabel;
  btn.style.cssText='width:100%;background:var(--tiffany,#00DEDB);color:#0E1A1A;border:none;border-radius:3px;padding:11px 14px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;margin-top:12px;';
  btn.onmouseenter=()=>btn.style.background='#3FE9E6';
  btn.onmouseleave=()=>btn.style.background='var(--tiffany,#00DEDB)';
  btn.onclick=()=>{ enterVista(target, n); };
  const panel=document.getElementById('detail-panel');
  const firstGroup=panel.querySelector('.conn-group,.detail-meta,.sumchips');
  panel.insertBefore(btn, firstGroup||null);
};

// Expõe openVista/closeVista globalmente para que index.html possa
// chamar diretamente ao restaurar o estado da URL (?vista=...).
window.openVista = openVista;
window.closeVista = closeVista;
})();
