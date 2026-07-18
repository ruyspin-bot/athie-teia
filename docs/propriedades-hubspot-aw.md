# Propriedades HubSpot — Portal ATIE (51253038)
> Versão 2026-07-15 v2 · Ruy Spinola / Scient
> Atualizado após auditoria completa via API + criação de propriedades faltantes.

Documento de referência para a equipe técnica da AW (Léo Pais, Marcello Delai) consumir a API do HubSpot.
Cobre: objetos existentes, nomes internos dos campos, mapeamento Focus → HubSpot e rótulos de associação.

**Estado atual: todos os campos necessários estão criados no portal.**

---

## 1. Acesso à API

- **Base URL**: `https://api.hubapi.com`
- **Autenticação**: `Authorization: Bearer <TOKEN>` (token fornecido via canal seguro)
- **Portal ID**: `51253038`
- **Documentação oficial**: https://developers.hubspot.com/docs/api/crm/crm-custom-objects

---

## 2. Objetos do portal

| Objeto | ObjectTypeId | Descrição |
|--------|-------------|-----------|
| Deals | `deals` | Negócios/projetos |
| Companies | `companies` | Empresas (clientes, gerenciadoras, brokers, concorrentes) |
| Contacts | `contacts` | Contatos de pessoas |
| Edifícios | `p51253038_edificios` | Custom object — edifícios/condomínios |
| Andares | `p51253038_andares` | Custom object — pavimentos dentro dos edifícios |
| Conjuntos | `p51253038_conjuntos` | Custom object — unidades/conjuntos dentro dos andares |

---

## 3. Deals

### 3.1 Campos padrão relevantes

| Nome interno | Tipo | Descrição |
|---|---|---|
| `dealname` | string | Nome do negócio |
| `pipeline` | string | ID do pipeline |
| `dealstage` | string | ID do stage atual |
| `amount` | number | Valor total estimado (R$) |
| `closedate` | datetime | Data prevista de fechamento |
| `hubspot_owner_id` | string | ID numérico do owner (Gerente Comercial) |
| `hs_object_id` | string | ID interno HubSpot do deal |
| `createdate` | datetime | Data de criação |
| `hs_lastmodifieddate` | datetime | Data de última modificação — **usar como cursor de sync** |

### 3.2 Campos customizados `aw_*`

Todos os campos abaixo existem no portal. Auditados via API em 2026-07-15 (107 campos `aw_*` confirmados).

| Nome interno | Tipo | Descrição / Campo Focus |
|---|---|---|
| `aw_id_interno` | string | `IdProjeto` — chave primária de dedup Focus ↔ HubSpot |
| `aw_id_projeto_pai` | string | `IdProjetoPai` — projeto pai (hierarquia) |
| `aw_numero_projeto` | string | `NumeroProjeto` ex: "4703/24" |
| `aw_tipo_de_negocio` | enum | `Escopo` — Obra / Projeto / Projeto e Obra |
| `aw_area_m2` | number | `Area` em m² |
| `aw_valor_m2_projeto` | number | `ValorMetro` — valor por m² |
| `aw_natureza_valor` | enum | `NaturezaValor` — Estimado / Informado |
| `aw_budget_declarado_total` | number | `BudgetDeclarado` total |
| `aw_fonte_de_origem` | enum | `Origem` do deal |
| `aw_setor_cliente` | enum | `RamoAtividade` |
| `aw_envolvimento_comercial` | enum | `EnvolvimentoComercial` |
| `aw_responsabilidade_den` | boolean | `ResponsabilidadeDEN` |
| `aw_apalavrado_com_cliente` | boolean | `Apalavrado` |
| `aw_probabilidade_negocio_existir` | enum | `ProbabilidadeNegocioExistir` |
| `aw_local` | string | `AreaAtuacao` — localização geográfica |
| `aw_gerenciadoras_obs` | string | Observações sobre gerenciadoras |
| `aw_substatus` | string | `SubStatus` |
| `aw_data_previsao_original` | date | `DataFechamentoOriginal` |
| `aw_den_comercial` | string | `DENComercial` |
| `aw_projeto_top` | boolean | `ProjetoTOP` |
| `aw_new_business` | string | `NewBusiness` |
| `aw_chances_ganhar` | string | `ChancesGanhar` ex: "70% a 90%" |
| `aw_frequencia_comercial` | string | `FrequenciaComercial` ex: "conta 1M (mensal)" |
| `aw_id_agrupador` | string | `IdAgrupador` — agrupa fases do mesmo negócio |
| `aw_conta_negocio` | string | `ContaNegocio` ex: "DNN - Interiores SP" |
| `aw_probabilidade_negocio_existir` | enum | `ProbabilidadeNegocioExistir` |
| `aw_envolvimento_comercial` | enum | `EnvolvimentoComercial` |
| `aw_natureza_valor` | enum | `NaturezaValor` — Estimado / Informado |
| `aw_budget_declarado_total` | number | `BudgetDeclarado` |
| `aw_setor_cliente` | enum | `RamoAtividade` |
| `aw_local` | string | `AreaAtuacao` — localização geográfica |
| `aw_edificio_id` | string | Nome do edifício (fallback para deals sem Andar) |
| `aw_rotulo_pendente` | boolean | Flag interna: empresa associada sem rótulo definido |

