// Чтение привязок целевого проекта. Единственное место, где скрипты харнеса
// узнают про конкретный проект: имя главной ветки, email владельца, команды
// проверок. Сам харнес про npm, gh и `main` не знает — см. docs/architecture.md.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const DEFAULTS = {
  mainBranch: 'main',
  ownerEmail: '',
  worktreeDir: '.claude/worktrees',
  checks: [],
  editChecks: [],
  strict: true,
}

/** Идёт вверх от startDir в поисках .claude/harness.json. */
export function findConfig(startDir) {
  let dir = path.resolve(startDir || process.cwd())
  for (;;) {
    const candidate = path.join(dir, '.claude', 'harness.json')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Возвращает конфиг проекта, слитый с дефолтами.
 * Если файла нет или он битый — работаем на дефолтах: харнес должен
 * оставаться безвредным в проекте, где инициализация ещё не проводилась.
 */
export function loadConfig(startDir) {
  const file = findConfig(startDir)
  if (!file) return { ...DEFAULTS, root: null, configured: false }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      ...DEFAULTS,
      ...parsed,
      root: path.dirname(path.dirname(file)),
      configured: true,
    }
  } catch {
    return { ...DEFAULTS, root: path.dirname(path.dirname(file)), configured: false }
  }
}

/** Читает вход хука из stdin. Возвращает {} если разобрать не удалось. */
export async function readHookInput() {
  let raw = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) raw += chunk
  try {
    return JSON.parse(raw) ?? {}
  } catch {
    return {}
  }
}
