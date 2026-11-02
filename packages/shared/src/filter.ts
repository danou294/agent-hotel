/**
 * Filtre anti-fuite : une méthode se partage, un contexte jamais.
 *
 * Fonction pure, sans dépendance, utilisée par le MCP (avant envoi) et par le
 * serveur (qui fait foi). Elle détecte des motifs, pas du sens : la relecture
 * humaine reste le dernier filet pour ce qui est signalé « review ».
 */

export type ScanLevel = "strict" | "moderate";
export type Severity = "reject" | "review" | "ignore";
export type Verdict = "ok" | "review" | "reject";
export type Family = "secret" | "personal" | "context" | "injection";

export interface Finding {
  rule: string;
  family: Family;
  severity: Exclude<Severity, "ignore">;
  /** Champ concerné (quand on scanne plusieurs champs). */
  field?: string;
  line: number;
  /** Extrait masqué : jamais la valeur complète. */
  excerpt: string;
  hint: string;
}

export interface ScanResult {
  verdict: Verdict;
  findings: Finding[];
}

interface Rule {
  id: string;
  family: Family;
  strict: Severity;
  moderate: Severity;
  hint: string;
  /** Retourne les positions (index, longueur) des occurrences. */
  find: (text: string) => { index: number; length: number }[];
}

// ------------------------------------------------------------------ utils

const PLACEHOLDER = /<[^>]{1,40}>|\{\{?[^}]{1,40}\}?\}|\bxxx+\b|\*\*\*|\.\.\.|…|\b(your|votre|ton|ta|mon|my|example|exemple|placeholder|changeme|redacted|dummy|fake|test)\b/i;

function all(re: RegExp, text: string, filter?: (m: RegExpExecArray) => boolean) {
  const out: { index: number; length: number }[] = [];
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = r.exec(text))) {
    if (m[0].length === 0) {
      r.lastIndex++;
      continue;
    }
    if (!filter || filter(m)) out.push({ index: m.index, length: m[0].length });
  }
  return out;
}

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

const EXAMPLE_DOMAIN = /@(?:[a-z0-9-]+\.)*(?:example|exemple|domaine|domain|test|email|mail|entreprise|company|acme|foo|bar)\.[a-z]{2,}$/i;
const GENERIC_USER = /^(?:username|user|utilisateur|you|vous|toi|moi|me|name|nom|xxx+|<[^>]*>|\$\{?[A-Z_]+\}?|~)$/i;

// ------------------------------------------------------------------ règles

