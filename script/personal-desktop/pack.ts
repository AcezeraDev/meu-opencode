/**
 * The file that carries OpenCode Personal's settings from one PC to another.
 *
 * It holds API keys and sign-ins, and the repository it travels next to is
 * public, so it is encrypted with a password of the person's own choosing:
 * AES-256-GCM, with the key stretched out of the password by scrypt. GCM also
 * authenticates it, so a wrong password or a damaged file is refused outright
 * instead of restoring garbage.
 *
 * Inside, after decryption and gunzip, it is a flat list of files, each as a
 * length-prefixed name followed by a length-prefixed body. Names are logical
 * paths (`config/...`, `data/...`, `app/...`, see export.ts), so the file never
 * depends on where things live on the PC that made it.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"

const MAGIC = Buffer.from("OCPACK01")
const SALT = 16
const IV = 12
const TAG = 16
/** Slow enough that guessing passwords against a stolen file is expensive, quick enough to wait for once. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const MIN_PASSWORD = 8

export type Entry = { name: string; data: Buffer }

function key(password: string, salt: Buffer) {
  return scryptSync(password.normalize("NFC"), salt, 32, SCRYPT)
}

export function seal(entries: Entry[], password: string) {
  if (password.length < MIN_PASSWORD) throw new Error(`A senha precisa de pelo menos ${MIN_PASSWORD} caracteres.`)
  const parts: Buffer[] = []
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const head = Buffer.alloc(12)
    head.writeUInt32LE(name.length, 0)
    head.writeBigUInt64LE(BigInt(entry.data.length), 4)
    parts.push(head.subarray(0, 4), name, head.subarray(4), entry.data)
  }
  const plain = gzipSync(Buffer.concat(parts), { level: 9 })
  const salt = randomBytes(SALT)
  const iv = randomBytes(IV)
  const cipher = createCipheriv("aes-256-gcm", key(password, salt), iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body])
}

export function open(file: Buffer, password: string): Entry[] {
  if (file.length < MAGIC.length + SALT + IV + TAG || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Este arquivo não é um pacote de configurações do OpenCode Personal.")
  }
  let offset = MAGIC.length
  const salt = file.subarray(offset, (offset += SALT))
  const iv = file.subarray(offset, (offset += IV))
  const tag = file.subarray(offset, (offset += TAG))
  const decipher = createDecipheriv("aes-256-gcm", key(password, salt), iv)
  decipher.setAuthTag(tag)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(file.subarray(offset)), decipher.final()])
  } catch {
    throw new Error("Senha errada, ou o arquivo foi danificado no caminho.")
  }
  const archive = gunzipSync(plain)
  const entries: Entry[] = []
  let at = 0
  while (at < archive.length) {
    const nameLength = archive.readUInt32LE(at)
    at += 4
    const name = archive.subarray(at, at + nameLength).toString("utf8")
    at += nameLength
    const size = Number(archive.readBigUInt64LE(at))
    at += 8
    entries.push({ name, data: Buffer.from(archive.subarray(at, at + size)) })
    at += size
  }
  return entries
}
