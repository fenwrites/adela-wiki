// Checks content/ for DM-only material. Run after sync-vault.mjs and before pushing.
//   node scripts/leak-check.mjs    -> exits 1 if anything is flagged
// The forbidden words live in the vault at DM/Leak Check Words.md, not here: this repo is public.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const VAULT = path.resolve(process.env.VAULT ?? path.join(ROOT, "..", "Obsidian Vault"))
const CONTENT = path.resolve(process.env.CONTENT ?? path.join(ROOT, "content"))
const WORDS = path.join(VAULT, "DM", "Leak Check Words.md")
const MIN_LINE = 40

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".")) return []
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : e.name.endsWith(".md") ? [p] : []
  })
}
const read = (p) => fs.readFileSync(p, "utf8")
const stem = (p) => path.basename(p, ".md")
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

for (const [what, p] of [["Vault", VAULT], ["Content", CONTENT], ["Word list", WORDS]]) {
  if (!fs.existsSync(p)) {
    console.error(`${what} not found: ${p}`)
    process.exit(2)
  }
}

const published = walk(CONTENT).map((p) => ({ rel: path.relative(CONTENT, p), name: stem(p), text: read(p) }))
const all = published.map((f) => f.text).join("\n")
const bad = []

// 1. long lines copied from secret notes
for (const file of walk(path.join(VAULT, "DM", "Secrets"))) {
  for (const raw of read(file).split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*#\s]+/, "").trim()
    if (line.length >= MIN_LINE && !line.startsWith("%%") && all.includes(line)) {
      bad.push(`secret line from ${stem(file)}: ${line.slice(0, 70)}`)
    }
  }
}

// 2. files or links for unpublished notes
for (const file of walk(VAULT)) {
  const text = read(file)
  if (!/^publish:\s*false/m.test(text) && !/^type:\s*secret/m.test(text)) continue
  const name = stem(file)
  if (new RegExp(`\\[\\[${escapeRe(name)}(\\\\?\\||\\]|#)`).test(all)) bad.push(`link to unpublished note: ${name}`)
  if (published.some((f) => f.name === name)) bad.push(`file for unpublished note: ${name}`)
}

// 3. leftover Obsidian comments
for (const f of published) if (f.text.includes("%%")) bad.push(`%% comment in ${f.rel}`)

// 4. forbidden words (one per "- " bullet in the word list)
const words = read(WORDS)
  .split(/\r?\n/)
  .filter((l) => l.startsWith("- "))
  .map((l) => l.slice(2).trim().toLowerCase())
  .filter(Boolean)
for (const word of words) {
  for (const f of published) if (f.text.toLowerCase().includes(word)) bad.push(`word "${word}" in ${f.rel}`)
}

console.log(`${published.length} published notes, ${words.length} forbidden words`)
if (bad.length) {
  console.log(bad.join("\n"))
  console.log(`\nLEAK CHECK FAILED: ${bad.length} issue(s)`)
  process.exit(1)
}
console.log("LEAK CHECK CLEAN")
