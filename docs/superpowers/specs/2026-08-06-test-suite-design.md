# Test suite per substack-mcp — Design

Data: 2026-08-06
Stato: approvato

## Obiettivo

Introdurre una suite di test automatici che protegga `substack-mcp` dalle regressioni nel
tempo. La suite comprende unit test e integration test. Nessun test deve raggiungere un
servizio esterno reale: ogni chiamata HTTP in uscita è intercettata e mockata, e una
richiesta non mockata deve far fallire il test.

I test sono di **caratterizzazione**: bloccano il comportamento *attuale* del codice, non
quello desiderato. Eventuali anomalie riscontrate vengono documentate nei test e riportate
all'autore, non corrette in questo intervento.

## Vincoli

- Test runner nativo di Node (`node:test` + `node:assert`), nessun framework di test esterno.
- Node 22 (`.nvmrc` → `v22.15.0`), progetto ESM (`"type": "module"`).
- Nessun flag sperimentale richiesto per `npm test` (la coverage resta uno script separato).
- Unica dipendenza di sviluppo aggiunta: `msw` (v2) per l'intercettazione HTTP.

## Stato di partenza

Quattro file sorgente:

- `src/index.js` — bin dell'MCP server: crea il `Server`, valida le env var, registra gli
  handler `ListTools` / `CallTool`, si collega a `StdioServerTransport`. Tutto a livello di
  modulo, quindi il file non è importabile da un test senza side-effect.
- `src/tools/create_draft_post.js` — schema Zod + handler del tool: valida gli argomenti,
  legge le env var, costruisce `SubstackApi` e `SubstackPost`, invia la bozza, ritorna `'OK'`.
- `src/api/substack/SubstackApi.js` — client HTTP su axios; `postDraft` fa `POST` su
  `<publication_url>/api/v1/drafts` con header `Cookie` e `referer`.
- `src/api/substack/SubstackPost.js` — builder del documento ProseMirror della bozza, con
  un'ampia superficie di metodi pubblici.

Non esistono test né workflow CI per i test.

## Refactor di produzione

Il comportamento osservabile dell'MCP server resta invariato. Il refactor serve solo a
rendere il server testabile.

### `src/server.js` (nuovo)

Esporta `createServer()`, che costruisce il `Server` MCP, registra gli handler delle
richieste e lo restituisce. Nessun side-effect all'import: nessuna lettura di env var,
nessuna connessione al transport.

La registrazione dei tool diventa una struttura dati invece di uno `switch`:

```js
const tools = {
  create_draft_post: {
    description: "create a draft post on your Substack account.",
    schema: createDraftPostSchema,
    handler: createDraftPostHandler,
  },
};
```

`ListToolsRequestSchema` deriva la lista dei tool da questa mappa (nome, descrizione,
`zodToJsonSchema(schema)`); `CallToolRequestSchema` risolve l'handler per nome. Lista ed
esecuzione restano così allineate per costruzione, e aggiungere un tool in futuro non
richiede di toccare il server. La gestione degli errori è invariata: un `z.ZodError` diventa
`Invalid input: <dettagli>`, gli altri errori sono propagati; un nome di tool sconosciuto
produce `Unknown tool: <nome>`.

### `src/index.js` (ridotto a entrypoint)

Mantiene shebang, validazione delle env var (`SUBSTACK_PUBLICATION_URL`,
`SUBSTACK_SESSION_TOKEN`, `SUBSTACK_USER_ID`), chiamata a `createServer()`, creazione dello
`StdioServerTransport` e connessione con `process.exit(1)` in caso di errore.

## Strategia di mock: MSW

`msw` v2 con `setupServer` da `msw/node` intercetta a livello dei moduli `http`/`https`,
quindi axios viene esercitato per intero — costruzione dell'URL, serializzazione del body,
header, gestione dello status — senza che nessun byte lasci il processo.

Configurazione, applicata a tutti i file di test che toccano la rete:

- `server.listen({ onUnhandledRequest: 'error' })` prima dei test. **Questo è il vincolo
  centrale del design**: qualsiasi richiesta HTTP in uscita non coperta da un handler fa
  fallire il test. Il requisito "nessuna chiamata esterna reale" diventa così una proprietà
  verificata dalla suite, non una convenzione.
- `server.resetHandlers()` dopo ogni test, così un override non filtra nel test successivo.
- `server.close()` alla fine del file.

Le env var usate nei test sono realistiche, non locali:

| Variabile | Valore nei test |
|---|---|
| `SUBSTACK_PUBLICATION_URL` | `https://test.substack.com` |
| `SUBSTACK_SESSION_TOKEN` | `test-session-token` |
| `SUBSTACK_USER_ID` | `12345` |

Usare un host realistico invece di `127.0.0.1:<porta>` rende significativa l'asserzione sulla
costruzione dell'URL: verifichiamo che `new URL('api/v1', publication_url)` produca davvero
`https://test.substack.com/api/v1/drafts`.

## Struttura dei file

```
test/
  helpers/
    msw-server.js        # setupServer + handler di default + cattura delle richieste
    env.js               # set/restore delle env var di test
    mcp-harness.js       # coppia Client/Server MCP collegata via InMemoryTransport
  unit/
    substack-post.test.js
  integration/
    substack-api.test.js
    create-draft-post.test.js
    mcp-server.test.js
```

### `helpers/msw-server.js`

Espone il `setupServer` configurato con un handler di default per
`POST https://test.substack.com/api/v1/drafts` che risponde `200` con un payload di bozza
plausibile, più un helper `captureRequests()` che registra method, URL, header e body JSON di
ogni richiesta intercettata, per le asserzioni. I singoli test usano `server.use(...)` per
programmare risposte diverse (4xx, 5xx, payload specifici).

