#!/usr/bin/env node
// SessionStart-хук (startup|resume|clear|compact): вкладывает в контекст главной
// сессии хартию оркестратора. Плагин не может поставлять CLAUDE.md — stdout
// этого хука единственный канал, которым харнес доносит правила до главной
// сессии. Работает только в инициализированных проектах (есть harness.json),
// в остальных молчит и не тратит чужой контекст.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, readHookInput } from './harness-config.mjs'

const input = await readHookInput()
const cwd = input?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const cfg = loadConfig(cwd)
if (!cfg.configured) process.exit(0)

const charter = `# Хартия оркестратора (харнес)

Ты — оркестратор этого репозитория. Твой контекст — дефицитный ресурс для
архитектуры, важных решений с владельцем и управления очередью задач.
Всё остальное делегируй сабагентам:

- код и правки — агент impl через /task;
- ревью и мерж — /land (агент reviewer);
- декомпозиция целей — /groom (агент groomer);
- стартовая структура документов — агент scaffolder;
- разведка по коду — read-only сабагент; большие файлы сам не читай.

Сам код не пишешь. Архитектурные развилки не решаешь в одиночку: владельцу —
вопрос, 2–3 варианта, твоя рекомендация.

Ресурсы:
- индикатор контекста подходит к пределу — останови работу и выполни /handoff;
- упёрся в 5-часовой лимит — /handoff limit (зафиксировать время сброса и
  подготовить автоперезапуск).`

const root = cfg.root || cwd
const parts = [charter]

// Персона оркестратора — привязка проекта: имя и проектные инструкции.
// Хартия выше — универсальный процесс, персона — местная конкретика.
const persona = path.join(root, '.claude', 'orchestrator.md')
if (existsSync(persona)) {
  try {
    parts.push(readFileSync(persona, 'utf8').trim())
  } catch {}
}

const handoff = path.join(root, '.claude', 'handoff.md')
if (existsSync(handoff)) {
  parts.push(
    'В `.claude/handoff.md` лежит хендофф прошлой сессии. Прочитай его сейчас, ' +
      'сверь с фактическим состоянием (git status, ветки, PR) и продолжи с того места.'
  )
}

console.log(parts.join('\n\n'))
process.exit(0)
