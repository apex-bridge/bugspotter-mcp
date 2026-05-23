# Подключение bugspotter-mcp к Claude Desktop

Это руководство описывает, как подключить размещённый эндпойнт `bugspotter-mcp`
к Claude Desktop, чтобы Claude мог искать баги, открывать карточки, проверять
дубликаты и отвечать на вопросы по проекту прямо из чата.

Локальный (stdio) и размещённый (HTTP) варианты обсуждаются раздельно ниже.

---

## Что вам понадобится

1. Установленный **Claude Desktop** (Windows / macOS) — скачать с
   <https://claude.ai/download>.
2. **API-ключ BugSpotter**, начинающийся с `bgs_…` — выпускается в разделе
   *API Keys* админ-панели вашего инстанса. Для размещённого сценария ключ
   должен иметь права `reports:read` и (опционально) `reports:write`, плюс
   хотя бы один проект в `allowed_projects`.
3. **UUID проекта** — берётся из админ-панели или из URL карточки проекта.
4. **Node.js 20+** в `PATH`, если будете использовать stdio- или мостовой
   (`mcp-remote`) вариант.

---

## Два сценария подключения

| Сценарий | Когда выбирать | Как работает |
|---|---|---|
| **Stdio (локально)** | У вас есть склонированный репозиторий `bugspotter-mcp` и доступ к BugSpotter напрямую. Самый быстрый отклик, нет сетевого хопа. | Claude Desktop запускает локальный Node-процесс с ключом в переменных окружения. |
| **HTTP (размещённый эндпойнт)** | Вы используете общий хостинг `https://mcp.kz.bugspotter.io` или внутренний корпоративный эндпойнт. Не нужен локальный клон. | Claude Desktop запускает мост `mcp-remote`, который пересылает MCP-вызовы по HTTPS с заголовком `Authorization: Bearer …`. |

Можно настроить оба одновременно — они появятся в Claude Desktop как два
разных коннектора.

---

## Где лежит файл конфигурации

Claude Desktop читает `claude_desktop_config.json`. Путь зависит от способа
установки:

| Способ установки | Путь к конфигурации |
|---|---|
| Windows · Microsoft Store | `%LOCALAPPDATA%\Packages\Claude_<package-id>\LocalCache\Roaming\Claude\claude_desktop_config.json` |
| Windows · установщик `.exe` с claude.ai/download | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