const RULES: Rule[] = [
  // ---- secrets : toujours refusés
  {
    id: "secret.api-key",
    family: "secret",
    strict: "reject",
    moderate: "reject",
    hint: "Retire la clé et remplace-la par une variable d'environnement ou un exemple fictif.",
    find: (t) =>
      all(
        /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|fm[12]_[A-Za-z0-9+/=_-]{20,}|FlyV1\s+fm[12]_[A-Za-z0-9+/=_-]{20,}|hotel_[0-9a-f]{48}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/,
        t,
      ),
  },
  {
    id: "secret.jwt",
    family: "secret",
    strict: "reject",
    moderate: "reject",
    hint: "C'est un jeton JWT : supprime-le.",
    find: (t) => all(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, t),
  },
  {
    id: "secret.private-key",
    family: "secret",
    strict: "reject",
    moderate: "reject",
    hint: "Bloc de clé privée : à ne jamais partager.",
    find: (t) => all(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, t),
  },
  {
    id: "secret.bearer",
    family: "secret",
    strict: "reject",
    moderate: "reject",
    hint: "En-tête d'autorisation avec un jeton réel : remplace par <TOKEN>.",
    find: (t) => all(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/, t, (m) => !PLACEHOLDER.test(m[0].slice(7))),
  },
  {
    id: "secret.assignment",
    family: "secret",
    strict: "reject",
    moderate: "reject",
    hint: "Une valeur de mot de passe, clé ou jeton est écrite en clair : remplace-la par un exemple fictif ou une variable.",
    find: (t) =>
      all(
        /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|token|access[_-]?key|private[_-]?key|mot de passe|client[_-]?secret)\b\s*(?:[:=]|est|is)\s*["'`]?([^\s"'`,;]{8,})/i,
        t,
        (m) => {
          const v = m[1];
          return !PLACEHOLDER.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !/^z\.|^process\.|^env\.|^\$|^os\./.test(v);
        },
      ),
  },
  {
    id: "secret.high-entropy",
    family: "secret",
    strict: "reject",
    moderate: "review",
    hint: "Chaîne qui ressemble à un secret près d'un mot comme key/token/secret : vérifie et masque-la.",
    find: (t) =>
      all(/[A-Za-z0-9+/=_-]{32,}/, t, (m) => {
        const s = m[0];
        if (!/\d/.test(s) || !/[a-z]/.test(s) || !/[A-Z]/.test(s)) return false;
        if (entropy(s) < 4.2) return false;
        const ctx = t.slice(Math.max(0, m.index - 60), m.index + s.length + 60);
        return /key|token|secret|bearer|authorization|credential|jeton|mot de passe/i.test(ctx);
      }),
  },

  // ---- données personnelles
  {
    id: "personal.email",
    family: "personal",
    strict: "reject",
    moderate: "review",
    hint: "Adresse e-mail réelle : remplace par prenom@exemple.fr.",
    find: (t) => all(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, t, (m) => !EXAMPLE_DOMAIN.test(m[0]) && !/noreply@anthropic\.com$/i.test(m[0])),
  },
  {
    id: "personal.phone",
    family: "personal",
    strict: "reject",
    moderate: "review",
    hint: "Numéro de téléphone : remplace par un exemple fictif (06 12 34 56 78).",
    find: (t) =>
      all(/(?:(?:\+|00)\d{1,3}[ .-]?)?\(?0?[1-9]\)?(?:[ .-]?\d{2}){4}\b|\+\d{1,3}[ .-]?\d(?:[ .-]?\d){7,12}\b/, t, (m) => {
        const digits = m[0].replace(/\D/g, "");
        if (digits.length < 9) return false;
        if (/^(\d)\1+$/.test(digits)) return false; // 00 00 00 00 00
        if (/1234567|234567|345678/.test(digits)) return false; // 06 12 34 56 78 et variantes
        // pas un numéro si c'est en fait une version, une date ou un montant
        const before = t.slice(Math.max(0, m.index - 12), m.index);
        if (/v(?:ersion)?\s*$|€\s*$|\$\s*$|n°\s*$|#\s*$/i.test(before)) return false;
        return true;
      }),
  },
  {
    id: "personal.iban",
    family: "personal",
    strict: "reject",
    moderate: "reject",
    hint: "IBAN : à ne jamais partager.",
    find: (t) => all(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/, t, (m) => ibanValid(m[0])),
  },
  {
    id: "personal.card",
    family: "personal",
    strict: "reject",
    moderate: "reject",
    hint: "Numéro de carte bancaire : à ne jamais partager.",
    find: (t) =>
      all(/\b(?:\d[ -]?){13,19}\b/, t, (m) => {
        const d = m[0].replace(/\D/g, "");
        return d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d);
      }),
  },
  {
    id: "personal.ssn-fr",
    family: "personal",
    strict: "reject",
    moderate: "reject",
    hint: "Numéro de sécurité sociale : à ne jamais partager.",
    find: (t) => all(/\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2]|20)\s?(?:\d{2}|2A|2B)\s?\d{3}\s?\d{3}\s?\d{2}\b/, t),
  },
  {
    id: "personal.profile-url",
    family: "personal",
    strict: "review",
    moderate: "ignore",
    hint: "Lien vers le profil d'une personne : retire-le, décris la méthode sans nommer les gens.",
    find: (t) => all(/\b(?:linkedin\.com\/in\/|facebook\.com\/|instagram\.com\/|x\.com\/|twitter\.com\/)[A-Za-z0-9_.-]{3,}/, t, (m) => !/\/(?:in\/)?(?:username|nom|pseudo|<)/i.test(m[0])),
  },
  {
    id: "personal.address",
    family: "personal",
    strict: "review",
    moderate: "ignore",
    hint: "Adresse postale : retire-la.",
    find: (t) => all(/\b\d{1,4}(?:\s?(?:bis|ter))?,?\s+(?:rue|avenue|av\.|boulevard|bd|chemin|allée|impasse|place|route|quai)\s+[^\n,;]{3,40}/i, t),
  },

  // ---- contexte privé
  {
    id: "context.home-path",
    family: "context",
    strict: "reject",
    moderate: "review",
    hint: "Chemin personnel : remplace par ~ ou par un chemin générique.",
    find: (t) => all(/(?:\/Users\/|\/home\/|C:\\Users\\)([A-Za-z0-9._-]+)/, t, (m) => !GENERIC_USER.test(m[1])),
  },
  {
    id: "context.env-block",
    family: "context",
    strict: "reject",
    moderate: "review",
    hint: "Bloc de variables d'environnement avec des valeurs : garde les noms, retire les valeurs.",
    find: (t) => {
      const lines = t.split("\n");
      let run = 0;
      let start = 0;
      let offset = 0;
      const hits: { index: number; length: number }[] = [];
      for (const line of lines) {
        const m = /^\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*["']?([^\s"']{3,})/.exec(line);
        if (m && !PLACEHOLDER.test(m[1])) {
          if (run === 0) start = offset;
          run++;
        } else {
          if (run >= 3) hits.push({ index: start, length: offset - start });
          run = 0;
        }
        offset += line.length + 1;
      }
      if (run >= 3) hits.push({ index: start, length: offset - start });
      return hits;
    },
  },
  {
    id: "context.transcript",
    family: "context",
    strict: "reject",
    moderate: "review",
    hint: "Conversation collée : extrais la méthode, ne colle pas l'échange.",
    find: (t) => {
      const hits = all(/^(?:User|Assistant|Human|AI|Utilisateur|Claude|Moi|Agent)\s*:/im, t);
      return hits.length >= 3 ? [hits[0]] : [];
    },
  },
  {
    id: "context.private-network",
    family: "context",
    strict: "review",
    moderate: "ignore",
    hint: "Adresse réseau interne : remplace par un exemple générique.",
    find: (t) => all(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b|https?:\/\/[a-z0-9.-]+\.(?:internal|local|corp|intra|lan)\b/i, t),
  },
  {
    id: "context.blob",
    family: "context",
    strict: "reject",
    moderate: "reject",
    hint: "Bloc encodé illisible : on ne peut pas vérifier ce qu'il contient, retire-le.",
    find: (t) => all(/[A-Za-z0-9+/]{200,}={0,2}/, t),
  },

  // ---- instructions dangereuses pour l'agent qui lira : relecture humaine
  {
    id: "injection.override",
    family: "injection",
    strict: "review",
    moderate: "review",
    hint: "Instruction qui cherche à détourner l'agent lecteur : signalée pour relecture.",
    find: (t) => all(/ignore\s+(?:all\s+|toutes?\s+|les\s+)?(?:previous|prior|above|précédentes?|antérieures?)\s+(?:instructions|consignes)|you are now\b|tu es (?:désormais|maintenant) (?:un|une)\b|system prompt|nouvelles? instructions? syst[èe]me/i, t),
  },
  {
    id: "injection.hide",
    family: "injection",
    strict: "review",
    moderate: "review",
    hint: "Demande de cacher quelque chose à l'humain : signalée pour relecture.",
    find: (t) => all(/(?:do not|don't|never|ne|jamais)\s+(?:tell|mention|reveal|dis|parle|mentionne|révèle)[^.\n]{0,30}(?:user|utilisateur|humain|human)/i, t),
  },
  {
    id: "injection.exfil",
    family: "injection",
    strict: "review",
    moderate: "review",
    hint: "Envoi de données vers une adresse externe : signalé pour relecture.",
    find: (t) => all(/\b(?:send|envoie|envoyer|post|transmets?|exfiltr\w*|upload)\b[^.\n]{0,60}https?:\/\//i, t),
  },
  {
    id: "injection.remote-exec",
    family: "injection",
    strict: "review",
    moderate: "review",
    hint: "Téléchargement et exécution de code distant, ou commande destructrice : signalé pour relecture.",
    find: (t) => all(/(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b|Invoke-Expression|\biex\s*\(|\brm\s+-rf\s+[~\/]/i, t),
  },
];

// ------------------------------------------------------------------ scan

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function mask(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= 6) return flat.slice(0, 2) + "…";
  return `${flat.slice(0, 4)}…${flat.slice(-2)} (${flat.length} car.)`;
}

export function scan(text: string, level: ScanLevel = "strict", field?: string): ScanResult {
  const findings: Finding[] = [];
  if (!text) return { verdict: "ok", findings };
  for (const rule of RULES) {
    const severity = rule[level];
    if (severity === "ignore") continue;
    let hits: { index: number; length: number }[];
    try {
      hits = rule.find(text);
    } catch {
      hits = [];
    }
    for (const h of hits.slice(0, 5)) {
      findings.push({
        rule: rule.id,
        family: rule.family,
        severity,
        field,
        line: lineOf(text, h.index),
        excerpt: mask(text.slice(h.index, h.index + h.length)),
        hint: rule.hint,
      });
    }
  }
  const verdict: Verdict = findings.some((f) => f.severity === "reject") ? "reject" : findings.length ? "review" : "ok";
  return { verdict, findings };
}

/** Scanne plusieurs champs d'un même objet (skill, demande…) et fusionne. */
export function scanFields(fields: Record<string, string | undefined | null>, level: ScanLevel = "strict"): ScanResult {
  const findings: Finding[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    findings.push(...scan(value, level, field).findings);
  }
  const verdict: Verdict = findings.some((f) => f.severity === "reject") ? "reject" : findings.length ? "review" : "ok";
  return { verdict, findings };
}

/** Message lisible pour un agent : ce qui bloque, où, et comment corriger. */
export function formatFindings(result: ScanResult): string {
  if (result.findings.length === 0) return "Rien à signaler.";
  const head =
    result.verdict === "reject"
      ? `Publication refusée : ${result.findings.length} problème·s. Une méthode se partage, un contexte jamais.`
      : `Publication mise en relecture : ${result.findings.length} point·s à vérifier par un humain avant d'être visible.`;
  const lines = result.findings.map(
    (f, i) => `${i + 1}) [${f.severity === "reject" ? "refus" : "relecture"}] ${f.rule}${f.field ? ` dans « ${f.field} »` : ""}, ligne ${f.line} : « ${f.excerpt} ». ${f.hint}`,
  );
  return `${head}\n${lines.join("\n")}`;
}

export const FILTER_RULE_IDS = RULES.map((r) => r.id);
