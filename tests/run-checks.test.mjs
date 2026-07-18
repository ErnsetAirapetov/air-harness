// Тест гейта run-checks.mjs. Запуск: node tests/run-checks.test.mjs
//
// Поднимает временный git-репозиторий с главной веткой `trunk` и гоняет хук
// с разными состояниями дерева и конфига. Ключевой кейс — worktree: основной
// чекаут чистый, а worktree агента грязный; до починки хук смотрел в основной
// чекаут и молча пропускал красные проверки (гейт-плацебо).
//
// Вход хука строится в Node и передаётся через stdin — сборка JSON в shell
// ломается на экранировании и даёт ложно-зелёный результат.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.slice(1))
const HOOK = path.join(HERE, '..', 'core', 'scripts', 'run-checks.mjs')

const RED = 'node -e "process.exit(1)"'
const GREEN = 'node -e ""'

const proj = mkdtempSync(path.join(tmpdir(), 'harness-checks-'))
const git = (...args) => execFileSync('git', ['-C', proj, ...args], { stdio: 'ignore' })

const setCfg = (dir, cfg) =>
  writeFileSync(path.join(dir, '.claude', 'harness.json'), JSON.stringify(cfg))

git('init', '-q', '-b', 'trunk', '.')
git('config', 'user.email', 'owner@example.com')
git('config', 'user.name', 'Owner')
mkdirSync(path.join(proj, '.claude'), { recursive: true })
setCfg(proj, { mainBranch: 'trunk', checks: [RED], strict: true })
git('add', '.')
git('commit', '-q', '-m', 'init')

const run = (input) => {
  try {
    execFileSync('node', [HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { code: 0, msg: '' }
  } catch (e) {
    return { code: e.status, msg: (e.stderr || '').trim().split('\n')[0] }
  }
}

let failed = 0
const check = (wantCode, name, input) => {
  const { code, msg } = run(input)
  const ok = code === wantCode
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : 'ПРОВАЛ'} [${wantCode}] ${name}${msg ? ' — ' + msg : ''}`)
}

try {
  // Чистое дерево — проверки не запускаются даже с красным check.
  check(0, 'чистое дерево, красный check', { cwd: proj })

  // Worktree заводится до загрязнения основного чекаута: главный кейс —
  // основной чекаут чистый, worktree грязный.
  const wt = path.join(proj, 'wt dir')
  git('worktree', 'add', wt, '-b', 'feat/task-1')
  writeFileSync(path.join(wt, 'dirty.txt'), 'x')
  check(2, 'worktree грязный (основной чекаут чистый), красный check', { cwd: wt })
  check(0, 'stop_hook_active в worktree — не зацикливаемся', {
    cwd: wt,
    stop_hook_active: true,
  })

  writeFileSync(path.join(proj, 'dirty.txt'), 'x')
  check(2, 'грязное дерево, красный check, strict', { cwd: proj })

  setCfg(proj, { mainBranch: 'trunk', checks: [RED], strict: false })
  check(0, 'грязное дерево, красный check, strict:false — не блокирует', { cwd: proj })

  setCfg(proj, { mainBranch: 'trunk', checks: [GREEN], strict: true })
  check(0, 'грязное дерево, зелёный check', { cwd: proj })

  setCfg(proj, { mainBranch: 'trunk', checks: [], strict: true })
  check(0, 'пустой список checks', { cwd: proj })

  const bare = mkdtempSync(path.join(tmpdir(), 'harness-noinit-'))
  try {
    check(0, 'проект без harness.json — хук безвреден', { cwd: bare })
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
} finally {
  rmSync(proj, { recursive: true, force: true })
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nвсе случаи прошли')
process.exit(failed ? 1 : 0)
