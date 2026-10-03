import path from "path"

/**
 * How dangerous a shell command is, decided by software and not by the model.
 *
 * - safe: everyday development (install, build, test, git status/commit, dev
 *   servers, deleting inside the project). Follows the normal permission rules.
 * - confirm: can destroy work or reach outside the project (git push, history
 *   rewrites, publishing, recursive deletes outside the project, killing
 *   processes by name, registry writes, shutdown). Always asks the person, in
 *   every permission mode, unless they approved that exact command "always".
 * - blocked: can damage the system (formatting disks, deleting system or home
 *   folders, disabling the antivirus or firewall, boot and machine-wide policy
 *   changes). Never runs; the person can still run it themselves.
 *
 * Only clear cases are listed: a false "confirm" interrupts autonomous work,
 * which is what the person complained about before.
 */

export type Level = "safe" | "confirm" | "blocked"

export interface Risk {
  level: Level
  /** What makes it risky, in Portuguese, for the person and the model. */
  reason?: string
}

export interface Command {
  /** Lowercased command name without directory or .exe. */
  name: string
  /** Arguments as written, quotes removed. */
  args: string[]
  /** Absolute paths a delete command would remove (globs resolved to their folder). */
  targets: string[]
}

export interface Context {
  /** The whole command line as the model wrote it. */
  text: string
  commands: Command[]
  /** Folders the agent may work in (project directory and worktree). */
  workspace: string[]
  home: string
  platform: NodeJS.Platform
}

export const DELETE = new Set(["rm", "rmdir", "rd", "del", "erase", "remove-item", "ri", "unlink", "shred"])

function normalize(file: string, platform: NodeJS.Platform) {
  const resolved = platform === "win32" ? path.win32.normalize(file).toLowerCase() : path.posix.normalize(file)
  return resolved.replace(/[\\/]+$/, "") || (platform === "win32" ? resolved : "/")
}

function inside(parent: string, child: string, platform: NodeJS.Platform) {
  const sep = platform === "win32" ? "\\" : "/"
  const a = normalize(parent, platform)
  const b = normalize(child, platform)
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep)
}

/** Folders whose deletion breaks the machine or the person's account. */
function systemFolder(target: string, home: string, platform: NodeJS.Platform) {
  const t = normalize(target, platform)
  if (platform === "win32") {
    if (/^[a-z]:$/.test(t) || /^[a-z]:\\$/.test(t)) return true
    const roots = ["c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata", "c:\\users", "c:\\boot"]
    if (roots.some((root) => t === root || inside(root, t, platform)) && !inside(home, t, platform)) return true
  } else {
    const roots = ["/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/opt", "/proc", "/sbin", "/sys", "/usr", "/var", "/home", "/root", "/System", "/Library", "/Applications", "/Users"]
    if (roots.includes(t)) return true
    if (["/bin", "/boot", "/etc", "/lib", "/sbin", "/usr", "/System"].some((root) => inside(root, t, platform))) return true
  }
  // The home folder itself, or a top-level folder of it (Documents, Desktop, .ssh…).
  const h = normalize(home, platform)
  if (t === h) return true
  return path.dirname(t) === h && !t.endsWith("node_modules")
}

const has = (args: string[], ...flags: string[]) =>
  args.some((arg) => flags.some((flag) => arg.toLowerCase() === flag.toLowerCase()))
const hasPrefix = (args: string[], ...flags: string[]) =>
  args.some((arg) => flags.some((flag) => arg.toLowerCase().startsWith(flag.toLowerCase())))

/** Recursive or forced delete flags in bash, PowerShell and cmd. */
function recursive(command: Command) {
  if (command.name === "rm") return command.args.some((arg) => /^-[a-z]*[rR]/.test(arg) || arg === "--recursive")
  if (command.name === "remove-item" || command.name === "ri") return hasPrefix(command.args, "-r")
  if (["rd", "rmdir", "del", "erase"].includes(command.name)) return has(command.args, "/s", "-r", "-rf", "--recursive")
  return command.name === "shred"
}

