// Тест хука edit-checks.mjs. Запуск: node tests/edit-checks.test.mjs
//
// Хуку не нужен git — только .claude/harness.json с секцией editChecks.
// Проверяем: срабатывание по match, молчание на чужих файлах и без секции,
// зелёный прогон.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.slice(1))
const HOOK = path.join(HERE, '..', 'core', 'scripts', 'edit-checks.mjs')

const RED = 'node -e "process.exit(1)"'
const GREEN = 'node -e ""'

const proj = mkdtempSync(path.join(tmpdir(), 'harness-edit-'))
mkdirSync(path.join(proj, '.claude'), { recursive: true })

const setCfg = (cfg) =>
  writeFileSync(path.join(proj, '.claude', 'harness.json'), JSON.stringify(cfg))

const run = (file) => {
  const input = JSON.stringify({ cwd: proj, tool_input: { file_path: file } })
  try {
    execFileSync('node', [HOOK], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { code: 0, msg: '' }
  } catch (e) {
    return { code: e.status, msg: (e.stderr || '').trim().split('\n')[0] }
  }
}

let failed = 0
const check = (wantCode, name, file) => {
  const { code, msg } = run(file)
  const ok = code === wantCode
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : 'ПРОВАЛ'} [${wantCode}] ${name}${msg ? ' — ' + msg : ''}`)
}

try {
  setCfg({ editChecks: [{ match: '\\.txt$', run: RED }] })
  check(2, 'правка .txt, красная проверка', path.join(proj, 'a.txt'))
  check(0, 'правка .md — match не совпал', path.join(proj, 'a.md'))

  setCfg({ editChecks: [{ match: '\\.txt$', run: GREEN }] })
  check(0, 'правка .txt, зелёная проверка', path.join(proj, 'a.txt'))

  setCfg({ checks: ['whatever'] })
  check(0, 'нет секции editChecks — хук молчит', path.join(proj, 'a.txt'))

  setCfg({ editChecks: [{ match: '(битая', run: RED }] })
  check(0, 'битый regex в match — правило пропускается', path.join(proj, 'a.txt'))
} finally {
  rmSync(proj, { recursive: true, force: true })
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nвсе случаи прошли')
process.exit(failed ? 1 : 0)
