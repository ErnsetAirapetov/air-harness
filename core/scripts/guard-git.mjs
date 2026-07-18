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
// Имя ветки попадает в регулярные выражения — экранируем спецсимволы
// (release/1.0 и подобные не должны ломать проверку).
const MAIN_RE = MAIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const deny = (why) => {
  console.error(why)
  process.exit(2)
}

// Каталог, в котором git реально выполнится: приоритет `git -C <путь>`,
// затем ведущий `cd <путь> && ...`, затем cwd сессии. Кавычки в путях
// обязательны к разбору — пути с пробелами обычное дело. Без этого проверка
// ветки смотрела бы на основной чекаут, а не на worktree агента, и
// блокировала бы легитимные коммиты в ветках задач.
const effectiveDir = () => {
  const mC = cmd.match(/\bgit\s+(?:-\S+\s+)*-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
  if (mC) return path.resolve(cwd, mC[1] ?? mC[2] ?? mC[3])
  const mCd = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/)
  if (mCd) return path.resolve(cwd, mCd[1] ?? mCd[2] ?? mCd[3])
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

// 1. Коммит в главную ветку
if (/\bgit\s+commit\b/.test(cmd) && currentBranch() === MAIN) {
  deny(
    `Запрещено коммитить в ${MAIN}. Процесс: заведи ветку задачи и worktree ` +
      `(git worktree add ${cfg.worktreeDir}/<ветка> -b <ветка>), работай там, ` +
      `изменения попадают в ${MAIN} только через PR.`
  )
}

// 2. Пуш в главную ветку. Refspec разбирается токенами, а не подстрокой —
// иначе ложно ловились бы ветки вида feature-<main>.
const pushMatch = cmd.match(/\bgit\s+push\b([^|&;]*)/)
if (pushMatch) {
  const args = pushMatch[1].trim().split(/\s+/).filter((t) => t && !t.startsWith('-'))
  const refspecs = args.slice(1)
  const toMain = new RegExp(`:(refs/heads/)?${MAIN_RE}$`)
  if (refspecs.some((t) => t === MAIN || toMain.test(t))) {
    deny(`Запрещено пушить напрямую в ${MAIN}. Оформи изменения через PR.`)
  }
  // Без refspec push уходит в текущую ветку; refspec HEAD — это тоже она.
  // С главной ветки и то и другое — пуш в главную.
  if ((refspecs.length === 0 || refspecs.includes('HEAD')) && currentBranch() === MAIN) {
    deny(`Ты на ${MAIN}: этот push ушёл бы в ${MAIN}. Работай в ветке задачи.`)
  }
}

// 3. Обход проверок (включая короткий -n у git commit)
if (
  /--no-verify|--no-gpg-sign/.test(cmd) ||
  (/\bgit\s+commit\b/.test(cmd) && /\s-\w*n\b/.test(cmd))
) {
  deny(
    'Обход хуков (--no-verify, включая короткий -n у git commit) и --no-gpg-sign ' +
      'запрещён. Почини причину, а не проверку. Если -n попал в текст сообщения — ' +
      'переформулируй сообщение.'
  )
}

// 4. Чужое авторство в коммитах
if (/\bgit\s+commit\b/.test(cmd)) {
  // Сканируем текст сообщения (-m), а не всю команду: путь .claude/... в той
  // же строке — не «упоминание ассистента». Без -m (редактор, -F и т.п.) —
  // консервативно сканируем всю команду.
  const msgs = [...cmd.matchAll(/-m\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .join('\n')
  const scan = msgs || cmd
  if (/Co-Authored-By/i.test(scan)) {
    deny(
      'Trailer Co-Authored-By запрещён: автор коммитов только владелец репозитория, ' +
        'упоминание ассистентов в авторстве недопустимо.'
    )
  }
  if (/(claude|anthropic|assistant|copilot|noreply@anthropic)/i.test(scan)) {
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

// 5. Разрушительные операции
if (/\bgit\s+push\b.*(--force(?!-with-lease)|\s-f\b)/.test(cmd)) {
  deny('git push --force запрещён. Если правда нужно — только --force-with-lease и из ветки задачи.')
}
if (new RegExp(`\\bgit\\s+reset\\s+--hard\\b.*\\borigin/${MAIN_RE}\\b`).test(cmd)) {
  deny(`git reset --hard origin/${MAIN} затрёт работу. Используй git stash или новую ветку.`)
}

process.exit(0)
