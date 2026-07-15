# Propriedades HubSpot — Portal ATIE (51253038)
> Versão 2026-07-15 · Ruy Spinola / Scient

Documento de referência para a equipe técnica da AW (Léo Pais, Marcello Delai) consumir a API do HubSpot.
Cobre: objetos existentes, nomes internos dos campos, mapeamento Focus → HubSpot e gaps a criar.

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

### 3.2 Campos customizados `aw_*` — estado atual

| Nome interno | Tipo | Descrição Focus | Status |
|---|---|---|---|
| `aw_id_interno` | string | `IdProjeto` — ID do projeto no Focus | ✅ Existe |
| `aw_id_projeto_pai` | string | `IdProjetoPai` — ID do projeto pai | ✅ Existe |
| `aw_edificio_id` | string | Nome do edifício (fallback sem Andar) | ✅ Criado hoje |
| `aw_rotulo_pendente` | boolean | Flag: empresa associada sem rótulo | ✅ Existe |
| `aw_numero_projeto` | string | `NumeroProjeto` ex: "4703/24" | ⚠️ Verificar |
| `aw_tipo_de_negocio` | enum | `Escopo` — Obra / Projeto / Projeto e Obra | ⚠️ Verificar |
| `aw_area_m2` | number | `Area` em m² | ⚠️ Verificar |
| `aw_valor_m2_projeto` | number | `ValorMetro` — valor por m² | ⚠️ Verificar |
| `aw_natureza_valor` | enum | `NaturezaValor` — Estimado / Informado | ⚠️ Verificar |
| `aw_budget_declarado_total` | number | `BudgetDeclarado` | ⚠️ Verificar |
| `aw_fonte_de_origem` | enum | `Origem` | ⚠️ Verificar |
| `aw_setor_cliente` | enum | `RamoAtividade` | ⚠️ Verificar |
| `aw_envolvimento_comercial` | enum | `EnvolvimentoComercial` | ⚠️ Verificar |
| `aw_responsabilidade_den` | boolean | `ResponsabilidadeDEN` | ⚠️ Verificar |
| `aw_apalavrado_com_cliente` | boolean | `Apalavrado` | ⚠️ Verificar |
| `aw_probabilidade_negocio_existir` | enum | `ProbabilidadeNegocioExistir` | ⚠️ Verificar |
| `aw_local` | enum | `AreaAtuacao` — localização geográfica | ⚠️ Verificar |
| `aw_gerenciadoras_obs` | string | Observações sobre gerenciadoras | ⚠️ Verificar |
| `aw_substatus` | string | `SubStatus` | ⚠️ Verificar |
| `aw_data_previsao_original` | date | `DataFechamentoOriginal` | ⚠️ Verificar |
| `aw_den_comercial` | string | `DENComercial` | ⚠️ Verificar |
| `aw_projeto_top` | boolean | `ProjetoTOP` | ⚠️ Verificar |
| `aw_new_business` | string | `NewBusiness` | ⚠️ Verificar |
| `aw_chances_ganhar` | string | `ChancesGanhar` ex: "70% a 90%" | ❌ A criar |
| `aw_frequencia_comercial` | string | `FrequenciaComercial` ex: "conta 1M (mensal)" | ❌ A criar |
| `aw_id_agrupador` | string | `IdAgrupador` — agrupador de fases | ❌ A criar |
| `aw_conta_negocio` | string | `ContaNegocio` | ❌ A criar |

> **Legenda**: ✅ Confirmado no código ativo · ⚠️ Criado em script anterior, verificar se ainda existe no portal · ❌ Ainda não existe

### 3.3 Campos Focus sem mapeamento direto (tratados como associações)

| Campo Focus | Como tratar no HubSpot |
|---|---|
| `GrupoComercial` / `IdGrupoComercial` | Associação Deal → Company com rótulo **Cliente Final**; usar `aw_id_focus` da company |
| `Gerenciadora` / `IdGerenciadora` | Associação Deal → Company com rótulo **Gerenciadora** |
| `Broker` / `IdBrokerLocacoes` | Associação Deal → Company com rótulo **Broker** |
| `Concorrentes` | Associação Deal → Company com rótulo **Concorrente** |
| `GerenteComercial` / `IdGerenteComercial` | `hubspot_owner_id` (buscar owner pelo nome) |
| `GerenteComercialConta` / `IdGerenteComercialConta` | Campo owner — a definir |
| `DEN` / `IdDEN` | Campo owner — a definir |
| `FuncionarioAbertura` / `IdFuncionarioAbertura` | Campo owner — a definir |
| `JsonEdificios` | Associação Deal → Andar → Edifício (custom objects) |
| `JsonContatos` | Associação Deal → Contact |

---

