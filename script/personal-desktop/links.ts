#!/usr/bin/env bun
/**
 * Replaces the repository's symbolic links that Git checked out as text files
 * with copies of what they point at (see materializeLinks in shared.ts). Run
 * by instalar.ps1 on a PC without Developer Mode; harmless where the links are
 * real.
 *
 *   bun script/personal-desktop/links.ts
 */
import { materializeLinks } from "./shared"

const copied = await materializeLinks()
console.log(copied ? `${copied} links do repositório viraram cópias dos arquivos.` : "Links do repositório já estão certos.")
