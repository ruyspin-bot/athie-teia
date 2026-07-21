# Correções pós-auditoria — 21/07/2026

Auditoria executada por Manus AI identificou 4 problemas na migração. Scripts organizados por prioridade.

---

## Mapa de/para: Excel → HubSpot

| Excel (col) | Dado | Objeto | Propriedade HubSpot | Status |
|---|---|---|---|---|
| 0 — ID HubSpot (Edifício) | chave de busca | — | — | ✅ |
| 1 — Edifício | nome | Edifício | `nome` / label | ✅ |
| 2 — Andar | número | Andar | `numero_do_andar` | ✅ |
| 3 — Conjunto | nome | Conjunto | `nome_do_conjunto` | ✅ |
| 4 — Área (m²) | metragem | Conjunto | `area_m2` | ✅ importado |
| 5 — Status | OCUPADO/DISPONÍVEL | Conjunto | `disponibilidade` | ✅ importado |
| **6 — Ocupante** | **empresa/pessoa** | **Conjunto** | **`nome_do_ocupante`** | ❌ **FALTANDO** |
| 7 — Proprietário | nome | Conjunto | `nome_do_proprietario` | ✅ importado |
| 8 — Preço Locação (R$/m²) | valor | Andar | `preco_locacao_m2` | ✅ no Andar |
| 9 — Condomínio (R$/m²) | valor | Andar | `condominio_m2` | ✅ no Andar |
| 10 — IPTU (R$/m²) | valor | Andar | `iptu_m2` | ✅ no Andar |
| 11 — Última Atualização | data | — | não importado | — |

**Única propriedade faltando:** `nome_do_ocupante` no objeto Conjunto.

---

## Scripts de correção

### P1 — Reassociar 1.394 conjuntos ao andar correto

```bash
# Dry-run primeiro (sem alterar nada)
node --env-file=.env.local scripts/corrigir-assoc-conjuntos.mjs --dry-run

# Execução real
node --env-file=.env.local scripts/corrigir-assoc-conjuntos.mjs

# Limite para teste parcial
node --env-file=.env.local scripts/corrigir-assoc-conjuntos.mjs --limite 50
```

- Fonte: `audit_conjuntos_assoc_errada_detalhe.csv` (1.394 linhas cross_building=True)
- 322 casos com andar_associado=0 (andar com floor number 0 no edifício errado)
- Progresso salvo em `.progress-corrigir-assoc.json` (idempotente)

### P2 — Criar `nome_do_ocupante` e importar ocupantes

```bash
# Dry-run
node --env-file=.env.local scripts/importar-ocupantes.mjs --dry-run

# Execução real (17.586 conjuntos)
node --env-file=.env.local scripts/importar-ocupantes.mjs
```

- Cria a propriedade `nome_do_ocupante` no objeto Conjunto (se não existir)
- Importa ~15.744 nomes de ocupantes da planilha Excel
- Exclui placeholders "-- Vago --" e "-- Informação Pendente --"
- Progresso em `.progress-ocupantes.json`

### P3 — Corrigir Quota Corporate duplicado

```bash
node --env-file=.env.local scripts/corrigir-quota-duplicado.mjs --dry-run
node --env-file=.env.local scripts/corrigir-quota-duplicado.mjs
```

- Move 10 andares do edifício duplicado (58881378138) → edifício oficial (58797958039)
- Move conjuntos desses andares para os andares corretos
- Arquiva o edifício duplicado
- **Manual pós-script:** associar condomínio correto ao edifício oficial no HubSpot

### P4 — Arquivar 55 andares órfãos (SPCT legado)

```bash
node --env-file=.env.local scripts/arquivar-andares-orfaos.mjs --dry-run
node --env-file=.env.local scripts/arquivar-andares-orfaos.mjs
```

- Verifica que nenhum tem conjuntos antes de arquivar
- Fonte: `audit_andares_orfaos.csv`

### P5 — Corrigir 106 campos divergentes

```bash
node --env-file=.env.local scripts/corrigir-campos-conjuntos.mjs --dry-run
node --env-file=.env.local scripts/corrigir-campos-conjuntos.mjs
```

- 42 divergências de `area_m2`, 22 de `disponibilidade`, 42 de `nome_do_proprietario`
- Fonte: `audit_conjuntos_mismatches.csv`
- Progresso em `.progress-corrigir-campos.json`

---

## Ordem recomendada de execução

```
P1 → P2 → P3 → P4 → P5
```

P1 é crítico porque 1.394 conjuntos no lugar errado distorce qualquer relatório por torre.
P2 é o principal dado faltando (ocupante).
P3 é isolado (1 edifício).
P4 e P5 são limpeza residual.

---

## Problema detectado mas não coberto pelos scripts

**Placeholder do proprietário:** 2.324 conjuntos têm `nome_do_proprietario = "-- Informação Pendente --"`
e 682 têm `"Não informado"`. Para padronizar, executar via HubSpot Bulk Update ou script adicional.
