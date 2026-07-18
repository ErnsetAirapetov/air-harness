#!/usr/bin/env node
// PostToolUse-хук на Write|Edit: мгновенный фидбек после правки файла, чтобы
// модель чинила ошибки сразу, а не в конце задачи. Какие проверки на какие
// файлы — из editChecks в .claude/harness.json целевого проекта:
//
//   "editChecks": [{ "match": "\\.(ts|tsx)$", "run": "npx tsc --noEmit" }]
//
// Нет секции — хук молчит. Правка уже применена, поэтому exit 2 не откатывает
// её, а возвращает модели текст ошибок как обратную связь.

import { execSync } from 'node:child_process'
import path from 'node:path'
import { loadConfig, readHookInput } from './harness-config.mjs'

const input = await readHookInput()
const file = input?.tool_input?.file_path ?? ''
if (!file) process.exit(0)

// Конфиг ищем вверх от правленого файла: в worktree агента найдётся его
// копия harness.json, и проверки пройдут в worktree, а не в основном чекауте.
const cfg = loadConfig(path.dirname(path.resolve(file)))
if (!cfg.configured || !Array.isArray(cfg.editChecks) || !cfg.editChecks.length) {
  process.exit(0)
}

const failures = []
for (const rule of cfg.editChecks) {
  if (!rule?.run || !rule?.match) continue
  let re
  try {
    re = new RegExp(rule.match)
  } catch {
    continue
  }
  if (!re.test(file)) continue
  try {
    execSync(rule.run, { cwd: cfg.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim()
    failures.push(`$ ${rule.run}\n${out.slice(0, 4000)}`)
  }
}

if (failures.length) {
  console.error(
    `Проверка после правки нашла ошибки — почини их до следующего шага:\n\n${failures.join('\n\n')}`
  )
  process.exit(2)
}
process.exit(0)
