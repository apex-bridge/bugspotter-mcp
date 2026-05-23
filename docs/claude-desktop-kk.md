# bugspotter-mcp қызметін Claude Desktop-қа қосу

Бұл нұсқаулық хостингтегі `bugspotter-mcp` эндпойнтін Claude Desktop-қа
қалай қосу керектігін түсіндіреді. Қосылғаннан кейін Claude сізге
тікелей чатта бағдарламадағы қателерді іздеп, карточкаларды ашып,
қайталанбас үшін ұқсастарды тексеріп, жоба бойынша сұрақтарға жауап
бере алады.

Жергілікті (stdio) және хостингтегі (HTTP) нұсқалары бөлек
қарастырылады.

---

## Қажет нәрселер

1. Орнатылған **Claude Desktop** (Windows / macOS) — <https://claude.ai/download>
   мекенжайынан жүктеп алыңыз.
2. **BugSpotter API-кілті** — `bgs_…` префиксімен басталады. BugSpotter
   әкімшілік панелінің *API Keys* бөлімінде шығарылады. Хостинг нұсқасы
   үшін кілттің `reports:read` (қажет болса `reports:write`) рұқсаты
   және `allowed_projects` ішінде кем дегенде бір жоба болуы керек.
3. **Жоба UUID-і** — әкімшілік панельден немесе жоба беттің URL-нен
   алынады.
4. Stdio немесе `mcp-remote` көпір нұсқасын қолданатын болсаңыз —
   `PATH` ішінде **Node.js 20+**.

---

## Қосылудың екі тәсілі

| Тәсіл | Қашан таңдау керек | Қалай жұмыс істейді |
|---|---|---|
| **Stdio (жергілікті)** | `bugspotter-mcp` репозиторийі клондалған және BugSpotter-ге тікелей қатынасу бар. Ең жылдам жауап, желілік шегініс жоқ. | Claude Desktop кілтті environment-та сақтап, жергілікті Node процесін іске қосады. |
| **HTTP (хостинг эндпойнті)** | Жалпы `https://mcp.kz.bugspotter.io` хостингін немесе ішкі корпоративтік эндпойнтті пайдаланасыз. Локальдік клон қажет емес. | Claude Desktop `mcp-remote` көпір процесін іске қосады. Көпір MCP хабарламаларын `Authorization: Bearer …` тақырыбымен HTTPS арқылы жібереді. |

Екеуін бірге орнатуға болады — Claude Desktop-та екі бөлек коннектор
ретінде көрінеді.

---

## Конфигурация файлы қайда орналасқан

Claude Desktop `claude_desktop_config.json` файлын оқиды. Жол орнату
тәсіліне байланысты:

| Орнату тәсілі | Жол |
|---|---|
| Windows · Microsoft Store | `%LOCALAPPDATA%\Packages\Claude_<package-id>\LocalCache\Roaming\Claude\claude_desktop_config.json` |
| Windows · claude.ai/download-тан `.exe` инсталляторы | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

