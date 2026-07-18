#!/usr/bin/env node
// Stop/SubagentStop-гейт: не даёт закончить работу молча с красными
// проверками. Команды проверок берутся из .claude/harness.json целевого
// проекта — скрипт не знает ни про npm, ни про pytest, ни про cargo.
//
// strict: true  — красные проверки блокируют завершение (exit 2)
// strict: false — только сообщаем результат

import { execSync } from 'node:child_process'
import { loadConfig, readHookInput } from './harness-config.mjs'

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