## 4. Companies

### 4.1 Campos padrão relevantes

| Nome interno | Tipo | Descrição |
|---|---|---|
| `name` | string | Nome da empresa |
| `hs_object_id` | string | ID interno HubSpot — **retornar para o Focus** |
| `createdate` | datetime | Data de criação |
| `hs_lastmodifieddate` | datetime | Cursor de sync |

### 4.2 Campo de sincronização com Focus

| Nome interno | Tipo | Descrição | Status |
|---|---|---|---|
| `aw_id_focus` | string | ID da empresa no Focus (IdGrupoComercial, IdGerenciadora etc.) | ❌ A criar |

> **Importante**: este campo é a chave de correlação. Quando o Focus enviar uma company com `IdGrupoComercial=1234`, o HubSpot deve armazenar `aw_id_focus=1234` para que futuras atualizações encontrem o registro sem duplicar.

### 4.3 Rótulos de associação Deal → Company

Os rótulos são definidos por `associationCategory: "USER_DEFINED"` na API v4.

| Rótulo | Descrição | Equivalente Focus |
|---|---|---|
| `Cliente Final` | Empresa contratante do projeto | `GrupoComercial` |
| `Gerenciadora` | Gerenciadora do imóvel | `Gerenciadora` |
| `Broker` | Broker de locação | `Broker` |
| `Concorrente` | Escritório concorrente no deal | `Concorrentes[]` |

Para obter os `associationTypeId` de cada rótulo:
```
GET /crm/v4/associations/deals/companies/labels
Authorization: Bearer <TOKEN>
```

---

## 5. Edifícios (`p51253038_edificios`)

### 5.1 Campos existentes

| Nome interno | Tipo | Descrição | Status |
|---|---|---|---|
| `nome_do_edificio` | string | Nome do edifício/condomínio | ✅ Existe |
| `cnpj_do_condominio` | string | CNPJ do condomínio | ✅ Existe |
| `aw_id_focus` | string | ID do edifício/condomínio no Focus | ✅ Existe |
| `andares_ocupados_pelo_cliente` | string | Lista de andares (uso interno Teia) | ✅ Existe |

### 5.2 Campos do Focus a mapear

| Campo Focus (JsonEdificios) | Nome sugerido HubSpot | Status |
|---|---|---|
| `IdCondominio` | → `aw_id_focus` (condomínio) | ✅ Existe |
| `NomeCondominio` | → `nome_do_edificio` | ✅ Existe |
| `IdEdificio` | `aw_id_edificio_focus` | ❌ A criar |
| `NomeEdificio` | `nome_torre` | ❌ A criar |
| `IdEdificioPavimento` | → ID do objeto Andar | Via associação |
| `NomeEdificioPavimento` | → `nome_do_andar` | Via associação |

> **Nota estrutural**: no Focus, a hierarquia é Condomínio → Edifício (torre) → Pavimento (andar). No HubSpot temos Edifício → Andar. Sugestão: o objeto Edifício no HubSpot = torre específica (ex: "CENU Torre Norte"), não o condomínio inteiro.

### 5.3 Campos da CRETool a mapear (integração futura)

| Campo CRETool | Nome sugerido HubSpot | Status |
|---|---|---|
| `building_id` | `aw_id_cretool` | ❌ A criar |
| `perfil` | `perfil_edificio` | ❌ A criar |
| `classe` | `classe_edificio` | ❌ A criar |
| `logradouro` + `numero` | `endereco` | ❌ A criar |
| `cep` | `cep` | ❌ A criar |
| `microrregiao` | `microrregiao` | ❌ A criar |
| `regiao` | `regiao` | ❌ A criar |
| `latitude` / `longitude` | `latitude` / `longitude` | ❌ A criar |
| `updated_at` | → `hs_lastmodifieddate` (padrão) | ✅ Automático |

---

## 6. Andares (`p51253038_andares`)

### 6.1 Campos existentes

| Nome interno | Tipo | Descrição | Status |
|---|---|---|---|
| `nome_do_andar` | string | Nome/rótulo (ex: "7º Andar") | ✅ Existe |
| `numero_do_andar` | string | Número sequencial | ✅ Existe |

### 6.2 Campos a criar para sync com Focus

| Campo Focus | Nome sugerido HubSpot | Tipo | Status |
|---|---|---|---|
| `IdEdificioPavimento` | `aw_id_focus` | string | ❌ A criar |
| `NomeEdificioPavimento` | → `nome_do_andar` | string | ✅ Existe |

### 6.3 Campos da CRETool a mapear

