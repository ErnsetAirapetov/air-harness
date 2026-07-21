#!/usr/bin/env node
// PreToolUse-гейт на Bash. Не даёт нарушить git-процесс харнеса.
// Блокировка = exit 2 + причина в stderr (уходит модели как обратная связь).
//
// Скрипт не знает названия главной ветки и email владельца — берёт их из
// .claude/harness.json целевого проекта. Если проект не инициализирован,
// работает на дефолтах и остаётся безвредным.
//
// Ключевой принцип: команда РАЗБИРАЕТСЯ, а не грепается по сырой строке.
// Наивный греп давал ложные блокировки (подстрока `git commit` в кавычке-
// аргументе не-git команды; путь `.claude/...` как «упоминание ассистента»)
// и дыру-обход (`git -C dir commit` не ловился). Поэтому git-команды
// определяются только в командных позициях, а текст внутри кавычек-аргументов
// в детекте команд не участвует никогда.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

// --- Разбор командной строки -------------------------------------------------

// Токенизация с учётом кавычек и разбивка на сегменты по разделителям команд
// (`;`, `&&`, `||`, `|`, `&`, перевод строки). Кавычки снимаются, их содержимое
// входит в токен как есть — и потому НИКОГДА не оказывается первым токеном
// сегмента, то есть не может быть принято за исполняемую команду. Возвращает
// массив сегментов, каждый сегмент — массив токенов.
const parseSegments = (line) => {
  const segs = []
  let seg = []
  let tok = ''
  let started = false // токен начат (нужно, чтобы отличить пустую кавычку "" от «нет токена»)
  let quote = null // null | '"' | "'"
  const endTok = () => {
    if (started) {
      seg.push(tok)
      tok = ''
      started = false
    }
  }
  const endSeg = () => {
    endTok()
    if (seg.length) {
      segs.push(seg)
      seg = []
    }
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      else tok += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === '\\') {
      // экранирование вне кавычек: следующий символ — литеральный
      if (i + 1 < line.length) {
        tok += line[++i]
        started = true
      }
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endTok()
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '&' || ch === '|') {
      endSeg()
      continue
    }
    tok += ch
    started = true
  }
  endSeg()
  return segs
}

// Глобальные флаги git, забирающие следующий токен как аргумент. Нужны, чтобы
// добраться до сабкоманды через них: `git -C dir commit` — это commit, а не dir.
const GIT_GLOBAL_ARG_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--attr-source',
])

// Извлекает git-команды из строки: для каждой — сабкоманда `sub` и её
// аргументы `args` (уже без глобальных флагов git). Пустой массив — git-команд
// в командных позициях нет (подстрока `git ...` внутри кавычки-аргумента другой
// команды сюда не попадает).
const gitCommands = (line) => {
  const out = []
  for (const seg of parseSegments(line)) {
    let i = 0
    // префиксы-присваивания перед именем команды: `VAR=x git commit`
    while (i < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i])) i++
    if (i >= seg.length || seg[i] !== 'git') continue
    i++
    // пропускаем глобальные флаги git и их аргументы, добираясь до сабкоманды
    while (i < seg.length && seg[i].startsWith('-')) {
      const t = seg[i]
      if (t.includes('=')) {
        i++ // --git-dir=... самодостаточен
        continue
      }
      if (GIT_GLOBAL_ARG_FLAGS.has(t)) {
        i += 2 // флаг + его аргумент
        continue
      }
      i++ // булев глобальный флаг
    }
    if (i >= seg.length) continue
    out.push({ sub: seg[i], args: seg.slice(i + 1) })
  }
  return out
}

const gitCmds = gitCommands(cmd)

// --- Каталог, в котором git реально выполнится -------------------------------
// Приоритет `git -C <путь>`, затем ведущий `cd <путь> && ...`, затем cwd сессии.
// Кавычки в путях обязательны к разбору — пути с пробелами обычное дело. Без
// этого проверка ветки смотрела бы на основной чекаут, а не на worktree агента,
// и блокировала бы легитимные коммиты в ветках задач.
const effectiveDir = () => {
  const mC = cmd.match(/\bgit\s+(?:-\S+\s+)*-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
  if (mC) return path.resolve(cwd, mC[1] ?? mC[2] ?? mC[3])
  const mCd = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/)
  if (mCd) return path.resolve(cwd, mCd[1] ?? mCd[2] ?? mCd[3])
  return cwd
}
const dir = effectiveDir()

