# Liga Betclic 2026/27 — PWA

App de acompanhamento da Liga Portugal Betclic 2026/27: calendário por jornada, resultados em tempo quase real, marcadores, cartões, classificação, vista por clube, Modo TV e instalação como PWA com atualizações automáticas. Desenvolvida nos moldes da app do Mundial 2026.

## Deploy no Netlify (5 minutos)

1. Cria uma conta gratuita em https://www.football-data.org/client/register e guarda a API key (chega ao email).
2. No Netlify: **Add new site → Deploy manually** e arrasta esta pasta (ou liga a um repositório Git).
3. Em **Site configuration → Environment variables** adiciona:
   - `FOOTBALL_DATA_KEY` = a tua chave da football-data.org
4. Redeploy. A partir daí a app vai buscar sozinha o calendário completo (306 jogos), datas/horas oficiais, resultados, classificação e melhores marcadores da Primeira Liga (código `PPL`, época 2026).

Sem a chave configurada, a app funciona na mesma com o calendário base (`data/seed.json`) e mostra um aviso de que os resultados em direto estão indisponíveis.

## Como os dados funcionam (3 camadas)

1. **`data/seed.json`** — base local: 18 equipas, datas-base das 34 jornadas, jogos já conhecidos (todos os do Sporting, jornadas 1 e 34 completas, clássicos). Serve de fallback offline/sem API.
2. **API football-data.org** — via função serverless (`netlify/functions/api.js`, a chave nunca chega ao browser). Preenche e atualiza tudo automaticamente: fixtures em falta, datas/horas oficiais (estado `TIMED`), resultados ao vivo, golos, cartões, classificação, marcadores.
3. **`data/overrides.json`** — acertos manuais que **ganham sempre** à API: canais de TV, correções de data/hora, jogos adiados, notas. Formato documentado dentro do próprio ficheiro. Os canais por omissão definem-se em `tvDefaults` (por equipa da casa; `*` = resto).

Exemplo de override:
```json
{ "j": 5, "home": "SCP", "away": "NAC", "date": "2026-09-05", "time": "18:00", "tv": "Sport TV1", "confirmed": true }
```

## Tempo real

- Durante jogos (ou em dias de jogos) a app atualiza a cada **60 segundos**; fora disso a cada 10 minutos e sempre que a app volta a primeiro plano.
- Nota: o plano gratuito da football-data.org tem resultados com **ligeiro atraso** (não é streaming ao segundo) e limite de 10 pedidos/minuto — a função serverless faz cache para nunca ultrapassar o limite, mesmo com muitos utilizadores. Para latência menor existe o plano pago.

## Atualizações automáticas da PWA

O service worker (`sw.js`) usa network-first: cada visita traz a versão mais recente. Quando publicares alterações, os utilizadores com a app aberta recebem um aviso "Nova versão disponível → Atualizar". Ao alterares ficheiros do shell, sobe a constante `VERSION` no `sw.js` para forçar limpeza de cache.

## Estrutura

```
index.html                  UI (separadores Jogos / Classificação / Clubes)
css/styles.css              estilos (mobile-first + desktop)
js/app.js                   lógica: merge seed+API+overrides, render, polling, PWA
data/seed.json              calendário base e equipas
data/overrides.json         acertos manuais (TV, datas, adiamentos)
netlify/functions/api.js    proxy com cache para a football-data.org
netlify.toml                redirects /api/* e headers de cache
sw.js + manifest.webmanifest + icons/   PWA
```

## Desenvolvimento local

```
npm i -g netlify-cli
netlify dev        # serve o site + funções em http://localhost:8888
```
(Define `FOOTBALL_DATA_KEY` num ficheiro `.env` na raiz.)

---
app desenvolvida por Caixa Mágica Software
