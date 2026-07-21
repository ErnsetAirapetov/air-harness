#!/usr/bin/env node
// Stop/SubagentStop-гейт: не даёт закончить работу молча с красными
// проверками. Команды проверок берутся из .claude/harness.json целевого
// проекта — скрипт не знает ни про npm, ни про pytest, ни про cargo.
//
// strict: true  — красные проверки блокируют завершение (exit 2)
// strict: false — только сообщаем результат
//
// Освобождение по транскрипту: если в сессии агента не было ни одной файловой
// правки (Write/Edit/MultiEdit/NotebookEdit) — грязь в дереве не его, гонять
// DoD незачем. Так освобождаются read-only ревьюеры и оркестратор, чей Stop
// мог отработать в чужом живом worktree (cwd туда указывал) и поймать красный
// тест посреди TDD чужого исполнителя. Деградация консервативная: нет
// транскрипта / не читается / ни одной разобранной строки — ведём себя как
// раньше (dirty → прогон). Гейт ослабляем только по позитивному доказательству
// «правок не было». Bash-правки (heredoc, sed) детект не видит — осознанный
// компромисс той же модели угроз, что в #24: гейт ловит честные ошибки, не
// адверсарию.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { loadConfig, readHookInput } from './harness-config.mjs'

// Имена файловых tool_use — только их наличие снимает освобождение.
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// Рекурсивно ищет в разобранной записи транскрипта tool_use файловой правки.
// Устойчиво к вариациям структуры: матчит пару type=tool_use + name где угодно
// в дереве (message.content[], вложенные объекты и т.п.).
function hasEditToolUse(value) {
  if (Array.isArray(value)) {
    for (const item of value) if (hasEditToolUse(item)) return true
    return false
  }
  if (value && typeof value === 'object') {
    if (value.type === 'tool_use' && EDIT_TOOLS.has(value.name)) return true
    for (const key of Object.keys(value)) if (hasEditToolUse(value[key])) return true
  }
  return false
}

const input = await readHookInput()

// Этот стоп уже блокировался нами — выходим, иначе красные проверки
// зациклят завершение (стоп → exit 2 → работа → стоп → ...).
if (input?.stop_hook_active) process.exit(0)

// cwd входа хука указывает туда, где реально работал агент — в его worktree.
// findConfig идёт вверх и находит копию harness.json в чекауте worktree,
// поэтому root становится worktree-каталогом, а не основным чекаутом.
const cwd = input?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const cfg = loadConfig(cwd)

if (!cfg.configured || !cfg.checks.length) process.exit(0)

// Освобождение по транскрипту (см. шапку). Читаем построчно: каждая строка —
// отдельный JSON; нераспарсенные пропускаем молча. Освобождаем только когда
// хоть одна строка разобралась И ни в одной нет файловой правки — иначе
// (нет пути, файл не читается, пуст, весь мусор) деградируем к dirty-прогону.
const transcriptPath = input?.transcript_path
if (transcriptPath) {
  let raw = ''
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    raw = ''
  }
  let parsedAny = false
  let edited = false
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    parsedAny = true
    if (hasEditToolUse(record)) {
      edited = true
      break
    }
  }
  if (parsedAny && !edited) {
    console.error('Агент не менял файлы — DoD-прогон пропущен')
    process.exit(0)
  }
}

const root = cfg.root || cwd
const sh = (c) => execSync(c, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// Ничего не трогали в рабочем дереве — нечего проверять.
let dirty = ''
try {
  dirty = sh('git status --porcelain')
} catch {
  process.exit(0)
}
if (!dirty.trim()) process.exit(0)

const failures = []
for (const check of cfg.checks) {
  try {
    sh(check)
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim()
    failures.push(`$ ${check}\n${out.slice(0, 3000)}`)
  }
}

if (!failures.length) {
  console.error(`Проверки зелёные: ${cfg.checks.join(', ')}`)
  process.exit(0)
}

console.error(
  `Проверки красные — задача не считается выполненной:\n\n${failures.join('\n\n')}`
)
process.exit(cfg.strict ? 2 : 0)
