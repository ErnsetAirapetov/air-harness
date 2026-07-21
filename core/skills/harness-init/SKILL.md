---
name: harness-init
description: Развернуть харнес в репозитории — пустом или живом. Создаёт привязки (.claude/harness.json, forge.md, settings.json), метки и шаблон задачи на доске, настраивает защиту главной ветки на фордже. Используй, когда просят инициализировать проект под харнес, настроить доску задач или подключить процесс работы агентами.
---

Ты разворачиваешь харнес в текущем репозитории. Спецификация процедуры —
в docs/init-procedure.md репозитория харнеса; этот скилл самодостаточен,
шаблоны ниже пишутся через Write.

Принципы: спрашивать мало (всё выводимое — выводить); ничего не затирать без
явного подтверждения; повторный запуск дополняет недостающее, а не ломает
настроенное; в конце — самопроверка фактического состояния, не намерений.

## Шаг 0. Разведка (без вопросов)

Определи сам: фордж (`git remote -v`); стек (package.json / pyproject.toml /
go.mod / Cargo.toml / *.csproj); команды проверок (скрипты test/lint/typecheck
из манифеста стека); главная ветка (`git symbolic-ref refs/remotes/origin/HEAD`,
иначе текущая); email владельца (`git config user.email`); пустой ли репозиторий
(`git log` пуст). Покажи всё одним блоком «вот что я понял».

## Шаг 1. Вопросы (не более четырёх)

1. **Назначение проекта и имя оркестратора** — назначение в 1–3 предложениях
   (единственный обязательный вопрос); тем же вопросом — как звать оркестратора
   этого репозитория (предложи 2–3 варианта под характер проекта).
2. **Направления (areas)** — 3–6 постоянных областей кодовой базы, станут
   метками `area:*`; предложи варианты из назначения.
3. **Стек** — только если разведка не определила.
4. **Строгость гейтов** — блокировать при красных проверках (`strict: true`)
   или только предупреждать.

## Шаг 2. Что создать

### `.claude/harness.json`

Подставь найденное; `checks` и `editChecks` — командами стека проекта:

```json
{
  "mainBranch": "<главная ветка>",
  "ownerEmail": "<email владельца>",
  "worktreeDir": ".claude/worktrees",
  "checks": ["<команда тестов>", "<команда типов/линта>"],
  "editChecks": [{ "match": "<regex файлов>", "run": "<быстрая проверка>" }],
  "strict": true
}
```

Пример для Node+TS: checks `["npm test", "npx tsc --noEmit"]`, editChecks
`[{ "match": "\\.(ts|tsx)$", "run": "npx tsc --noEmit" }]`. Для Python:
`["pytest -q"]` и `[{ "match": "\\.py$", "run": "ruff check ." }]`.

### `.claude/forge.md` — по форджу из разведки

GitHub:

```markdown
Фордж: GitHub (gh CLI)

| действие | команда |
|---|---|
| список задач | gh issue list --state open --limit 50 --json number,title,labels |
| прочитать задачу | gh issue view <N> |
| создать задачу | gh issue create --title "<t>" --body-file <f> --label <l> |
| комментарий к задаче | gh issue comment <N> -b "<текст>" |
| пометить решением | gh issue edit <N> --add-label needs-decision |
| закрыть задачу | gh issue close <N> -c "<итог>" |
| создать милстоун | gh api repos/{owner}/{repo}/milestones -f title="<t>" |
| создать задачу с милстоуном | gh issue create --title "<t>" --body-file <f> --label <l> --milestone "<t>" |
| закрыть милстоун | gh api -X PATCH repos/{owner}/{repo}/milestones/<num> -f state=closed |
| список PR | gh pr list --json number,title,headRefName,statusCheckRollup |
| прочитать PR / дифф | gh pr view <N> / gh pr diff <N> |
| создать PR | gh pr create --base <главная> --title "<t>" --body "<b>" (в теле: Closes #N) |
| смержить PR | gh pr merge <N> --squash --delete-branch |
```