**Windows үшін маңызды.** Егер Claude Desktop Microsoft Store-дан
орнатылған болса (sandbox режимі), `%APPDATA%\Claude\` файлын өзгерту
ештеңе бермейді — қолданба өзінің оқшауланған жадынан оқиды. Дұрыс
жолды табу үшін PowerShell-де:

```powershell
Get-AppxPackage *claude* | Select-Object PackageFamilyName, InstallLocation
```

Пакет атынан жоғарыдағы жолға қойылатын `<package-id>` алынады.

Файл жоқ болса — оны жасаңыз. Мазмұны `mcpServers` түбірлік объектісі
бар дұрыс JSON болуы керек.

---

## 1-тәсіл. Stdio (жергілікті)

Репозиторий клондалып, құрастырылған болуы керек:

```bash
git clone https://github.com/apex-bridge/bugspotter-mcp.git
cd bugspotter-mcp
npm install
npm run build
```

`mcpServers` ішіне жазбаны қосыңыз:

```json
{
  "mcpServers": {
    "bugspotter": {
      "command": "node",
      "args": [
        "C:/жол/bugspotter-mcp/dist/server.js"
      ],
      "env": {
        "BUGSPOTTER_BASE_URL": "https://api.kz.bugspotter.io",
        "BUGSPOTTER_API_KEY": "bgs_<сіздің-кілтіңіз>",
        "BUGSPOTTER_DEFAULT_PROJECT": "<жоба-uuid>",
        "LOG_DIR": "C:/жол/bugspotter-mcp/logs"
      }
    }
  }
}
```

`BUGSPOTTER_DEFAULT_PROJECT` — міндетті емес өріс. Бұл орнатылса,
Claude `list_bugs`, `search_bugs`, `ask` шақыруларын `project_id`
дегенді ашық көрсетпей-ақ жасай алады.

---

## 2-тәсіл. HTTP (хостинг эндпойнті)

Claude Desktop әзірге Bearer-токенмен MCP-серверлерге тікелей HTTP
арқылы қосыла алмайды (*Settings → Connectors → Add Custom Connector*
тек OAuth-ты қолдайды). Сол себепті `mcp-remote` көпірі қолданылады —
Claude-тің stdio алмасуын HTTPS сұрауларына түрлендіретін шағын
Node-пакеті.

### 1-қадам. `mcp-remote`-ты глобалды орнату

```bash
npm install -g mcp-remote
```

`command` ішінде `npx mcp-remote …` пайдалану теориялық тұрғыдан
жұмыс істейді, бірақ Windows-та `C:\Program Files\nodejs\` жолындағы
бос орындардан жиі сынады (төмендегі *Жиі кездесетін мәселелер*
бөлімін қараңыз). Глобалды орнату бұл қауіпті жояды.

### 2-қадам. Орындалатын файлдың дәл жолын анықтау

```bash
where.exe mcp-remote    # Windows
which mcp-remote        # macOS / Linux
```

Жолды сақтап қойыңыз — ол `command` өрісіне қажет.

### 3-қадам. Коннекторды жариялау

```json
{
  "mcpServers": {
    "bugspotter-hosted": {
      "command": "C:\\nvm\\nodejs\\mcp-remote.cmd",
      "args": [
        "https://mcp.kz.bugspotter.io/mcp",
        "--header",
        "Authorization:Bearer bgs_<сіздің-кілтіңіз>",
        "--header",
        "X-Project-Id:<жоба-uuid>"
      ]
    }
  }
}
```

Маңызды нюанстар:

- API-кілтін **тура мәнімен** қойыңыз, `${BUGSPOTTER_API_KEY}`
  үлгісінде емес. Claude Desktop аргументтерді тікелей дочерний
  процеске береді, environment айнымалыларын ашпайды.
- `X-Project-Id` тақырыбы әрбір сұрау үшін әдепкі жобаны қосады.
  Онсыз әрбір `list_bugs` / `search_bugs` / `ask` шақыруында
  `project_id` ашық көрсетілуі тиіс.
- Windows-та JSON жолдарында кері қос слэш (`\\`) қолданыңыз.

### 4-қадам. Claude Desktop-ты қайта іске қосу

Процесті толық тоқтатыңыз — терезені жабу процесті трей-де қалдырады.
PowerShell-де:

```powershell
Get-Process Claude -ErrorAction SilentlyContinue | Stop-Process
```

Содан кейін Claude Desktop-ты қайта іске қосыңыз. Конфигурация тек
іске қосу кезінде ғана оқылады.

### 5-қадам. Қосылымды тексеру

Claude Desktop-та *Settings → Developer* бөлімін ашыңыз. Сонда
`bugspotter-hosted` коннекторын `running` мәртебесімен көру керек.
Мәртебе қызыл болса — сол қалтада орналасқан лог файлын қараңыз
(`logs/mcp-server-bugspotter-hosted.log`).

---

## Қол жетімді құралдар

Қосылғаннан кейін Claude алты операцияны қолдана алады:

| Құрал | Не істейді | Міндетті параметрлер | Пайдалы опциялар |
|---|---|---|---|
| `list_bugs` | Жобадағы қателер тізімі (тек id, title, status, priority, күні) — шолу мен сұрыптау үшін | — (`default_project` / `X-Project-Id` орнатылған болса) | `status`, `priority`, `from_date`, `to_date`, `limit` (100-ге дейін) |
| `search_bugs` | Мәтін бойынша рейтингтелген іздеу; қысқартылған карточкалар (excerpt пен score) | `query` | `mode`: `fast` (тек эмбеддингтер) немесе `smart` (эмбеддингтер + LLM-rerank); `limit` (50-ге дейін) |
| `get_bug` | Толық қате карточкасы: сипаттама, консольдік қателер, желілік логтар, stack | `bug_id` | — |
| `find_similar` | Эмбеддинг бойынша ұқсас қателер — қайталанбас үшін жаңа карточка жасамас бұрын қолданыңыз | `bug_id` | `threshold` (0–1, әдепкі 0.7), `limit` (20-ға дейін) |
| `ask` | Жоба бойынша RAG-сұрақ: нақты қателер сілтемесі бар LLM-жауап | `question` | `context[]`, `temperature`, `max_tokens` |
| `update_bug_status` | `status` және/немесе `priority` өзгертеді, қажет болса `note` → `resolution_notes` | `bug_id` | `status`, `priority`, `note` (5000 таңбаға дейін) |

---

## Қалай пайдалану

Claude-қа қалыпты тілмен жазыңыз. Ол өзі қажетті құралды таңдайды.
Бірнеше мысал:

| Мақсат | Сұрау үлгісі |
|---|---|
| Ашық қателер шолуы | «Соңғы 5 ашық қатені көрсетші» |
| Мазмұн бойынша іздеу | «Вакансия іздеуге қатысты қателерді тап» |
| Қате деталі | «f8278dd4-1b79-4383-a39e-51aab5c2f8ae қатесін толық көрсет» |
| Қайталану тексерісі | «Мына қатеге ұқсас басқалары бар ма: … ?» |
| Аналитикалық сұрақ | «Жобадағы ең жиі құлау себептері қандай?» |
| Мәртебесін өзгерту | «… қатені жабыл, түсініктеме: PR #123-те түзетілді» |

Әрбір құралды бірінші рет шақырғанда Claude растауды сұрайды
(*Always allow* белгілемесеңіз — сессия ішінде әрбір құрал үшін
бір рет).

Егер екі коннектор да (`bugspotter` және `bugspotter-hosted`)
қосылған болса, Claude кез келгенін таңдай алады. Нақтысын талап
ету үшін ашық айтыңыз: «bugspotter-hosted арқылы соңғы қателерді
көрсетші…».

---

## Жиі кездесетін мәселелер

### Іске қосылғаннан кейін бірден `Server disconnected`

Конфигурация қалтасындағы `logs/mcp-server-bugspotter-hosted.log`
файлын ашыңыз. Ең жиі себептер:

- **`'C:\Program' is not recognized…`** — Windows Node.js жолындағы
  бос орындарға байыпсыздық танытады. Шешімі: `mcp-remote`-ты
  глобалды орнатыңыз және бос орынсыз жолды пайдаланыңыз
  (`C:\nvm\nodejs\mcp-remote.cmd`), `npx`-ті емес. 2-тәсіл,
  1-қадамды қараңыз.
- **`401 Unauthorized`** — кілт жарамсыз немесе мерзімі өткен. Кілт
  түгел көшірілгенін (жол ауыстырусыз) тексеріңіз, `bgs_` префиксі
  болуын, әкімшілік панелде қайтарып алынбағанын тексеріңіз.
- **`404`** — URL қате. Хостинг эндпойнтінің жолы әрқашан `/mcp` -ке
  аяқталады.

### DNS ескі IP қайтарады

Егер JSON орнына әкімшілік панелдің HTML-беті көрсетілсе, жергілікті
DNS кэші немесе роутер ескі жазбаны ұстап тұр. Кэшті тазалаңыз:

```powershell
ipconfig /flushdns
```

Содан кейін көпшілік резолвер арқылы тексеріңіз:

```powershell
nslookup mcp.kz.bugspotter.io 8.8.8.8
```

Көпшілік резолвер `*.fly.dev`-ге дұрыс CNAME қайтарса, ал жергілікті
ескі IP-ды қайтарса — үй роутерін қайта іске қосыңыз немесе
DNS-over-HTTPS қолданыңыз.

### Tool шақырылды, бірақ `project_id is required` қайтады

Коннекторыңызда әдепкі жоба орнатылмаған. Не `X-Project-Id`
тақырыбын қосыңыз (2-тәсіл, 3-қадам), не әрбір сұрауда жобаны ашық
көрсетіңіз: *«… жобасында қателер тізімін көрсет»*.

### Custom Connectors UI OAuth сұрайды, ал бізде Bearer

Бұл — Claude Desktop кіріктірілген коннектор-UI ағымдағы бета-нұсқасының
шектеуі. 2-тәсілдегідей `mcp-remote` көпірімен JSON-конфигті
пайдаланыңыз.

---

## Қауіпсіздік

- API-кілт жергілікті конфигурация файлында ашық түрде сақталады. Файлды
  ОЖ рұқсаттарымен қорғаңыз; конфигурацияны git-ке жарияламаңыз.
- Хостинг эндпойнті тенанттарды кілт бойынша оқшаулайды: бір клиенттің
  сессиясы екіншісінің деректерін көрмейді, кілттер басқа болса да.
- CI / автоматтандыру үшін `reports:read` рұқсаты бар бөлек кілт
  жасаңыз (`write`-сыз) және оны нақты `allowed_projects` тізіміне
  байлаңыз.

---

## Әрі қарай оқу

- [docs/architecture.md](architecture.md) — сервер құрылымы, сұрау
  ағыны, дизайн шешімдері.
- [docs/use-cases.md](use-cases.md) — қолдану сценарийлерінің мысалдары.
- [docs/troubleshooting.md](troubleshooting.md) — диагностика бойынша
  кеңейтілген нұсқаулық.