| Campo CRETool | Nome sugerido HubSpot | Status |
|---|---|---|
| `unit_id` | `aw_id_cretool_unit` | ❌ A criar |
| `area_locavel_m2` | `area_locavel_m2` | ❌ A criar |
| `area_privativa_m2` | `area_privativa_m2` | ❌ A criar |
| `area_boma_m2` | `area_boma_m2` | ❌ A criar |
| `area_construida_m2` | `area_construida_m2` | ❌ A criar |
| `possui_terraco` | `possui_terraco` | ❌ A criar |
| `preco_locacao_m2` | `preco_locacao_m2` | ❌ A criar |
| `condominio_m2` | `condominio_m2` | ❌ A criar |
| `iptu_m2` | `iptu_m2` | ❌ A criar |
| `andares_disponiveis` | `disponibilidade` | ❌ A criar |

---

## 7. Endpoints principais da API HubSpot

### Listar registros com cursor de sync
```
GET /crm/v3/objects/{objectType}?limit=100&properties=aw_id_focus,name,hs_lastmodifieddate&after={cursor}
```

### Buscar por campo (ex: aw_id_focus)
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
[{ "associationCategory": "USER_DEFINED", "associationTypeId": <ID_DO_ROTULO> }]
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

---

## 8. Sequência de sincronização recomendada (Dia Zero)

1. **Companies** — importar todos os grupos comerciais, gerenciadoras, brokers, concorrentes do Focus → HubSpot devolve `hs_object_id` → Focus armazena como `id_hubspot`
2. **Edifícios** — importar condomínios/edifícios → HubSpot devolve IDs → Focus armazena
3. **Andares** — importar pavimentos → associar a Edifício → Focus armazena
4. **Deals** — importar projetos ativos → associar companies (com rótulos) + andares
5. **Contacts** — importar contatos → associar a companies e deals

### Após Dia Zero — sync incremental
```
A cada N minutos:
  1. Buscar companies/deals/edifícios com hs_lastmodifieddate >= última_sync
  2. Para cada registro novo: criar no Focus; Focus devolve IdFocus
  3. PATCH no HubSpot: setar aw_id_focus = IdFocus (para fechar o loop)
```

---

## 9. Resumo de gaps — campos a criar no HubSpot

### Deals (❌ a criar)
| Campo | Tipo | Focus |
|---|---|---|
| `aw_chances_ganhar` | string | `ChancesGanhar` |
| `aw_frequencia_comercial` | string | `FrequenciaComercial` |
| `aw_id_agrupador` | string | `IdAgrupador` |
| `aw_conta_negocio` | string | `ContaNegocio` |

### Companies (❌ a criar)
| Campo | Tipo | Finalidade |
|---|---|---|
| `aw_id_focus` | string | Chave de correlação Focus ↔ HubSpot |

### Edifícios (❌ a criar)
| Campo | Tipo | Fonte |
|---|---|---|
| `aw_id_edificio_focus` | string | IdEdificio (torre específica) no Focus |
| `nome_torre` | string | NomeEdificio no Focus |
| `aw_id_cretool` | string | building_id da CRETool |
| `perfil_edificio` | string | CRETool |
| `classe_edificio` | string | CRETool |
| `endereco` | string | CRETool |
| `cep` | string | CRETool |
| `regiao` | string | CRETool |
| `microrregiao` | string | CRETool |
| `latitude` | number | CRETool |
| `longitude` | number | CRETool |

### Andares (❌ a criar)
| Campo | Tipo | Fonte |
|---|---|---|
| `aw_id_focus` | string | IdEdificioPavimento no Focus |
| `aw_id_cretool_unit` | string | unit_id da CRETool |
| `area_locavel_m2` | number | CRETool |
| `area_privativa_m2` | number | CRETool |
| `area_boma_m2` | number | CRETool |
| `area_construida_m2` | number | CRETool |
| `possui_terraco` | boolean | CRETool |
| `preco_locacao_m2` | number | CRETool |
| `condominio_m2` | number | CRETool |
| `iptu_m2` | number | CRETool |
| `disponibilidade` | string | CRETool |

---

## 10. Campos Focus sem equivalente óbvio — decisão pendente

| Campo Focus | Observação |
|---|---|
| `IdNewBusiness` / `NewBusiness` | Classificação de "novo negócio" — criar `aw_new_business` ou ignorar? |
| `IdContaNegocio` / `ContaNegocio` | Pode ser redundante com `GrupoComercial` — confirmar com AW |
| `IdDENComercial` / `DENComercial` | Diferente do DEN técnico? Confirmar hierarquia |
| `IdSubStatus` / `SubStatus` | Sub-status do deal — criar enum ou campo texto? |
| `IdAgrupador` | Agrupa projetos pai/filho — `aw_id_agrupador` texto ou number? |
| `Lucratividade` | Campo sensível — confirmar se deve ir para o HubSpot |