**Важно для Windows.** Если Claude Desktop установлен из Microsoft Store
(песочница), редактирование `%APPDATA%\Claude\` ничего не даст — приложение
читает из своего изолированного хранилища. Чтобы найти точный путь, выполните
в PowerShell:

```powershell
Get-AppxPackage *claude* | Select-Object PackageFamilyName, InstallLocation
```

Имя пакета даст вам нужное `<package-id>` для пути выше.

Если файла нет — создайте его. Содержимое — корректный JSON с корневым
объектом `mcpServers`.

---

## Сценарий 1. Stdio (локально)

Подразумевается, что репозиторий собран:

```bash
git clone https://github.com/apex-bridge/bugspotter-mcp.git
cd bugspotter-mcp
npm install
npm run build
```

Добавьте запись в `mcpServers`:

```json
{
  "mcpServers": {
    "bugspotter": {
      "command": "node",
      "args": [
        "C:/путь/к/bugspotter-mcp/dist/server.js"
      ],
      "env": {
        "BUGSPOTTER_BASE_URL": "https://api.kz.bugspotter.io",
        "BUGSPOTTER_API_KEY": "bgs_<ваш-ключ>",
        "BUGSPOTTER_DEFAULT_PROJECT": "<uuid-проекта>",
        "LOG_DIR": "C:/путь/к/bugspotter-mcp/logs"
      }
    }
  }
}
```

`BUGSPOTTER_DEFAULT_PROJECT` — необязательное поле. Если оно задано, Claude
может вызывать `list_bugs`, `search_bugs`, `ask` без явного `project_id`.

---

## Сценарий 2. HTTP (размещённый эндпойнт)

Claude Desktop пока не умеет напрямую обращаться к MCP-серверам по HTTP
с Bearer-токеном (раздел *Settings → Connectors → Add Custom Connector*
поддерживает только OAuth). Поэтому используется мост `mcp-remote` —
небольшой Node-пакет, превращающий stdio-обмен Claude в HTTPS-запросы.

### Шаг 1. Установите `mcp-remote` глобально

```bash
npm install -g mcp-remote
```

Использование `npx mcp-remote …` в `command` тоже теоретически работает, но
на Windows регулярно ломается из-за пробелов в пути `C:\Program Files\nodejs\`
(см. раздел *Типичные проблемы* ниже). Глобальная установка снимает риск.

### Шаг 2. Узнайте точный путь к исполняемому файлу

```bash
where.exe mcp-remote    # Windows
which mcp-remote        # macOS / Linux
```

Сохраните путь — он понадобится в `command`.

### Шаг 3. Пропишите коннектор

```json
{
  "mcpServers": {
    "bugspotter-hosted": {
      "command": "C:\\nvm\\nodejs\\mcp-remote.cmd",
      "args": [
        "https://mcp.kz.bugspotter.io/mcp",
        "--header",
        "Authorization:Bearer bgs_<ваш-ключ>",
        "--header",
        "X-Project-Id:<uuid-проекта>"
      ]
    }
  }
}
```

Важные нюансы:

- Подставляйте **литеральный** API-ключ, а не `${BUGSPOTTER_API_KEY}`.
  Claude Desktop передаёт аргументы напрямую в дочерний процесс, без
  раскрытия переменных окружения.
- Заголовок `X-Project-Id` добавляет проект по умолчанию для каждого
  запроса. Без него каждый вызов `list_bugs` / `search_bugs` / `ask`
  должен явно указывать `project_id`.
- На Windows используйте обратный двойной слэш (`\\`) в путях JSON.

### Шаг 4. Перезапустите Claude Desktop

Полностью завершите процесс — закрытие окна оставляет процесс в трее.
В PowerShell:

```powershell
Get-Process Claude -ErrorAction SilentlyContinue | Stop-Process
```

Затем запустите Claude Desktop заново. Конфигурация читается только
при старте.

### Шаг 5. Проверьте подключение

В Claude Desktop откройте *Settings → Developer*. Должны увидеть
`bugspotter-hosted` со статусом `running`. Если статус красный —
смотрите файл лога в той же папке (`logs/mcp-server-bugspotter-hosted.log`).

---

## Доступные инструменты

После подключения Claude получает доступ к шести операциям:

| Инструмент | Что делает | Обязательные параметры | Полезные опции |
|---|---|---|---|
| `list_bugs` | Список багов проекта (только id, title, status, priority, даты) — для обзора и сортировки | — (если задан `default_project` / `X-Project-Id`) | `status`, `priority`, `from_date`, `to_date`, `limit` (до 100) |
| `search_bugs` | Поиск по тексту с ранжированием; возвращает усечённые карточки с excerpt и score | `query` | `mode`: `fast` (только эмбеддинги) или `smart` (эмбеддинги + LLM-rerank); `limit` (до 50) |
| `get_bug` | Полная карточка бага: описание, консольные ошибки, сетевые логи, стек | `bug_id` | — |
| `find_similar` | Похожие баги по эмбеддингу — используйте перед созданием новой задачи, чтобы избежать дубликата | `bug_id` | `threshold` (0–1, по умолчанию 0.7), `limit` (до 20) |
| `ask` | RAG-вопрос по проекту: LLM-ответ с цитированием конкретных багов | `question` | `context[]`, `temperature`, `max_tokens` |
| `update_bug_status` | Меняет `status` и/или `priority`, опционально пишет `note` → `resolution_notes` | `bug_id` | `status`, `priority`, `note` (до 5000 символов) |

---

## Как пользоваться

Просто пишите Claude на естественном языке. Claude сам подберёт нужный
инструмент. Несколько примеров:

| Цель | Пример запроса |
|---|---|
| Обзор открытых багов | «Покажи 5 последних открытых багов» |
| Поиск по содержанию | «Найди баги, связанные с поиском вакансий» |
| Детали бага | «Покажи бaг f8278dd4-1b79-4383-a39e-51aab5c2f8ae целиком» |
| Проверка дубликата | «Есть ли похожие баги на bag … ?» |
| Аналитический вопрос | «Какие наиболее частые причины падений в проекте?» |
| Смена статуса | «Закрой баг … с комментарием: исправлено в PR #123» |

Перед каждым вызовом инструмента Claude попросит подтверждение (один раз
на сессию для каждого инструмента, если вы не отметите *Always allow*).

Если подключены оба коннектора (`bugspotter` и `bugspotter-hosted`),
Claude может выбрать любой. Чтобы заставить использовать конкретный —
скажите явно: «Через bugspotter-hosted покажи последние баги…».

---

## Типичные проблемы

### `Server disconnected` сразу после старта

Откройте `logs/mcp-server-bugspotter-hosted.log` в папке конфигурации Claude.
Самые частые причины:

- **`'C:\Program' is not recognized…`** — Windows ломается на пробелах в
  пути к Node.js. Решение: установите `mcp-remote` глобально и используйте
  путь без пробелов (`C:\nvm\nodejs\mcp-remote.cmd`), а не `npx`. См.
  Сценарий 2, шаг 1.
- **`401 Unauthorized`** — ключ невалиден или истёк. Проверьте, что ключ
  скопирован полностью (без переноса строк), начинается с `bgs_` и в
  админ-панели не отозван.
- **`404`** — неправильный URL. Размещённый эндпойнт всегда оканчивается
  на `/mcp`.

### DNS возвращает старый адрес

Если вы видите HTML админ-панели вместо JSON, локальный DNS-кэш или роутер
держат устаревшую запись. Очистите кэш:

```powershell
ipconfig /flushdns
```

И проверьте через публичный резолвер:

```powershell
nslookup mcp.kz.bugspotter.io 8.8.8.8
```

Если публичный возвращает корректный CNAME на `*.fly.dev`, а локальный —
старый IP, перезагрузите домашний роутер либо используйте DNS-over-HTTPS.

### Tool вызывается, но возвращает `project_id is required`

У вашего коннектора не задан проект по умолчанию. Либо добавьте заголовок
`X-Project-Id` (см. Сценарий 2, шаг 3), либо явно указывайте проект в
каждом запросе: *«В проекте … покажи список багов»*.

### Custom Connectors UI просит OAuth, а у нас Bearer

Это ограничение текущей бета-версии встроенного коннектор-UI Claude
Desktop. Используйте JSON-конфиг с мостом `mcp-remote` — как описано
в Сценарии 2.

---

## Безопасность

- API-ключ хранится в локальном файле конфигурации в открытом виде.
  Защищайте файл правами доступа ОС; не публикуйте конфиг в git.
- Размещённый эндпойнт изолирует тенантов по ключу: сессия одного клиента
  не видит данные другого, даже если ключи отличаются.
- Для CI / автоматизации заведите отдельный ключ с правами `reports:read`
  (без `write`) и привяжите к конкретным `allowed_projects`.

---

## Куда дальше

- [docs/architecture.md](architecture.md) — устройство сервера, поток
  запроса, design-решения.
- [docs/use-cases.md](use-cases.md) — примеры сценариев использования.
- [docs/troubleshooting.md](troubleshooting.md) — расширенный гайд по
  диагностике.
- [docs/claude-desktop.md](claude-desktop.md) — English version of this
  guide.