### `helpers/env.js`

Imposta le env var di test elencate sopra e restituisce una funzione di ripristino, così un
file di test non altera l'ambiente visto dagli altri.

### `helpers/mcp-harness.js`

Collega un `Client` reale dell'SDK MCP al `createServer()` di produzione tramite
`InMemoryTransport.createLinkedPair()`. Gli integration test parlano quindi il protocollo MCP
vero, non una sua imitazione.

## Copertura

### `SubstackPost` — unit, nessuna rete

- Costruttore: default di `audience` (`'everyone'`), `write_comment_permissions` che segue
  `audience` quando non specificato, `draft_bylines` con `user_id` convertito a intero,
  `subscriber_set_id` che imposta anche `type: 'adhoc_email'`, valori di default di
  `draft_section_id` e `section_chosen`.
- Setter: `setTitle`, `setSubtitle`, `setBody`.
- `getDraft()`: serializza `draft_body` in stringa JSON e mantiene le altre proprietà.
- Builder di contenuto: `paragraph`, `heading` con `attrs.level`, `bulletList`, `orderedList`,
  `bold`, `italic`, `horizontalRule`, `paywall`, `shareButton`, `commentButton`,
  `customButton`, `captionedImage`, `removeLastParagraph`.
- `youtubeVideo` nelle tre forme di input: URL `youtube.com/watch?v=…`, URL `youtu.be/…`, ID
  nudo.
- `marks`: applicazione di mark semplici e di un mark `link` con `attrs.href`.
- `addComplexText`: ramo stringa e ramo array di chunk.
- Errori: `setSection` con un nome che non esiste lancia `Section <name> does not exist`.

### `SubstackApi` — integration con MSW

- `postDraft` invia `POST` a `https://test.substack.com/api/v1/drafts`.
- Header `Cookie` contiene sia `substack.sid=` sia `connect.sid=` con il token.
- Header `referer` è `<publication_url>/publish/post`.
- Il body ricevuto corrisponde alla bozza passata.
- La risposta 2xx viene restituita al chiamante.
- Comportamento su 4xx e su 5xx (caratterizzazione: axios lancia prima che
  `handleResponse` possa valutare lo status).
- `base_url` di default è `https://substack.com/api/v1` quando non specificato.

### `createDraftPostHandler` — integration con MSW

- Input valido: la richiesta intercettata contiene `draft_title`, `draft_subtitle` e
  `draft_body` attesi; l'handler ritorna `'OK'`.
- Le env var sono lette a runtime, non all'import del modulo.
- Input invalido (campo mancante, tipo sbagliato) lancia un `z.ZodError` senza che parta
  alcuna richiesta HTTP.
- Un errore HTTP dell'API viene propagato al chiamante.

### MCP server — integration con `InMemoryTransport` + MSW

- `list_tools` espone `create_draft_post` con la descrizione attesa e un `inputSchema` che
  contiene le proprietà `title`, `subtitle`, `body` tutte richieste.
- `call_tool` con argomenti validi esegue la chiamata (verificata su MSW) e ritorna
  `content: [{type: 'text', text: '"OK"'}]`.
- `call_tool` con un nome sconosciuto produce un errore `Unknown tool: …`.
- `call_tool` con argomenti invalidi produce un errore che inizia con `Invalid input:`.
- Un errore dell'API Substack si propaga come errore del tool.

## Tooling

Script in `package.json`:

| Script | Comando |
|---|---|
| `test` | `node --test test/` |
| `test:watch` | `node --test --watch test/` |
| `test:coverage` | `node --test --experimental-test-coverage test/` |

`devDependencies`: `msw` `2.15.0` (pin esatto, coerente con lo stile delle dependency
esistenti).

`package.json` acquisisce `"files": ["src"]` così il pacchetto pubblicato su npm non include
la suite di test.

### CI

`.github/workflows/test.yml`: su `push` e `pull_request`, su `ubuntu-latest`, con
`actions/setup-node` configurato via `node-version-file: '.nvmrc'`,
`yarn install --frozen-lockfile` e `yarn test` (il repo usa yarn come package manager, come
attesta `yarn.lock`).

## Anomalie note

Riscontrate durante l'analisi, **documentate nei test come comportamento corrente e non
corrette in questo intervento**. Saranno valutate separatamente:

1. `SubstackPost.add()` — il ramo `item.type === 'bullet_list'` chiama
   `subscribeWithCaption(item.message)`, presumibilmente per copia-incolla dal ramo
   `subscribeWidget`.
2. `SubstackApi.handleResponse()` — il controllo su status non-2xx è irraggiungibile, perché
   axios lancia già di suo sulle risposte non-2xx. Anche il `try/catch` attorno a
   `return response.data` non può lanciare.
3. `createDraftPostHandler` — passa `body` (una stringa) a `setBody`, quindi `getDraft()`
   applica `JSON.stringify` a una stringa e `draft_body` finisce doppiamente serializzato.
4. `SubstackPost.customSubscribeButton()` e `addHeader()` contengono testo e URL hardcoded
   specifici di una pubblicazione ("Quickview", "Crypto Daily Recap"), residui di un uso
   precedente della classe.

## Fuori scope

- Correzione delle anomalie elencate sopra.
- Test end-to-end che avviano davvero `src/index.js` in un child process.
- Soglie di coverage obbligatorie in CI (la coverage resta informativa).
- Nuovi tool MCP o modifiche funzionali al server.
