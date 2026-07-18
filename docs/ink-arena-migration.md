# Миграция ink-arena на плагин harness-core

Одноразовая инструкция для владельца. После применения и живого прогона этот
документ можно удалить. Смысл миграции: из `.claude/` проекта уходит всё, что
теперь приходит из плагина, остаются только привязки и предметный слой.

## 1. Создать `.claude/harness.json`

```json
{
  "mainBranch": "main",
  "ownerEmail": "eriktarakan@gmail.com",
  "worktreeDir": ".claude/worktrees",
  "checks": ["npm test", "npx tsc --noEmit"],
  "editChecks": [{ "match": "\\.(ts|tsx)$", "run": "npx tsc --noEmit" }],
  "strict": true
}
```

## 2. Создать `.claude/forge.md`

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
| список PR | gh pr list --json number,title,headRefName,statusCheckRollup |
| прочитать PR / дифф | gh pr view <N> / gh pr diff <N> |
| создать PR | gh pr create --base main --title "<t>" --body "<b>" (в теле: Closes #N) |
| смержить PR | gh pr merge <N> --squash --delete-branch |
```

## 3. Удалить (заменено плагином)

| Файл в `.claude/` | Кем заменён |
|---|---|
| `agents/impl.md` | `harness-core/agents/impl.md` |
| `agents/reviewer.md` | `harness-core/agents/reviewer.md` |
| `agents/issue-groomer.md` | `harness-core/agents/groomer.md` (имя роли теперь `groomer`) |
| `commands/board.md`, `groom.md`, `task.md`, `land.md` | `harness-core/commands/*` |
| `hooks/guard-bash.mjs` | `harness-core/scripts/guard-git.mjs` |
| `hooks/report-tests.mjs` | `harness-core/scripts/run-checks.mjs` |
| `hooks/check-ts.mjs` | `harness-core/scripts/edit-checks.mjs` (правило в `editChecks`) |

**Остаётся:** `agents/gdd-writer.md` — проектная роль (предметный слой);
`/task` из плагина сам направит на неё документационные задачи.

## 4. `settings.json` — убрать хуки, permissions оставить

Секцию `hooks` удалить целиком (хуки приходят из плагина). `permissions`
оставить как есть. Для подключения плагина после пуша харнеса в GitHub
добавить:

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

До пуша (или для проверки правок харнеса) плагин подключается локально:
`claude --plugin-dir D:\Repos\air-harness\core` — тогда блок выше не нужен.

## 5. Создать `.claude/orchestrator.md` и дополнить `.gitignore`

Оркестратор ink-arena уже подписывался «Индиго» в `/land` — узакониваем:

```markdown
Тебя зовут Индиго. Так к тебе обращается владелец, этим именем ты
подписываешь комментарии на доске (например при закрытии задач).
```

В `.gitignore` дописать `.claude/handoff.md` (сессионный файл, не для истории).

Переименовать метки направлений — «эпик» теперь уровень иерархии
(см. [task-hierarchy.md](task-hierarchy.md)), направления — `area:*`:

```bash
gh label list | grep "epic:"   # для каждой:
gh label edit "epic:combat" --name "area:combat"
```

## 6. Чек-лист живого прогона (принцип 8)

1. В ink-arena: `claude --plugin-dir D:\Repos\air-harness\core`.
2. Гейт: попроси агента сделать `git commit` на `main` — должен быть заблокирован
   с внятной причиной.
3. `/board` — сводка собирается, команды берутся из `forge.md`.
4. `/task <номер маленькой задачи>` — агент в worktree, PR открыт, `Closes #N`
   на месте, красные проверки не дали бы ему закончить молча.
5. `/land <номер PR>` — ревью, мерж, worktree убран, задача закрыта,
   `git worktree list` чист.
6. Правка любого `.ts` с намеренной ошибкой типов — `edit-checks` возвращает
   ошибку сразу после Write/Edit.
7. Новая сессия: оркестратор ведёт себя по хартии (делегирует, представляется
   Индиго). Затем цикл хендоффа: `/handoff` → `/compact` → сессия сама
   вспоминает контекст и продолжает с сохранённого шага.

Что-то не так — это дефект харнеса: чинить в `air-harness`, не локальными
заплатками в проекте.