### 3.3 Campos tratados como associações (não campos diretos)

| Campo Focus | Como tratar no HubSpot | Status importação |
|---|---|---|
| `GrupoComercial` / `IdGrupoComercial` | Deal → Company (rótulo **Cliente Final**) | ⚠️ fase 2 |
| `Gerenciadora` / `IdGerenciadora` | Deal → Company (rótulo **Gerenciadora**) | ⚠️ fase 2 |
| `Broker` / `IdBrokerLocacoes` | Deal → Company (rótulo **Broker**) | ⚠️ fase 2 |
| `Concorrentes` | Deal → Company (rótulo **Concorrente**) — um por item | ⚠️ fase 2 |
| `GerenteComercial` / `IdGerenteComercial` | `hubspot_owner_id` (buscar owner pelo nome) | ⚠️ fase 2 |
| `JsonEdificios` | Deal → Andar → Edifício (custom objects) | ⚠️ fase 2 |
| `JsonContatos` | Deal → Contact | ⚠️ fase 2 |

> Fase 2 = após importar companies, edifícios e andares (Dia Zero completo).

### 3.4 Mapeamento de stages Focus → HubSpot

| Status Focus | Stage HubSpot | Stage ID |
|---|---|---|
| `LEAD`, `LEAD QLF` | Recebido no Núcleo | `1360364548` |
| `QLF` | Estratégia Definida | `1360364552` |
| `LEV` | Diagnóstico / Briefing / Test Fit | `1366396702` |
| `EPP` | Proposta Apresentada | `1360364554` |
| `NEG` | Em Negociação / Short List | `1360364555` |
| `AP` | Go/No-Go 2 — Aprovação | `1375049221` |
| `OBRA`, `EX`, `AS BUILT`, `CHECKLIST` | Contrato Assinado | `1360364557` |

---

## 4. Companies

### 4.1 Campos padrão relevantes

| Nome interno | Tipo | Descrição |
|---|---|---|
| `name` | string | Nome da empresa |
| `hs_object_id` | string | ID interno HubSpot — **retornar para o Focus após criar** |
| `createdate` | datetime | Data de criação |
| `hs_lastmodifieddate` | datetime | Cursor de sync |

### 4.2 Campos customizados `aw_*`

| Nome interno | Tipo | Descrição |
|---|---|---|
| `aw_id_focus` | string | ID master da empresa no Focus — chave de correlação principal |
| `aw_id_grupo_comercial` | string | `IdGrupoComercial` quando a empresa age como Cliente Final |
| `aw_id_gerenciadora` | string | `IdGerenciadora` quando a empresa age como Gerenciadora |
| `aw_id_broker` | string | `IdBrokerLocacoes` quando a empresa age como Broker |

> **Por que 4 campos?** A mesma empresa pode aparecer com IDs diferentes em tabelas Focus distintas (tabela de grupos comerciais, tabela de gerenciadoras, tabela de brokers). Os campos `aw_id_*` por papel guardam esses IDs até que Delai forneça a tabela mestre. `aw_id_focus` receberá o ID canônico da tabela mestre após reconciliação.

