// Copies player-safe notes from the Obsidian vault into Quartz's content folder.
//
// Only notes under SOURCE_FOLDERS whose frontmatter says `publish: true` are copied.
// DM/, Meta/, Unsorted/ and anything with `type: secret` are never read for publishing.
// Obsidian %% comments %% are stripped, and links to notes that aren't published
// become plain text so the site has no dead links.
//
//   node scripts/sync-vault.mjs                 -> content/          (what gets published)
//   node scripts/sync-vault.mjs --preview-all   -> preview-content/  (every World note, local only, gitignored)

import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const VAULT = path.resolve(process.env.VAULT ?? path.join(ROOT, "..", "Obsidian Vault"))
const PREVIEW_ALL = process.argv.includes("--preview-all")
const OUT = path.join(ROOT, PREVIEW_ALL ? "preview-content" : "content")
const SOURCE_FOLDERS = ["World", "Sessions"]
const NEVER = ["DM", "Meta", "Unsorted", ".obsidian", ".trash", ".smart-env"]
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"])

const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        return e.isDirectory() ? (e.name.startsWith(".") ? [] : walk(p)) : [p]
      })
    : []

const frontmatter = (text) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const fm = {}
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/)
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "")
  }
  return fm
}

// ---- collect notes
const notes = []
for (const folder of SOURCE_FOLDERS) {
  for (const file of walk(path.join(VAULT, folder))) {
    if (!file.endsWith(".md")) continue
    const rel = path.relative(VAULT, file)
    // a DM folder is never published, wherever it sits
    if (rel.split(path.sep).includes("DM")) continue
    const text = fs.readFileSync(file, "utf8")
    const fm = frontmatter(text)
    if (fm.type === "secret") continue
    if (!PREVIEW_ALL && fm.publish !== "true") continue
    notes.push({ rel, text, stem: path.basename(file, ".md") })
  }
}
// ---- browse pages, generated from published notes only so private names never appear
// [path prefix inside World/ or Sessions/, page, section]; first match wins, section order follows this list
const BROWSE = [
  ["World/Characters/The Party", "People", "The Party"],
  ["World/Characters/Player Characters/", "People", "The Party"],
  ["World/Characters/NPCS/Primon Boundary Residents/", "People", "Primon Boundary"],
  ["World/Characters/NPCS/Saers Major Figures/", "People", "Saers"],
  ["World/Characters/NPCS/Hjirolis Residents/", "People", "Hjirolis"],
  ["World/Characters/NPCS/Inseore Gnomes/", "People", "Inseore Gnomes"],
  ["World/Characters/NPCS/Infernals/", "People", "Infernals"],
  ["World/Characters/NPCS/Divines/Paragons/", "Lore", "Powers & Spirits"],
  ["World/Characters/NPCS/Divines/", "Lore", "Divines"],
  ["World/Characters/NPCS/Progenitors/", "Lore", "Powers & Spirits"],
  ["World/Characters/NPCS/Major Spirits/", "Lore", "Powers & Spirits"],
  ["World/Characters/", "People", "Other Notable Figures"],
  ["World/Places/Adela", "Places", "The World"],
  ["World/Places/Continents/", "Places", "The World"],
  ["World/Places/Celestial Bodies/", "Places", "The Sky"],
  ["World/Places/Nations/", "Places", "Nations"],
  ["World/Places/Towns/Saers/", "Places", "Towns of Saers"],
  ["World/Places/Towns/Shimmerwyld/", "Places", "Glades of the Shimmerwyld"],
  ["World/Places/Major Landmarks/", "Places", "Landmarks"],
  ["World/Places/", "Places", "Cities & Regions"],
  ["World/Factions/Noble Families of Hjirolis/", "Factions", "Noble Families of Hjirolis"],
  ["World/Factions/", "Factions", "Factions & Peoples"],
  ["World/Major Events/", "Lore", "Major Events"],
  ["World/Notable Objects/", "Lore", "Notable Objects"],
  ["World/Flora, Fauna, and Spirits/", "Lore", "Flora & Fauna"],
  ["Sessions/", "Session Log", "Recaps"],
]
const BROWSE_INTRO = {
  People: "Everyone the party has met or heard of.",
  Places: "Everywhere the party has been or heard of.",
  Factions: "Groups, guilds, peoples and noble houses.",
  Lore: "Divines, powers, events and notable objects.",
  "Session Log": "What happened, session by session.",
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const browse = new Map(Object.keys(BROWSE_INTRO).map((p) => [p, new Map()]))
for (const note of notes) {
  const rel = note.rel.split(path.sep).join("/").replace(/\.md$/, "")
  const hit = BROWSE.find(([prefix]) => rel.startsWith(prefix))
  if (!hit) continue
  const [, page, section] = hit
  const sections = browse.get(page)
  if (!sections.has(section)) sections.set(section, [])
  const fm = frontmatter(note.text)
  sections.get(section).push({ stem: note.stem, desc: fm.description, order: Number(fm.session) || 0, first: fm.type === "meta" })
}
const browsePages = [...browse.keys()]

const published = new Set([...notes.map((n) => n.stem.toLowerCase()), ...browsePages.map((p) => p.toLowerCase())])

// images anywhere outside the never-publish folders, by file name
const images = new Map()
for (const file of walk(VAULT)) {
  const rel = path.relative(VAULT, file)
  if (IMAGE_EXT.has(path.extname(file).toLowerCase()) && !NEVER.filter((n) => n !== "Meta").some((n) => rel.split(path.sep).includes(n)))
    images.set(path.basename(file).toLowerCase(), file)
}

// ---- transform + write
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const usedImages = new Set()

// Frontmatter fields that reach the public repo; everything else (connections, affiliations…) is dropped.
const KEEP_FM = new Set(["title", "description", "tags", "aliases", "publish", "date", "created", "modified"])
const cleanFrontmatter = (text) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return text
  let keep = false
  const lines = m[1].split(/\r?\n/).filter((line) => {
    const key = line.match(/^([\w-]+):/)
    if (key) keep = KEEP_FM.has(key[1])
    return keep
  })
  const fm = frontmatter(text)
  const lead = fm.description ? `*${fm.description[0].toUpperCase()}${fm.description.slice(1)}*\n\n` : ""
  return `---\n${lines.join("\n")}\n---\n${lead}${text.slice(m[0].length)}`
}