let branchCache
const currentBranch = () => {
  if (branchCache !== undefined) return branchCache
  try {
    branchCache = execSync(`git -C "${dir}" rev-parse --abbrev-ref HEAD`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    branchCache = ''
  }
  return branchCache
}

// Раскладывает аргументы `git commit` на источники сообщения (-m/-F), автора и
// флаги так, чтобы ЗНАЧЕНИЕ опции (например текст -m) не путалось с флагом.
// Именно из-за такой путаницы `-n` в тексте сообщения раньше принимался за
// обход хуков, а путь файла из -F — за содержимое сообщения.
const parseCommit = (args) => {
  const messages = [] // тексты -m/--message
  const files = [] // пути -F/--file
  let author = null
  let noVerify = false
  let noGpgSign = false
  let shortN = false // короткий -n (для commit это --no-verify)
  for (let i = 0; i < args.length; i++) {
    const t = args[i]
    let m
    if ((m = t.match(/^--message=([\s\S]*)$/))) {
      messages.push(m[1])
      continue
    }
    if (t === '-m' || t === '--message') {
      if (i + 1 < args.length) messages.push(args[++i])
      continue
    }
    if ((m = t.match(/^-m([\s\S]+)$/))) {
      messages.push(m[1]) // склеенный -mсообщение
      continue
    }
    if ((m = t.match(/^--file=([\s\S]*)$/))) {
      files.push(m[1])
      continue
    }
    if (t === '-F' || t === '--file') {
      if (i + 1 < args.length) files.push(args[++i])
      continue
    }
    if ((m = t.match(/^-F([\s\S]+)$/))) {
      files.push(m[1]) // склеенный -Fпуть
      continue
    }
    if ((m = t.match(/^--author=([\s\S]*)$/))) {
      author = m[1]
      continue
    }
    if (t === '--author') {
      if (i + 1 < args.length) author = args[++i]
      continue
    }
    // короткий бандл, оканчивающийся на -m/-F: `-am`, `-aF` — забирает значение
    if (/^-[a-zA-Z]*[mF]$/.test(t)) {
      if (/n/.test(t)) shortN = true
      if (i + 1 < args.length) (t.endsWith('m') ? messages : files).push(args[++i])
      continue
    }
    if (t === '--no-verify') {
      noVerify = true
      continue
    }
    if (t === '--no-gpg-sign') {
      noGpgSign = true
      continue
    }
    // прочий короткий бандл (не --long): `-n`, `-an`, ... — обход хуков у commit
    if (/^-[a-zA-Z]+$/.test(t) && /n/.test(t)) {
      shortN = true
      continue
    }
  }
  return { messages, files, author, noVerify, noGpgSign, shortN }
}

// Разбор всех `git commit` заранее — нужен проверкам 1, 3, 4.
const commits = gitCmds.filter((c) => c.sub === 'commit').map((c) => parseCommit(c.args))

// 1. Коммит в главную ветку
if (commits.length && currentBranch() === MAIN) {
  deny(
    `Запрещено коммитить в ${MAIN}. Процесс: заведи ветку задачи и worktree ` +
      `(git worktree add ${cfg.worktreeDir}/<ветка> -b <ветка>), работай там, ` +
      `изменения попадают в ${MAIN} только через PR.`
  )
}

// 2. Пуш в главную ветку. Refspec разбирается токенами, а не подстрокой —
// иначе ложно ловились бы ветки вида feature-<main>.
for (const c of gitCmds) {
  if (c.sub !== 'push') continue
  const positional = c.args.filter((t) => !t.startsWith('-'))
  const refspecs = positional.slice(1) // [0] — это remote
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

// 3. Обход проверок. Флаги ищем среди ТОКЕНОВ конкретной git-команды, а не
// подстрокой по всей строке: `--no-verify`/`-n` в тексте сообщения — не флаги.
const BYPASS =
  'Обход хуков (--no-verify, короткий -n у git commit) и --no-gpg-sign ' +
  'запрещён. Почини причину, а не проверку.'
for (const c of gitCmds) {
  if (c.sub === 'commit') continue // коммиты разбираем ниже с учётом сообщения
  if (c.args.includes('--no-verify') || c.args.includes('--no-gpg-sign')) deny(BYPASS)
}
for (const p of commits) {
  if (p.noVerify || p.noGpgSign || p.shortN) deny(BYPASS)
}

// 4. Чужое авторство в коммитах. Сканируется ТОЛЬКО содержимое сообщения —
// тексты -m и содержимое файла из -F (не его путь). Файл нечитаем (ещё не создан
// внутри составной команды) или `-F -` (stdin) — сканировать нечего, коммит не
// блокируем: откат к скану сырой команды и есть исходный баг.
for (const p of commits) {
  const parts = [...p.messages]
  for (const f of p.files) {
    if (f === '-') continue // -F - (stdin): содержимого на диске нет
    try {
      parts.push(readFileSync(path.resolve(dir, f), 'utf8'))
    } catch {
      // файл ещё не создан или нечитаем — пропускаем, не блокируем
    }
  }
  const scan = parts.join('\n')
  if (scan) {
    if (/Co-Authored-By/i.test(scan)) {
      deny(
        'Trailer Co-Authored-By запрещён: автор коммитов только владелец репозитория, ' +
          'упоминание ассистентов в авторстве недопустимо.'
      )
    }
    // `claude` — регистрозависимо (`\bClaude\b`): «CLAUDE.md» и «.claude/…» суть
    // легитимные ссылки на файлы этого же харнеса в сообщениях; ассистента же в
    // атрибуции пишут прозой в Title Case («Claude»). Остальные маркеры — без
    // учёта регистра.
    if (/anthropic|assistant|copilot|noreply@anthropic/i.test(scan) || /\bClaude\b/.test(scan)) {
      deny(
        'В сообщении коммита есть упоминание ассистента — это запрещено. ' +
          'Перепиши сообщение по существу изменений.'
      )
    }
  }
  if (p.author && cfg.ownerEmail && !p.author.includes(cfg.ownerEmail)) {
    deny(`--author должен быть ${cfg.ownerEmail}, получено: ${p.author}`)
  }
}

// 5. Разрушительные операции
for (const c of gitCmds) {
  if (c.sub === 'push' && c.args.some((t) => t === '--force' || t === '-f')) {
    deny('git push --force запрещён. Если правда нужно — только --force-with-lease и из ветки задачи.')
  }
  if (
    c.sub === 'reset' &&
    c.args.includes('--hard') &&
    c.args.some((t) => new RegExp(`\\borigin/${MAIN_RE}\\b`).test(t))
  ) {
    deny(`git reset --hard origin/${MAIN} затрёт работу. Используй git stash или новую ветку.`)
  }
}

process.exit(0)
