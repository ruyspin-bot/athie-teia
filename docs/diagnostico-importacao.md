# Relatório-resumo de conclusão dos dados — HubSpot ATIE
_Gerado em 2026-07-20 · fonte: HubSpot (portal 51253038) · dados reais do pipeline._

Base ativa: **1034 deals** (negócios), **100.0% com ID Focus** (`aw_id_interno`) — o que permite atualização em massa por código a qualquer momento.

---

## 1. Limpeza de contatos ✅ (concluída)

Os contatos que subiram como **nome de empresa, sem e-mail e sem telefone** foram removidos da base ativa (arquivados na lixeira do HubSpot). O e-mail é a chave única de um contato no HubSpot, então sem e-mail/telefone o registro não tem utilidade pro vendedor.

| Situação | Qtd |
|---|---:|
| Contatos ativos na base | 0 |
| Contatos arquivados (removidos na limpeza) | 97 |
| — destes, sem e-mail e sem telefone | 72 |
| — destes, nome "parece empresa" | 6 |

➡️ **Pendência (Athié):** puxar a base de contatos **com e-mail** para reimportação — aí os contatos voltam já vinculados corretamente.

---

## 2. Proprietário do Negócio (owner comercial)

| Situação | Qtd | % dos deals |
|---|---:|---:|
| Deals com owner definido | 286 | 27.7% |
| Deals sem owner (vazio) | 748 | 72.3% |

O que trava os 748 restantes é que **vários comerciais ainda não existem como usuário no HubSpot** (ex.: Jennifer, Clarissa, Juliana, Karine, Laura, Marcos). Sem o usuário cadastrado, não é possível atribuí-lo como proprietário.

➡️ **Pendência (Athié):** cadastrar no HubSpot os comerciais que faltam.
➡️ **Comigo:** assim que forem cadastrados, atribuo os owners em massa (via ID Focus, presente em 100.0% dos deals).

---

## 3. Ajustes na Teia ✅ (concluídos)

- Corrigido o nó que ficava "preso" no mouse ao clicar.
- Clique mais preciso — sem precisar dar tanto zoom pra acertar o negócio.
- A visão de prédios reflete só os edifícios **relacionados** ao nó; quando não há relação, mostra o aviso na tela.
- O painel **Detalhe** acompanha a navegação entre prédios e os filtros por ator.

---

## Resumo executivo

| Frente | Status |
|---|---|
| Limpeza de contatos | ✅ Concluída (97 removidos) — aguardando base com e-mail (Athié) |
| Proprietário do Negócio | 🟡 286/1034 definidos — faltam cadastrar comerciais (Athié) |
| Ajustes na Teia | ✅ Concluídos |
| Treinamento com o CEO | 📅 A agendar |

**Pendências com a Athié:** (1) base de contatos com e-mail; (2) cadastrar os proprietários/comerciais que faltam; (3) agendar o treinamento com o CEO.