for (const note of notes) {
  let text = cleanFrontmatter(note.text).replace(/%%[\s\S]*?%%/g, "").replace(/!?\[\[\s*\]\]/g, "")
  text = text.replace(/(!?)\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]/g, (all, bang, target, anchor = "", alias = "") => {
    const t = target.trim()
    if (bang) {
      const img = images.get(path.basename(t).toLowerCase())
      if (img) { usedImages.add(img); return all }
      return ""
    }
    if (published.has(path.basename(t).toLowerCase())) return all
    return alias ? alias.slice(1) : t
  })
  if (PREVIEW_ALL) {
    // local preview only: let Quartz's ExplicitPublish filter through every note
    text = /^---\r?\n/.test(text) ? text.replace(/^---\r?\n/, "---\npublish: true\n") : `---\npublish: true\n---\n${text}`
  }
  const dest = path.join(OUT, note.rel.replace(/^World[\\/]/, ""))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, text)
}

for (const img of usedImages) {
  fs.mkdirSync(path.join(OUT, "assets"), { recursive: true })
  fs.copyFileSync(img, path.join(OUT, "assets", path.basename(img)))
}

for (const [page, sections] of browse) {
  const order = [...new Set(BROWSE.filter(([, p]) => p === page).map(([, , s]) => s))]
  let body = `---\ntitle: ${page}\npublish: true\n---\n${BROWSE_INTRO[page]}\n`
  const present = order.filter((s) => sections.has(s))
  if (!present.length) body += page === "Session Log" ? "\nRecaps are on their way.\n" : "\nNothing here yet.\n"
  for (const section of present) {
    const items = sections.get(section).sort((a, b) => b.first - a.first || a.order - b.order || a.stem.localeCompare(b.stem))
    body += `\n## ${section}\n` + items.map((i) => `- [[${i.stem}]]${i.desc ? ` — ${cap(i.desc)}` : ""}`).join("\n") + "\n"
  }
  fs.mkdirSync(path.join(OUT, "Browse"), { recursive: true })
  fs.writeFileSync(path.join(OUT, "Browse", `${page}.md`), body)
}

if (!notes.some((n) => /^World[\\/]Home\.md$/.test(n.rel))) {
  fs.writeFileSync(path.join(OUT, "index.md"), "---\ntitle: Adela\npublish: true\n---\nThe campaign wiki is under construction.\n")
} else {
  fs.renameSync(path.join(OUT, "Home.md"), path.join(OUT, "index.md"))
}
fs.writeFileSync(path.join(OUT, ".gitkeep"), "")

console.log(`${PREVIEW_ALL ? "[preview-all] " : ""}${notes.length} notes, ${usedImages.size} images -> ${path.relative(ROOT, OUT)}`)
