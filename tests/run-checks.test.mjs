// Тест гейта run-checks.mjs. Запуск: node tests/run-checks.test.mjs
//
// Поднимает временный git-репозиторий с главной веткой `trunk` и гоняет хук
// с разными состояниями дерева и конфига. Ключевой кейс — worktree: основной
// чекаут чистый, а worktree агента грязный; до починки хук смотрел в основной
// чекаут и молча пропускал красные проверки (гейт-плацебо).
//
// Второй ключевой кейс — освобождение по транскрипту: агент без файловых
// правок (только Read/Grep/Bash) освобождается от DoD-прогона, даже если
// дерево грязное чужими изменениями. Транскрипты собираются в Node в отдельном
// каталоге вне репозитория, чтобы их файлы не загрязнили дерево.
//
// Вход хука строится в Node и передаётся через stdin — сборка JSON в shell
// ломается на экранировании и даёт ложно-зелёный результат.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.slice(1))
const HOOK = path.join(HERE, '..', 'core', 'scripts', 'run-checks.mjs')

const RED = 'node -e "process.exit(1)"'
const GREEN = 'node -e ""'

const proj = mkdtempSync(path.join(tmpdir(), 'harness-checks-'))
// Транскрипты живут вне репозитория: положи их внутрь proj — и untracked-файлы
// сделают дерево грязным, сломав кейс с чистым чекаутом.
const tcDir = mkdtempSync(path.join(tmpdir(), 'harness-tc-'))
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

// spawnSync (не execFileSync) — чтобы забрать stderr и при exit 0: сообщение
// освобождения «Агент не менял файлы…» пишется в stderr на успешном выходе.
const run = (input) => {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  })
  return { code: r.status, msg: (r.stderr || '').trim().split('\n')[0] }
}

let failed = 0
const check = (wantCode, name, input, wantMsg) => {
  const { code, msg } = run(input)
  const codeOk = code === wantCode
  const msgOk = wantMsg == null || (msg && msg.includes(wantMsg))
  const ok = codeOk && msgOk
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : 'ПРОВАЛ'} [${wantCode}] ${name}${msg ? ' — ' + msg : ''}`)
}

// Собирает JSONL-транскрипт из готовых строк (валидный JSON или мусор) и
// возвращает путь к файлу вне репозитория.
let tcSeq = 0
const transcript = (lines) => {
  const file = path.join(tcDir, `t-${tcSeq++}.jsonl`)
  writeFileSync(file, lines.join('\n'))
  return file
}
// Запись assistant с одним tool_use — структура реального транскрипта Claude Code.
const toolUse = (name) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] },
  })

try {
  // Чистое дерево — проверки не запускаются даже с красным check.
  check(0, 'чистое дерево, красный check', { cwd: proj })

  // Даже когда транскрипт говорит о правках, dirty-фильтр остаётся вторым
  // рубежом: чистый чекаут — прогона нет.
  check(0, 'чистое дерево + транскрипт с Edit — без прогона', {
    cwd: proj,
    transcript_path: transcript([toolUse('Edit')]),
  })

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

  // Освобождение по транскрипту. Дерево грязное, check красный, strict —
  // но транскрипт без файловых правок (Read/Grep/Bash): грязь не этого агента,
  // прогона нет. Главный кейс задачи #34.
  check(
    0,
    'транскрипт без правок (Read/Grep/Bash) — освобождён, прогона нет',
    {
      cwd: proj,
      transcript_path: transcript([toolUse('Read'), toolUse('Grep'), toolUse('Bash')]),
    },
    'не менял файлы',
  )
  // Один Edit — исполнитель, гейт платит.
  check(2, 'транскрипт с Edit — не освобождается', {
    cwd: proj,
    transcript_path: transcript([toolUse('Edit')]),
  })
  // Write — тоже файловая правка.
  check(2, 'транскрипт с Write — не освобождается', {
    cwd: proj,
    transcript_path: transcript([toolUse('Write')]),
  })
  // Валидная запись Edit среди мусора — детект её всё равно находит.
  check(2, 'мусор + валидный Edit — не освобождается', {
    cwd: proj,
    transcript_path: transcript(['не json {{{', toolUse('Edit'), 'ещё %%% мусор']),
  })
  // Ни одной разобранной строки — консервативная деградация: как без транскрипта.
  check(2, 'транскрипт целиком мусор — деградация к прогону', {
    cwd: proj,
    transcript_path: transcript(['garbage', '}{ bad', 'nope']),
  })
  // Путь есть, файла нет — деградация к прогону.
  check(2, 'transcript_path на несуществующий файл — деградация', {
    cwd: proj,
    transcript_path: path.join(tcDir, 'нет-такого.jsonl'),
  })
  // Без transcript_path — поведение ровно как раньше.
  check(2, 'без transcript_path — прогон как раньше', { cwd: proj })

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
  rmSync(tcDir, { recursive: true, force: true })
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nвсе случаи прошли')
process.exit(failed ? 1 : 0)