GitLab:

```markdown
Фордж: GitLab (glab CLI)

| действие | команда |
|---|---|
| список задач | glab issue list --output json |
| прочитать задачу | glab issue view <N> |
| создать задачу | glab issue create -t "<t>" -d "$(cat <f>)" -l <l> -y |
| комментарий к задаче | glab issue note <N> -m "<текст>" |
| пометить решением | glab issue update <N> --label needs-decision |
| закрыть задачу | glab issue note <N> -m "<итог>" && glab issue close <N> |
| создать милстоун | glab api projects/:id/milestones -f title="<t>" |
| создать задачу с милстоуном | glab issue create -t "<t>" -d "$(cat <f>)" -l <l> -m "<t>" -y |
| закрыть милстоун | glab api projects/:id/milestones/<id> -X PUT -f state_event=close |
| список MR | glab mr list --output json |
| прочитать MR / дифф | glab mr view <N> / glab mr diff <N> |
| создать MR | glab mr create -b <главная> -t "<t>" -d "<b>" -y (в описании: Closes #N) |
| смержить MR | glab mr merge <N> --squash --remove-source-branch -y |

Нюансы:
- без -t/-d/-y glab открывает интерактивный редактор — агенту он недоступен,
  поэтому флаги в командах обязательны;
- glab mr merge при работающем пайплайне ставит auto-merge (мерж после
  зелёного пайплайна) — обычно это и нужно; мержить немедленно:
  добавь --auto-merge=false;
- Closes #N в описании MR закрывает задачу при мерже.
```

Self-hosted GitLab: перед первой работой `glab auth login --hostname <хост>`.

### Гейты на фордже

Локальные хуки — быстрая обратная связь; настоящий забор — защита главной
ветки на сервере форджа.

GitHub — тело запроса запиши в файл и подай через `--input`; `checks` —
имена job'ов реального CI проекта (CI нет — `"required_status_checks": null`):

```bash
gh api -X PUT repos/{owner}/{repo}/branches/<главная>/protection --input protection.json
```

```json
{
  "required_status_checks": { "strict": true, "checks": [{ "context": "<job CI>" }] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false
}
```

Нюансы:
- `required_pull_request_reviews: null` — соло-владелец работает без
  обязательных апрувов;
- на бесплатном плане GitHub защита веток работает только в публичных
  репозиториях — для приватного на Free шаг пропусти и предупреди владельца.

GitLab — дефолтная ветка защищена по умолчанию, но с правом пуша для
Maintainers, поэтому защиту перезаведи (пуш — никому, мерж — Maintainers)
и включи merge-чеки:

```bash
glab api projects/:id/protected_branches/<главная> -X DELETE
glab api projects/:id/protected_branches -X POST -f name=<главная> -f push_access_level=0 -f merge_access_level=40
glab api projects/:id -X PUT -f only_allow_merge_if_pipeline_succeeds=true -f remove_source_branch_after_merge=true
```

Нюанс: `only_allow_merge_if_pipeline_succeeds=true` включай, только если в
проекте реально есть CI-пайплайн — иначе MR перестанут мержиться вовсе.

### `.claude/orchestrator.md` — персона оркестратора

Имя и проектные инструкции главного агента; SessionStart-хук харнеса вложит
файл в контекст каждой сессии. Держи коротким (до ~15 строк):

```markdown
Тебя зовут <Имя>. Так к тебе обращается владелец, этим именем ты
подписываешь комментарии на доске (например при закрытии задач).

<1–3 проектных правила оркестрирования, если есть: каких агентов
предпочитать, что всегда согласовывать с владельцем.>
```

### `.claude/settings.json`

Не перезаписывай существующий — сливай. Нужны: permissions (разрешить CLI
форджа, менеджер пакетов стека, безопасные подкоманды git: status, diff, log,
show, branch, add, checkout, switch, fetch, pull, worktree, rev-parse;
запретить чтение `.env*`, `**/*.key`, `**/*.pem`) и подключение плагина:

```json
{
  "extraKnownMarketplaces": {
    "air-harness": {
      "source": { "source": "github", "repo": "ErnsetAirapetov/air-harness" }
    }
  },
  "enabledPlugins": { "harness-core@air-harness": true }
}
```

### `.gitignore`

Дописать (если нет): `.claude/worktrees/`, `.claude/settings.local.json`,
`.claude/handoff.md`.

### `CLAUDE.md`, `AGENTS.md`, `docs/` — делегируй

Спауни агента `scaffolder`: передай назначение, стек, найденные соглашения.
Он создаст предметный `CLAUDE.md`, `AGENTS.md` и заготовки `docs/` (README,
product, architecture, roadmap, domain-глоссарий, decisions) и вернёт список
вопросов владельцу — покажи его владельцу целиком. Существующие файлы
scaffolder не перезаписывает.

### Доска задач

- Метки: `area:*` по ответу владельца, `type:design|feat|fix|chore|research`,
  `size:S|M|L`, потоковые `needs-decision`, `blocked`.
- Дефолтные метки форджа (`bug`, `enhancement`, `question`…) предложи удалить —
  они дублируют оси; в живом репозитории покажи список и дождись подтверждения.
- Иерархия работ: Веха `M1` (только `docs/roadmap.md`, на фордж не
  выносится) → Эпик `M1-E2` (милстоун форджа `[M1-E2] Название`) → Задача
  (`[M1-E2-T3] Название`, привязана к милстоуну эпика); внеплановые
  fix/chore — без кода. Первую веху с эпиками закладывает scaffolder в
  `docs/roadmap.md`; милстоуны эпиков заводит groomer при декомпозиции.
- Шаблон задачи (`.github/ISSUE_TEMPLATE/task.yml` для GitHub,
  `.gitlab/issue_templates/task.md` для GitLab) с обязательными разделами:
  Контекст, Задача, Критерии приёмки, Границы, Модель.
- Для нового проекта: 3–5 стартовых задач из назначения (с кодами `M1-E*-T*`),
  чтобы первый `/task` запускался сразу.

## Шаг 3. Самопроверка (фактическое состояние, не намерения)

- `.claude/harness.json` валиден, команды из `checks` реально запускаются;
- метки перечитаны с форджа (не поверил своей же команде);
- защита главной ветки перечитана с форджа: GitHub — GET
  `repos/{owner}/{repo}/branches/<главная>/protection` отвечает 200 и
  `required_status_checks` непустой; GitLab — GET `projects/:id/protected_branches`
  показывает `push_access_level: 0`. Верь фактическому состоянию, не своей команде;
- шаблон задачи на месте; `git status` показан владельцу;
- гейт git-процесса работает: собери в Node вход
  `{"cwd":"<корень>","tool_input":{"command":"git commit -m x"}}`, подай его
  через stdin скрипту `guard-git.mjs` плагина — на главной ветке он должен
  выйти с кодом 2.

## Шаг 4. Отчёт

Что создано, какие метки заведены, что в бэклоге, что дальше (`/board`, потом
`/task N`). Отдельным списком — что НЕ удалось, если что-то не удалось.

Предупреди владельца: если плагин подключён посреди уже идущей сессии
(`/reload-plugins`), хартия оркестратора появится в контексте только после
`/compact` или перезапуска — SessionStart-хук при подключении на ходу не
перестреливает. Её отсутствие сразу после установки — не сбой.

## Отличия для живого репозитория (есть код и история)

- Ничего не перезаписывать; про каждый конфликт спрашивать отдельно.
- Существующие метки и задачи не трогать вслепую: показать, что предлагается
  изменить, и дождаться подтверждения.
- Разведать текущие соглашения (стиль коммитов по `git log`, структура
  каталогов) и отразить их в `CLAUDE.md`, а не навязывать свои.
