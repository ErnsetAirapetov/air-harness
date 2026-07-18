// Тест гейта guard-git.mjs. Запуск: node tests/guard-git.test.mjs
//
// Поднимает временный git-репозиторий с главной веткой `trunk` (намеренно не
// `main` — так видно, что скрипт берёт имя из .claude/harness.json, а не знает
// его сам) и прогоняет набор команд через хук.
//
// Вход хука строится в Node, а не в shell: экранирование кавычек и обратных
// слэшей через оболочку ломается и даёт ложно-зелёный результат.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.slice(1))
const GUARD = path.join(HERE, '..', 'core', 'scripts', 'guard-git.mjs')
const OWNER = 'owner@example.com'

const proj = mkdtempSync(path.join(tmpdir(), 'harness-test-'))
const git = (...args) => execFileSync('git', ['-C', proj, ...args], { stdio: 'ignore' })

git('init', '-q', '-b', 'trunk', '.')
git('config', 'user.email', OWNER)
git('config', 'user.name', 'Owner')
git('commit', '-q', '--allow-empty', '-m', 'init')
mkdirSync(path.join(proj, '.claude'), { recursive: true })
writeFileSync(
  path.join(proj, '.claude', 'harness.json'),
  JSON.stringify({ mainBranch: 'trunk', ownerEmail: OWNER, checks: [] })
)
git('checkout', '-q', '-b', 'feat/task-1')

// Каталог с пробелом — проверка разбора кавычек в `cd "..."` и `git -C "..."`.
mkdirSync(path.join(proj, 'sub dir'), { recursive: true })
// Worktree на отдельной ветке — легитимный сценарий агента: сессия стоит на
// главной, а коммит уходит в worktree ветки задачи через git -C.
const wt = path.join(proj, 'wt dir')
git('worktree', 'add', wt, '-b', 'feat/task-2')

const run = (command) => {
  const input = JSON.stringify({ cwd: proj, tool_input: { command } })
  try {
    execFileSync('node', [GUARD], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { code: 0, msg: '' }
  } catch (e) {
    return { code: e.status, msg: (e.stderr || '').trim().split('\n')[0] }
  }
}

// На главной ветке первым срабатывает запрет коммита в неё и маскирует
// остальные правила — поэтому авторство, --no-verify и прочее проверяются
// на ветке задачи, где ветвевой гейт молчит.
const ON_MAIN = [
  ['БЛОК', 'коммит в главную', 'git commit -m "x"'],
  ['БЛОК', 'голый push с главной', 'git push'],
  ['БЛОК', 'push в главную', 'git push origin trunk'],
  ['БЛОК', 'push origin HEAD с главной', 'git push origin HEAD'],
  ['БЛОК', 'push -u origin без refspec', 'git push -u origin'],
  ['БЛОК', 'cd в каталог с пробелом, всё ещё главная', 'cd "sub dir" && git commit -m "feat: x"'],
  ['ПРОП', 'коммит в worktree ветки через git -C', `git -C "${wt}" commit -m "feat: x"`],
  ['ПРОП', 'посторонняя команда', 'npm test'],
  ['ПРОП', 'чтение состояния', 'git status'],
]

const ON_BRANCH = [
  ['ПРОП', 'обычный коммит', 'git commit -m "feat: нормальный коммит"'],
  ['ПРОП', 'push ветки задачи', 'git push origin feat/task-1'],
  ['ПРОП', 'голый push с ветки', 'git push'],
  ['ПРОП', 'push origin HEAD с ветки', 'git push origin HEAD'],
  ['ПРОП', 'refspec feature-trunk — не главная', 'git push origin feature-trunk'],
  ['БЛОК', 'refspec HEAD:главная', 'git push origin HEAD:trunk'],
  ['ПРОП', 'автор — владелец', `git commit --author="Owner <${OWNER}>" -m "feat: x"`],
  ['БЛОК', 'чужой автор', 'git commit --author="Someone <a@b.c>" -m "x"'],
  ['БЛОК', 'trailer Co-Authored-By', 'git commit -m "feat: x\n\nCo-Authored-By: Claude <a@b>"'],
  ['БЛОК', 'упоминание ассистента', 'git commit -m "chore: сгенерировано Claude"'],
  ['ПРОП', 'claude в пути файла, не в сообщении', 'git commit -m "chore: настройка хуков" .claude/settings.json'],
  ['БЛОК', 'обход хуков', 'git commit -m "x" --no-verify'],
  ['БЛОК', 'короткий -n у commit', 'git commit -n -m "feat: x"'],
  ['БЛОК', 'force push', 'git push --force origin feat/task-1'],
  ['БЛОК', 'reset --hard на главную', 'git reset --hard origin/trunk'],
]

let failed = 0
const check = (want, name, command) => {
  const { code, msg } = run(command)
  const blocked = code === 2
  const ok = want === 'БЛОК' ? blocked : !blocked
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : 'ПРОВАЛ'} [${want}] ${name}${msg ? ' — ' + msg : ''}`)
}

try {
  git('checkout', '-q', 'trunk')
  console.log('на главной ветке:')
  for (const c of ON_MAIN) check(...c)

  git('checkout', '-q', 'feat/task-1')
  console.log('на ветке задачи:')
  for (const c of ON_BRANCH) check(...c)
} finally {
  rmSync(proj, { recursive: true, force: true })
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nвсе случаи прошли')
process.exit(failed ? 1 : 0)