function one(command: Command, context: Context): Risk {
  const { name, args } = command
  const lower = args.map((arg) => arg.toLowerCase())
  const joined = lower.join(" ")

  // --- disks and boot
  if (["format", "diskpart", "fdisk", "sfdisk", "parted", "wipefs", "bcdedit", "bootrec", "format-volume", "clear-disk", "initialize-disk", "remove-partition"].includes(name) || name.startsWith("mkfs"))
    return { level: "blocked", reason: "formata, particiona ou mexe na inicialização do disco" }
  if (name === "dd" && lower.some((arg) => /^of=\/dev\//.test(arg)))
    return { level: "blocked", reason: "grava direto num disco" }
  if (name === "cipher" && hasPrefix(lower, "/w")) return { level: "blocked", reason: "apaga o espaço livre do disco" }
  if (name === "vssadmin" && lower.includes("delete")) return { level: "blocked", reason: "apaga os pontos de restauração do Windows" }
  if (name === "wbadmin" && lower.includes("delete")) return { level: "blocked", reason: "apaga backups do Windows" }

  // --- antivirus and firewall
  if (name === "set-mppreference" && hasPrefix(lower, "-disable"))
    return { level: "blocked", reason: "desativa proteções do Windows Defender" }
  if (name === "add-mppreference" && hasPrefix(lower, "-exclusion"))
    return { level: "blocked", reason: "cria exceção no antivírus" }
  if ((name === "sc" || name === "sc.exe") && /windefend|wscsvc|mpssvc/.test(joined) && /stop|config|delete/.test(joined))
    return { level: "blocked", reason: "para ou altera o antivírus ou o firewall" }
  if ((name === "stop-service" || name === "set-service") && /windefend|wscsvc|mpssvc/.test(joined))
    return { level: "blocked", reason: "para ou altera o antivírus ou o firewall" }
  if (name === "netsh" && /firewall/.test(joined) && /state\s+off|disable/.test(joined))
    return { level: "blocked", reason: "desliga o firewall" }
  if (name === "set-netfirewallprofile" && /-enabled\s+(false|0|\$false)/.test(joined))
    return { level: "blocked", reason: "desliga o firewall" }

  // --- machine-wide registry and policies
  if (name === "reg" && /^(add|delete|import|restore|load)$/.test(lower[0] ?? "")) {
    if (/^(hklm|hkey_local_machine|hku|hkey_users|hkcr|hkey_classes_root)/.test(lower[1] ?? ""))
      return { level: "blocked", reason: "altera o registro do Windows para a máquina inteira" }
    return { level: "confirm", reason: "altera o registro do Windows" }
  }
  if (["set-itemproperty", "new-itemproperty", "remove-itemproperty", "remove-item", "new-item"].includes(name)) {
    if (/hklm:|hkey_local_machine|registry::hkey_local_machine/.test(joined))
      return { level: "blocked", reason: "altera o registro do Windows para a máquina inteira" }
    if (/hkcu:|hkey_current_user/.test(joined)) return { level: "confirm", reason: "altera o registro do Windows" }
  }
  if (name === "takeown" || ((name === "icacls" || name === "cacls") && /c:\\windows|c:\\program files/.test(joined)))
    return { level: "blocked", reason: "muda o dono ou as permissões de arquivos do sistema" }
  if (name === "set-executionpolicy") {
    if (/localmachine/.test(joined)) return { level: "blocked", reason: "muda a política de scripts da máquina inteira" }
    return { level: "confirm", reason: "muda a política de execução de scripts" }
  }
  if ((name === "chmod" || name === "chown") && has(lower, "-r", "--recursive") && command.targets.some((t) => systemFolder(t, context.home, context.platform)))
    return { level: "blocked", reason: "muda permissões de pastas do sistema" }

  // --- deletes
  if (DELETE.has(name) && command.targets.length) {
    // The project itself often sits right in the home folder (C:\Users\ana\site):
    // deleting it is a question, not a system accident.
    const project = (target: string) =>
      context.workspace.some((dir) => normalize(dir, context.platform) === normalize(target, context.platform)) &&
      normalize(target, context.platform) !== normalize(context.home, context.platform) &&
      path.dirname(normalize(target, context.platform)) !== normalize(target, context.platform)
    const system = command.targets.find(
      (target) => !project(target) && systemFolder(target, context.home, context.platform),
    )
    if (system) return { level: "blocked", reason: `apaga uma pasta do sistema ou da sua conta (${system})` }
    const outside = command.targets.find(
      (target) => !context.workspace.some((dir) => inside(dir, target, context.platform)),
    )
    if (outside && recursive(command)) return { level: "confirm", reason: `apaga pastas fora do projeto (${outside})` }
    const root = command.targets.find((target) => context.workspace.some((dir) => normalize(dir, context.platform) === normalize(target, context.platform)))
    if (root && recursive(command)) return { level: "confirm", reason: "apaga o projeto inteiro" }
  }

  // --- git: what loses work or leaves this machine
  if (name === "git") {
    const sub = lower.find((arg) => !arg.startsWith("-"))
    if (sub === "push") return { level: "confirm", reason: "envia commits para o servidor (push)" }
    if (sub === "reset" && has(lower, "--hard")) return { level: "confirm", reason: "descarta alterações (reset --hard)" }
    if (sub === "clean" && lower.some((arg) => /^-[a-z]*f/.test(arg))) return { level: "confirm", reason: "apaga arquivos não versionados (clean)" }
    if ((sub === "checkout" || sub === "restore") && (lower.includes(".") || lower.includes("--")) && !has(lower, "-b", "--staged"))
      return { level: "confirm", reason: "descarta alterações não salvas" }
    // -d only deletes merged branches; -D (case matters) or --force loses commits.
    if (sub === "branch" && (args.includes("-D") || (has(lower, "-d", "--delete") && has(lower, "--force", "-f"))))
      return { level: "confirm", reason: "apaga um branch à força" }
    if (sub === "stash" && (lower.includes("drop") || lower.includes("clear"))) return { level: "confirm", reason: "apaga alterações guardadas (stash)" }
    if (sub === "filter-branch" || sub === "filter-repo") return { level: "confirm", reason: "reescreve o histórico" }
    if (sub === "rebase" || (sub === "commit" && has(lower, "--amend"))) return { level: "confirm", reason: "reescreve o histórico" }
  }
  if (name === "gh" && /^(repo delete|release (create|delete|upload)|pr merge|secret|api)/.test(joined))
    return { level: "confirm", reason: "age no GitHub em seu nome" }

  // --- publishing and remote effects
  if (["npm", "pnpm", "yarn", "bun"].includes(name) && /^(publish|unpublish|deprecate)\b/.test(lower[0] ?? ""))
    return { level: "confirm", reason: "publica um pacote" }
  if (name === "twine" && lower[0] === "upload") return { level: "confirm", reason: "publica um pacote" }
  if (name === "docker" && /system prune|volume (rm|prune)|image prune -a/.test(joined))
    return { level: "confirm", reason: "apaga dados do Docker" }

  // --- processes and the machine
  if (["shutdown", "stop-computer", "restart-computer", "reboot", "poweroff", "halt", "logoff"].includes(name))
    return { level: "confirm", reason: "desliga, reinicia ou sai da sessão" }
  if ((name === "taskkill" && has(lower, "/im")) || ["killall", "pkill"].includes(name) || (name === "stop-process" && has(lower, "-name", "-processname")))
    return { level: "confirm", reason: "encerra programas pelo nome (pode fechar o próprio app)" }
  if (name === "sudo" || name === "runas") return { level: "confirm", reason: "roda como administrador" }
  if (name === "net" && lower[0] === "user" && (has(lower, "/add") || has(lower, "/delete")))
    return { level: "confirm", reason: "cria ou apaga usuário do Windows" }

  return { level: "safe" }
}

const ORDER: Record<Level, number> = { safe: 0, confirm: 1, blocked: 2 }

export function classify(context: Context): Risk {
  const text = context.text.toLowerCase()
  const found: (Risk | undefined)[] = [
    // A fork bomb.
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(text) ? { level: "blocked", reason: "trava o computador (fork bomb)" } : undefined,
    // Running a script straight from the internet.
    /(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|]*\|\s*(sh|bash|zsh|iex|invoke-expression|python|node)\b/.test(text) ||
    /\b(iex|invoke-expression)\s*\(?\s*\(?\s*(iwr|irm|invoke-webrequest|invoke-restmethod|new-object\s+net\.webclient)/.test(text)
      ? { level: "confirm", reason: "baixa e executa um script da internet" }
      : undefined,
    /\bdrop\s+(database|schema|table)\b/.test(text) ? { level: "confirm", reason: "apaga dados de um banco (DROP)" } : undefined,
  ]
  const whole = found.filter((risk): risk is Risk => risk !== undefined)
  return [...whole, ...context.commands.map((command) => one(command, context))].reduce<Risk>(
    (worst, risk) => (ORDER[risk.level] > ORDER[worst.level] ? risk : worst),
    { level: "safe" },
  )
}

export * as CommandRisk from "./command-risk"