### 4.3 Rótulos de associação Deal → Company

Os rótulos são definidos por `associationCategory: "USER_DEFINED"` na API v4.

| Rótulo | `associationTypeId` | Equivalente Focus |
|---|---|---|
| `Cliente Final` | `1` | `GrupoComercial` |
| `Gerenciadora` | `3` | `Gerenciadora` |
| `Broker` | `7` | `Broker` |
| `Concorrente` | `15` | `Concorrentes[]` |

Para verificar/listar os rótulos disponíveis:
```
GET /crm/v4/associations/deals/companies/labels
Authorization: Bearer <TOKEN>
```

---

## 5. Edifícios (`p51253038_edificios`)

### 5.1 Campos Focus

| Nome interno | Tipo | Descrição | Campo Focus |
|---|---|---|---|
| `nome_do_edificio` | string | Nome do condomínio | `NomeCondominio` |
| `aw_id_focus` | string | ID do condomínio no Focus | `IdCondominio` |
| `aw_id_edificio_focus` | string | ID da torre específica no Focus | `IdEdificio` |
| `nome_torre` | string | Nome da torre (ex: "Torre Norte") | `NomeEdificio` |
| `cnpj_do_condominio` | string | CNPJ do condomínio | — |
| `andares_ocupados_pelo_cliente` | string | Lista de andares (uso interno Teia) | — |

> **Nota estrutural**: no Focus, a hierarquia é Condomínio → Edifício (torre) → Pavimento (andar). No HubSpot: Edifício → Andar. O objeto Edifício no HubSpot representa a **torre específica** (ex: "CENU Torre Norte"), não o condomínio inteiro. `aw_id_focus` guarda o `IdCondominio` e `aw_id_edificio_focus` guarda o `IdEdificio` (torre).

### 5.2 Campos CRETool Buildings

| Nome interno | Tipo | Campo CRETool |
|---|---|---|
| `aw_id_cretool` | string | `building_id` — chave para enriquecimento de mercado |
| `classe_edificio` | string | `classe` ex: "Classe A" |
| `perfil_edificio` | string | `perfil` ex: "Corporate" |
| `endereco` | string | `logradouro` + `numero` |
| `cep` | string | `cep` |
| `regiao` | string | `regiao` ex: "Berrini", "Faria Lima" |
| `microrregiao` | string | `microrregiao` ex: "Marginal - Brooklin Novo" |
| `latitude` | number | `latitude` |
| `longitude` | number | `longitude` |

---

## 6. Andares (`p51253038_andares`)

### 6.1 Campos Focus

| Nome interno | Tipo | Descrição | Campo Focus |
|---|---|---|---|
| `nome_do_andar` | string | Nome/rótulo (ex: "7º Andar") | `NomeEdificioPavimento` |
| `numero_do_andar` | string | Número sequencial | — |
| `aw_id_focus` | string | ID do pavimento no Focus — chave de dedup | `IdEdificioPavimento` |

### 6.2 Campos CRETool Buildings

| Nome interno | Tipo | Campo CRETool |
|---|---|---|
| `aw_id_cretool_unit` | string | `unit_id` — identifica andar+conjunto |
| `area_locavel_m2` | number | `area_locavel_m2` |
| `area_privativa_m2` | number | `area_privativa_m2` |
| `area_boma_m2` | number | `area_boma_m2` |
| `area_construida_m2` | number | `area_construida_m2` |
| `preco_locacao_m2` | number | Preço pedido de locação (R$/m²) |
| `condominio_m2` | number | Condomínio (R$/m²) |
| `iptu_m2` | number | IPTU (R$/m²) |
| `disponibilidade` | string | Status de disponibilidade |

---

## 7. Conjuntos (`p51253038_conjuntos`)

Unidades ou conjuntos dentro de um andar. ObjectTypeId interno: `2-65811627`.

### 7.1 Campos existentes

| Nome interno | Tipo | Descrição |
|---|---|---|
| `hs_object_id` | number | ID interno HubSpot — **retornar para o Focus após criar** |
| `hs_lastmodifieddate` | datetime | Cursor de sync |
| `nome_do_proprietario` | string | Nome do proprietário do conjunto |

