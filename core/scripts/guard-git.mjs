#!/usr/bin/env node
// PreToolUse-гейт на Bash. Не даёт нарушить git-процесс харнеса.
// Блокировка = exit 2 + причина в stderr (уходит модели как обратная связь).
//
// Скрипт не знает названия главной ветки и email владельца — берёт их из
// .claude/harness.json целевого проекта. Если проект не инициализирован,
// работает на дефолтах и остаётся безвредным.

import { execSync } from 'node:child_process'
import path from 'node:path'
import { loadConfig, readHookInput } from './harness-config.mjs'

const input = await readHookInput()
const cmd = input?.tool_input?.command ?? ''
if (!cmd) process.exit(0)

const cwd = input?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const cfg = loadConfig(cwd)
const MAIN = cfg.mainBranch

const deny = (why) => {
  console.error(why)
  process.exit(2)
}

// Каталог, в котором git реально выполнится: приоритет `git -C <путь>`,
// затем ведущий `cd <путь> && ...`, затем cwd сессии. Без этого проверка
// ветки смотрела бы на основной чекаут, а не на worktree агента, и
// блокировала бы легитимные коммиты в ветках задач.
const effectiveDir = () => {
  const mC = cmd.match(/\bgit\s+-C\s+["']?([^\s"']+)/)
  if (mC) return path.resolve(cwd, mC[1])
  const mCd = cmd.match(/^\s*cd\s+["']?([^\s"';&|]+)/)
  if (mCd) return path.resolve(cwd, mCd[1])
  return cwd
}

const currentBranch = () => {
  try {
    return execSync(`git -C "${effectiveDir()}" rev-parse --abbrev-ref HEAD`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

// 1. Коммит и пуш в главную ветку
if (/\bgit\s+commit\b/.test(cmd) && currentBranch() === MAIN) {
  deny(
    `Запрещено коммитить в ${MAIN}. Процесс: заведи ветку задачи и worktree ` +
      `(git worktree add ${cfg.worktreeDir}/<ветка> -b <ветка>), работай там, ` +
      `изменения попадают в ${MAIN} только через PR.`
  )
}
const pushesToMain =
  new RegExp(`\\bgit\\s+push\\b.*\\b(origin\\s+)?${MAIN}\\b`).test(cmd) ||
  new RegExp(`\\bgit\\s+push\\b.*\\bHEAD:${MAIN}\\b`).test(cmd)
if (pushesToMain) {
  deny(`Запрещено пушить напрямую в ${MAIN}. Оформи изменения через PR.`)
}
// «Голый» git push без refspec пушит текущую ветку — на главной это тоже пуш в неё.
if (/\bgit\s+push\b/.test(cmd) && !/\bgit\s+push\b\s+\S+\s+\S/.test(cmd) && currentBranch() === MAIN) {
  deny(`Ты на ${MAIN}: git push без refspec запушил бы в ${MAIN}. Работай в ветке задачи.`)
}

// 2. Обход проверок
if (/--no-verify|--no-gpg-sign/.test(cmd)) {
  deny('Обход хуков (--no-verify / --no-gpg-sign) запрещён. Почини причину, а не проверку.')
}

// 3. Чужое авторство в коммитах
if (/\bgit\s+commit\b/.test(cmd)) {
  if (/Co-Authored-By/i.test(cmd)) {
    deny(
      'Trailer Co-Authored-By запрещён: автор коммитов только владелец репозитория, ' +
        'упоминание ассистентов в авторстве недопустимо.'
    )
  }
  if (/(claude|anthropic|assistant|copilot|noreply@anthropic)/i.test(cmd)) {
    deny(
      'В сообщении коммита есть упоминание ассистента — это запрещено. ' +
        'Перепиши сообщение по существу изменений.'
    )
  }
  const author = cmd.match(/--author[= ]+["']?([^"']+)/)
  if (author && cfg.ownerEmail && !author[1].includes(cfg.ownerEmail)) {
    deny(`--author должен быть ${cfg.ownerEmail}, получено: ${author[1]}`)
  }
}

// 4. Разрушительные операции
if (/\bgit\s+push\b.*(--force(?!-with-lease)|\s-f\b)/.test(cmd)) {
  deny('git push --force запрещён. Если правда нужно — только --force-with-lease и из ветки задачи.')
}
if (new RegExp(`\\bgit\\s+reset\\s+--hard\\b.*\\borigin/${MAIN}\\b`).test(cmd)) {
  deny(`git reset --hard origin/${MAIN} затрёт работу. Используй git stash или новую ветку.`)
}

process.exit(0)