### 7.2 Campos customizados criados em 2026-07-15

| Nome interno | Tipo | Campo Focus | Descrição |
|---|---|---|---|
| `aw_id_focus` | string | `IdConjunto` (a confirmar) | Chave primária de dedup |
| `nome_do_conjunto` | string | Nome do conjunto | Ex: "Conjunto 71", "Sala 1201" |
| `area_m2` | number | Área do conjunto | m² do conjunto específico |
| `disponibilidade` | string | Status | Disponível / Locado / Em obras |

> Hierarquia completa: **Edifício → Andar → Conjunto**. O conjunto é a unidade locável final.

---

## 8. Endpoints principais

### Listar registros com cursor de sync
```
GET /crm/v3/objects/{objectType}?limit=100&properties=aw_id_focus,name,hs_lastmodifieddate&after={cursor}
```

### Buscar por campo (ex: dedup por aw_id_focus)
```
POST /crm/v3/objects/{objectType}/search
{
  "filterGroups": [{
    "filters": [{"propertyName": "aw_id_focus", "operator": "EQ", "value": "1234"}]
  }],
  "properties": ["name", "aw_id_focus", "hs_object_id"],
  "limit": 1
}
```

### Criar registro
```
POST /crm/v3/objects/{objectType}
{ "properties": { "name": "...", "aw_id_focus": "..." } }
```

### Atualizar registro
```
PATCH /crm/v3/objects/{objectType}/{objectId}
{ "properties": { "campo": "valor" } }
```

### Criar associação com rótulo (Deal → Company)
```
PUT /crm/v4/objects/deals/{dealId}/associations/companies/{companyId}
[{ "associationCategory": "USER_DEFINED", "associationTypeId": 1 }]
```

### Listar alterações desde data (incremental)
```
POST /crm/v3/objects/{objectType}/search
{
  "filterGroups": [{
    "filters": [{
      "propertyName": "hs_lastmodifieddate",
      "operator": "GTE",
      "value": "2026-07-15T09:00:00.000Z"
    }]
  }],
  "sorts": [{"propertyName": "hs_lastmodifieddate", "direction": "ASCENDING"}],
  "limit": 100
}
```

### Buscar deals por aw_id_interno (dedup)
```
POST /crm/v3/objects/deals/search
{
  "filterGroups": [{
    "filters": [{"propertyName": "aw_id_interno", "operator": "EQ", "value": "12345"}]
  }],
  "properties": ["dealname", "aw_id_interno", "hs_object_id"],
  "limit": 1
}
```

---

## 8. Sequência de importação — Dia Zero

1. **Companies** — importar grupos comerciais, gerenciadoras, brokers, concorrentes do Focus. HubSpot devolve `hs_object_id` → Focus armazena como `id_hubspot`.
2. **Edifícios** — importar condomínios/torres. HubSpot devolve IDs → Focus armazena.
3. **Andares** — importar pavimentos → associar ao Edifício pai → Focus armazena.
4. **Deals** — importar projetos ativos → associar companies (com rótulos) + andares.
5. **Contacts** — importar contatos → associar a companies e deals.

### Sync incremental (após Dia Zero)
```
A cada N minutos:
  1. Buscar companies/deals/edifícios com hs_lastmodifieddate >= última_sync
  2. Para cada registro novo: criar no Focus; Focus devolve IdFocus
  3. PATCH no HubSpot: setar aw_id_focus = IdFocus (fechar o loop)
```

---

## 9. Campos Focus sem mapeamento direto — pendentes de decisão

| Campo Focus | Observação |
|---|---|
| `IdDENComercial` / `DENComercial` | Diferente do DEN técnico? Confirmar hierarquia com AW |
| `Lucratividade` | Campo sensível — confirmar se deve ir para o HubSpot |
| `GerenteComercialConta` / `IdGerenteComercialConta` | Owner secundário — definir campo `aw_owner_conta` ou ignorar? |
| `DEN` / `IdDEN` | DEN técnico vs DEN comercial — confirmar mapeamento |
